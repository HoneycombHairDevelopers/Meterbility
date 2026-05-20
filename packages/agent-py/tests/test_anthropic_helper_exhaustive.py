"""
Tier 14 — exhaustive coverage of ``spool_agent.anthropic_helper``
(``trace_anthropic`` + internal helpers).

Existing coverage:
  - ``test_sdk.py`` has 4 happy-path tests through trace_anthropic.
  - ``test_probe.py`` has 5 apply_probe_to_request tests and 6 probe
    integration tests through trace_anthropic.

This file fills the internals the existing tests don't pin: token
capture across the legacy + new SDK shapes (cache_creation breakdown),
history/system flattening edges (string vs list-of-blocks),
_action_from_response priority rules (tool_use vs text vs thinking_only),
error-path summary truncation, the pydantic-vs-dict response handling,
and the private helpers (_attr, _to_plain, _truncate).

Sections:
  1. Factory + proxy attribute pass-through (4 tests)
  2. Token capture matrix (6 tests)
  3. History + system flattening (5 tests)
  4. _action_from_response priority + edge cases (5 tests)
  5. Error path (3 tests)
  6. Probe integration edges via custom ProbeRuntime (3 tests)
  7. Private helpers — _attr, _to_plain, _truncate (5 tests)

Pure stdlib unittest. No real anthropic client; we use a minimal
FakeAnthropic where shape matters, and call the response-parsing
helpers directly otherwise.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from spool_agent import SpoolTracer, trace_anthropic  # noqa: E402
from spool_agent.anthropic_helper import (  # noqa: E402
    _action_from_response,
    _attr,
    _flatten_history,
    _flatten_system,
    _to_plain,
    _tokens_from_response,
    _truncate,
)
from spool_agent.probe_hook import ProbeRuntime  # noqa: E402


# ─── Fixtures ──────────────────────────────────────────────────────


class IsolatedSpoolHome(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_home = os.environ.get("SPOOL_HOME")
        os.environ["SPOOL_HOME"] = self._tmp.name

    def tearDown(self) -> None:
        if self._prev_home is None:
            os.environ.pop("SPOOL_HOME", None)
        else:
            os.environ["SPOOL_HOME"] = self._prev_home
        self._tmp.cleanup()

    def _tracer(self, **kwargs: Any) -> SpoolTracer:
        defaults: Dict[str, Any] = {
            "project": "/tmp/anth-exh",
            "agent": "tester",
        }
        defaults.update(kwargs)
        return SpoolTracer(**defaults)

    def _db(self) -> sqlite3.Connection:
        return sqlite3.connect(str(Path(self._tmp.name) / "spool.db"))


class FakeMessages:
    """Stand-in for Anthropic.messages with a configurable response."""

    def __init__(self, response: Any = None) -> None:
        self.last_req: Dict[str, Any] = {}
        self.calls: int = 0
        self._response = response or {
            "model": "claude-opus-4-7",
            "content": [{"type": "text", "text": "ok"}],
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        }
        self.beta = "passthrough-beta"

    def create(self, **req: Any) -> Any:
        self.last_req = dict(req)
        self.calls += 1
        return self._response


class FakeAnthropic:
    """Stand-in for anthropic.Anthropic with .messages + extra attrs."""

    def __init__(self, response: Any = None) -> None:
        self.messages = FakeMessages(response=response)
        self.beta = "passthrough-beta"
        self.completions = "passthrough-completions"


# ─────────────────────────────────────────────────────────────────────
# Section 1 — Factory + proxy attribute pass-through (4 tests)
# ─────────────────────────────────────────────────────────────────────


class TestProxyBehavior(IsolatedSpoolHome):
    def test_trace_anthropic_returns_proxy_with_messages_attribute(self) -> None:
        tracer = self._tracer()
        try:
            traced = trace_anthropic(tracer, FakeAnthropic())
            self.assertTrue(hasattr(traced, "messages"))
            self.assertTrue(hasattr(traced.messages, "create"))
        finally:
            tracer.end()

    def test_proxy_passes_through_non_messages_attributes(self) -> None:
        """Anthropic clients have .beta, .completions, etc. The proxy
        forwards via __getattr__ so wrapped clients are drop-in."""
        tracer = self._tracer()
        try:
            client = FakeAnthropic()
            traced = trace_anthropic(tracer, client)
            self.assertEqual(traced.beta, "passthrough-beta")
            self.assertEqual(traced.completions, "passthrough-completions")
        finally:
            tracer.end()

    def test_messages_proxy_passes_through_non_create_attributes(self) -> None:
        """The _TracedMessages proxy also forwards __getattr__ — e.g.
        a future SDK might add .messages.stream()."""
        tracer = self._tracer()
        try:
            traced = trace_anthropic(tracer, FakeAnthropic())
            self.assertEqual(traced.messages.beta, "passthrough-beta")
        finally:
            tracer.end()

    def test_proxy_does_not_share_state_across_tracers(self) -> None:
        """Two proxies for the same client write to two distinct runs."""
        tracer_a = self._tracer(agent="a")
        tracer_b = self._tracer(agent="b")
        try:
            client = FakeAnthropic()
            traced_a = trace_anthropic(tracer_a, client)
            traced_b = trace_anthropic(tracer_b, client)
            traced_a.messages.create(
                model="m", max_tokens=10, messages=[{"role": "user", "content": "a"}]
            )
            traced_b.messages.create(
                model="m", max_tokens=10, messages=[{"role": "user", "content": "b"}]
            )
            # Two runs in the DB, one step each.
            with self._db() as db:
                rows = db.execute(
                    "SELECT run_id, step_count FROM runs ORDER BY started_at"
                ).fetchall()
            self.assertEqual(len(rows), 2)
            # update_run_totals fires on each step end; both should be 1.
            self.assertTrue(all(r[1] == 1 for r in rows))
        finally:
            tracer_a.end()
            tracer_b.end()


# ─────────────────────────────────────────────────────────────────────
# Section 2 — Token capture matrix (6 tests)
# ─────────────────────────────────────────────────────────────────────


class TestTokenCapture(unittest.TestCase):
    """Test _tokens_from_response directly — no tracer fixture needed."""

    def test_basic_input_output_extracted(self) -> None:
        resp = {
            "usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            }
        }
        t = _tokens_from_response(resp)
        self.assertEqual(t["input"], 100)
        self.assertEqual(t["output"], 50)

    def test_cache_read_input_tokens_maps_to_cached_read(self) -> None:
        resp = {
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "cache_read_input_tokens": 999,
                "cache_creation_input_tokens": 0,
            }
        }
        t = _tokens_from_response(resp)
        self.assertEqual(t["cached_read"], 999)

    def test_new_sdk_cache_creation_breakdown_5m_and_1h(self) -> None:
        """When the SDK exposes cache_creation.ephemeral_{5m,1h}_input_tokens,
        we route them into cache_creation + cache_creation_1h respectively."""
        resp = {
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 10,
                    "ephemeral_1h_input_tokens": 5,
                },
            }
        }
        t = _tokens_from_response(resp)
        self.assertEqual(t["cache_creation"], 10, "5m bucket")
        self.assertEqual(t["cache_creation_1h"], 5, "1h bucket")

    def test_legacy_cache_creation_input_tokens_routes_to_5m_bucket(self) -> None:
        """Older SDKs only expose a single total. We bucket it as 5m to
        avoid silently undercharging long-cache sessions."""
        resp = {
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 25,
            }
        }
        t = _tokens_from_response(resp)
        self.assertEqual(t["cache_creation"], 25, "legacy total → 5m bucket")
        self.assertEqual(t["cache_creation_1h"], 0)

    def test_usage_none_returns_all_zeros(self) -> None:
        resp = {"usage": None}
        t = _tokens_from_response(resp)
        self.assertEqual(t, {"input": 0, "output": 0, "cached_read": 0, "cache_creation": 0})

    def test_missing_usage_attribute_returns_all_zeros(self) -> None:
        """Defensive: a response with no usage key at all returns zeros."""
        resp: Dict[str, Any] = {"content": [{"type": "text", "text": "x"}]}
        t = _tokens_from_response(resp)
        self.assertEqual(t["input"], 0)
        self.assertEqual(t["output"], 0)


# ─────────────────────────────────────────────────────────────────────
# Section 3 — History + system flattening (5 tests)
# ─────────────────────────────────────────────────────────────────────


class TestFlatten(unittest.TestCase):
    def test_history_string_content_passes_through(self) -> None:
        out = _flatten_history([{"role": "user", "content": "hello"}])
        self.assertEqual(out, [{"role": "user", "content": "hello"}])

    def test_history_list_of_blocks_extracts_text_blocks_only(self) -> None:
        """Non-text blocks (tool_use, image, etc.) are dropped from history."""
        msg = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "thinking..."},
                {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
                {"type": "text", "text": "now I'll call Read"},
            ],
        }
        out = _flatten_history([msg])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "assistant")
        self.assertEqual(out[0]["content"], "thinking...\nnow I'll call Read")

    def test_history_role_assistant_preserved_others_to_user(self) -> None:
        """Spool's data model is user/assistant/tool; Anthropic only ever
        sends user/assistant on input. Anything not 'assistant' maps to
        'user' defensively."""
        out = _flatten_history(
            [
                {"role": "assistant", "content": "a"},
                {"role": "user", "content": "u"},
                {"role": "system", "content": "s"},  # unusual but possible
            ]
        )
        self.assertEqual([m["role"] for m in out], ["assistant", "user", "user"])

    def test_system_string_passes_through(self) -> None:
        self.assertEqual(_flatten_system("you are helpful"), "you are helpful")

    def test_system_list_of_blocks_concatenates_text_blocks(self) -> None:
        sys_blocks = [
            {"type": "text", "text": "rule 1"},
            {"type": "text", "text": "rule 2"},
        ]
        out = _flatten_system(sys_blocks)
        self.assertEqual(out, "rule 1\nrule 2")


# ─────────────────────────────────────────────────────────────────────
# Section 4 — _action_from_response priority + edges (5 tests)
# ─────────────────────────────────────────────────────────────────────


class TestActionFromResponse(unittest.TestCase):
    def test_text_only_response_yields_message_action(self) -> None:
        resp = {"content": [{"type": "text", "text": "hello"}]}
        action, decision = _action_from_response(resp)
        self.assertEqual(action["kind"], "message")
        self.assertEqual(action["text"], "hello")
        self.assertEqual(len(decision), 1)

    def test_tool_use_in_response_yields_tool_call_action(self) -> None:
        resp = {
            "content": [
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "Read",
                    "input": {"path": "/x"},
                }
            ]
        }
        action, _ = _action_from_response(resp)
        self.assertEqual(action["kind"], "tool_call")
        self.assertEqual(action["tool_name"], "Read")
        self.assertEqual(action["tool_use_id"], "tu_1")
        self.assertEqual(action["tool_input"], {"path": "/x"})

    def test_tool_use_wins_over_concurrent_text(self) -> None:
        """When a response has BOTH a text block AND a tool_use block,
        tool_use wins. Pin this priority — otherwise an assistant that
        narrates ("I'll call Read") + actually calls Read would be
        captured as a 'message' action with the tool call lost."""
        resp = {
            "content": [
                {"type": "text", "text": "I'll call Read"},
                {"type": "tool_use", "id": "tu_1", "name": "Read", "input": {}},
            ]
        }
        action, _ = _action_from_response(resp)
        self.assertEqual(action["kind"], "tool_call")
        self.assertEqual(action["tool_name"], "Read")

    def test_empty_content_yields_thinking_only(self) -> None:
        """A response with no usable blocks → thinking_only action."""
        resp: Dict[str, Any] = {"content": []}
        action, _ = _action_from_response(resp)
        self.assertEqual(action["kind"], "thinking_only")

    def test_multiple_text_blocks_concatenated_with_newlines(self) -> None:
        resp = {
            "content": [
                {"type": "text", "text": "first"},
                {"type": "text", "text": "second"},
                {"type": "text", "text": "third"},
            ]
        }
        action, _ = _action_from_response(resp)
        self.assertEqual(action["kind"], "message")
        self.assertEqual(action["text"], "first\nsecond\nthird")


# ─────────────────────────────────────────────────────────────────────
# Section 5 — Error path (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestErrorPath(IsolatedSpoolHome):
    def test_exception_captures_error_outcome_and_re_raises(self) -> None:
        tracer = self._tracer()
        try:
            client = FakeAnthropic()

            def boom(**_: Any) -> Any:
                raise RuntimeError("upstream broke")

            client.messages.create = boom  # type: ignore[assignment]
            traced = trace_anthropic(tracer, client)
            with self.assertRaisesRegex(RuntimeError, "upstream broke"):
                traced.messages.create(
                    model="m",
                    max_tokens=10,
                    messages=[{"role": "user", "content": "x"}],
                )
        finally:
            tracer.end(status="error")
        with self._db() as db:
            row = db.execute(
                "SELECT status, outcome_json FROM steps"
            ).fetchone()
        self.assertEqual(row[0], "error")
        outcome = json.loads(row[1])
        self.assertEqual(outcome["status"], "error")
        self.assertTrue(outcome["is_error"])
        self.assertIn("upstream broke", outcome["summary"])

    def test_exception_summary_truncated_to_200_chars(self) -> None:
        """The wrapper truncates the exception message at 200 chars
        to keep the row compact + the UI scannable."""
        tracer = self._tracer()
        try:
            client = FakeAnthropic()
            long_msg = "ERR " + "x" * 500

            def boom(**_: Any) -> Any:
                raise RuntimeError(long_msg)

            client.messages.create = boom  # type: ignore[assignment]
            traced = trace_anthropic(tracer, client)
            with self.assertRaises(RuntimeError):
                traced.messages.create(
                    model="m",
                    max_tokens=10,
                    messages=[{"role": "user", "content": "x"}],
                )
        finally:
            tracer.end(status="error")
        with self._db() as db:
            outcome_json = db.execute(
                "SELECT outcome_json FROM steps"
            ).fetchone()[0]
        outcome = json.loads(outcome_json)
        self.assertEqual(len(outcome["summary"]), 200, "truncated to exactly 200")

    def test_exception_still_persists_step_row(self) -> None:
        """Even when the model call throws, the step row must land in
        the DB (no leak). Otherwise telemetry loses errored calls."""
        tracer = self._tracer()
        try:
            client = FakeAnthropic()

            def boom(**_: Any) -> Any:
                raise ValueError("oh no")

            client.messages.create = boom  # type: ignore[assignment]
            traced = trace_anthropic(tracer, client)
            with self.assertRaises(ValueError):
                traced.messages.create(
                    model="m",
                    max_tokens=10,
                    messages=[{"role": "user", "content": "x"}],
                )
        finally:
            tracer.end(status="error")
        with self._db() as db:
            count = db.execute("SELECT COUNT(*) FROM steps").fetchone()[0]
        self.assertEqual(count, 1, "step row persisted despite exception")


# ─────────────────────────────────────────────────────────────────────
# Section 6 — Probe integration edges via custom ProbeRuntime (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestProbeIntegrationEdges(IsolatedSpoolHome):
    def test_probe_disabled_skips_runtime_entirely(self) -> None:
        """Cost contract: probe_enabled=False (default) means
        apply_probe_to_request is NEVER called. We verify by injecting
        a sentinel runtime whose sleep would raise if invoked."""
        sleeps: List[int] = []

        def tracking_sleep(ms: int) -> None:
            sleeps.append(ms)

        tracer = self._tracer()
        # Override the default runtime — but probe_enabled stays False
        tracer.probe_runtime = ProbeRuntime(sleep=tracking_sleep)
        try:
            traced = trace_anthropic(tracer, FakeAnthropic())
            traced.messages.create(
                model="m",
                max_tokens=10,
                messages=[{"role": "user", "content": "x"}],
            )
        finally:
            tracer.end()
        self.assertEqual(
            sleeps,
            [],
            "no runtime.sleep call when probe is disabled",
        )

    def test_probe_enabled_no_activity_does_not_sleep(self) -> None:
        """probe_enabled=True but no pause queued → state is 'running'
        immediately, so the polling loop is skipped."""
        sleeps: List[int] = []

        def tracking_sleep(ms: int) -> None:
            sleeps.append(ms)

        tracer = self._tracer(probe_enabled=True)
        tracer.probe_runtime = ProbeRuntime(sleep=tracking_sleep)
        try:
            traced = trace_anthropic(tracer, FakeAnthropic())
            traced.messages.create(
                model="m",
                max_tokens=10,
                messages=[{"role": "user", "content": "x"}],
            )
        finally:
            tracer.end()
        self.assertEqual(
            sleeps,
            [],
            "no sleep call when state is 'running'",
        )

    def test_probe_enabled_with_queued_inject_appends_user_turn(self) -> None:
        """probe_enabled=True + an operator queued an inject → the next
        request's messages list gets the inject appended as a user turn.
        The captured Step's history reflects what the model actually saw."""
        from spool_agent.probe import set_inject

        tracer = self._tracer(probe_enabled=True)
        run_id = tracer.run_id
        try:
            set_inject(run_id, "actually wait — reconsider step 3")
            client = FakeAnthropic()
            traced = trace_anthropic(tracer, client)
            traced.messages.create(
                model="m",
                max_tokens=10,
                messages=[{"role": "user", "content": "original turn"}],
            )
            # The req the underlying client saw should have the inject appended.
            last = client.messages.last_req
            self.assertEqual(len(last["messages"]), 2)
            self.assertEqual(last["messages"][1]["role"], "user")
            self.assertIn("reconsider step 3", last["messages"][1]["content"])
        finally:
            tracer.end()


# ─────────────────────────────────────────────────────────────────────
# Section 7 — Private helpers (5 tests)
# ─────────────────────────────────────────────────────────────────────


class TestPrivateHelpers(unittest.TestCase):
    def test_attr_on_none_returns_none(self) -> None:
        self.assertIsNone(_attr(None, "anything"))

    def test_attr_works_for_dicts_and_objects(self) -> None:
        self.assertEqual(_attr({"x": 1}, "x"), 1)
        self.assertEqual(_attr({"x": 1}, "y"), None)

        class Obj:
            x = 1

        self.assertEqual(_attr(Obj(), "x"), 1)
        self.assertEqual(_attr(Obj(), "y"), None)

    def test_to_plain_uses_model_dump_when_available(self) -> None:
        """Newer pydantic models expose model_dump(); we prefer that."""

        class FakePydantic:
            def model_dump(self) -> Dict[str, Any]:
                return {"type": "text", "text": "from model_dump"}

        out = _to_plain(FakePydantic())
        self.assertEqual(out["text"], "from model_dump")

    def test_to_plain_falls_back_to_dict_method(self) -> None:
        """Pydantic v1 used .dict() — fall back if model_dump isn't there."""

        class V1Pydantic:
            def dict(self) -> Dict[str, Any]:
                return {"type": "text", "text": "from .dict()"}

        out = _to_plain(V1Pydantic())
        self.assertEqual(out["text"], "from .dict()")

    def test_truncate_returns_full_string_if_under_limit(self) -> None:
        self.assertEqual(_truncate("short", 200), "short")

    def test_truncate_cuts_at_exact_n_chars(self) -> None:
        s = "x" * 500
        out = _truncate(s, 200)
        self.assertEqual(len(out), 200)
        self.assertEqual(out, "x" * 200)


if __name__ == "__main__":
    unittest.main()
