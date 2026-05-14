"""
Smoke tests for the Python SDK. Uses ``unittest`` (stdlib only) so the
test suite has zero install footprint.

Each test isolates ``$SPOOL_HOME`` to a tempdir so it never touches the
real ``~/.spool`` store.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

# Make the package importable without an install step.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from spool_agent import (  # noqa: E402
    SpoolTracer,
    message_action,
    tool_call_action,
    trace_anthropic,
)
from spool_agent.hashing import canonical_json, hash_json  # noqa: E402
from spool_agent.pricing import cost_cents  # noqa: E402
from spool_agent.redact import redact_string  # noqa: E402


class IsolatedSpoolHome(unittest.TestCase):
    """Mixin: redirect SPOOL_HOME for the duration of each test."""

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

    def _db(self) -> sqlite3.Connection:
        return sqlite3.connect(str(Path(self._tmp.name) / "spool.db"))


class TestHashing(unittest.TestCase):
    def test_canonical_json_sorts_keys(self) -> None:
        # Must match the TS canonicalJson byte-for-byte so Python and TS
        # writes of the same logical value content-address to the same hash.
        v = {"b": 1, "a": {"y": 2, "x": 1}}
        out = canonical_json(v)
        self.assertEqual(out, '{"a":{"x":1,"y":2},"b":1}')

    def test_hash_json_stable(self) -> None:
        a = hash_json({"a": 1, "b": 2})
        b = hash_json({"b": 2, "a": 1})
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)


class TestRedact(unittest.TestCase):
    def test_redacts_anthropic_key(self) -> None:
        sample = "key=sk-ant-" + ("A" * 30)
        out, counts = redact_string(sample)
        self.assertIn("«spool:redacted:anthropic-key»", out)
        self.assertEqual(counts, [("anthropic-key", 1)])

    def test_redact_off_passes_through(self) -> None:
        os.environ["SPOOL_REDACT"] = "off"
        try:
            sample = "sk-ant-" + ("A" * 30)
            out, counts = redact_string(sample)
            self.assertEqual(out, sample)
            self.assertEqual(counts, [])
        finally:
            os.environ.pop("SPOOL_REDACT", None)


class TestPricing(unittest.TestCase):
    def test_opus_5m_cache_is_1_25x_input(self) -> None:
        # 1M cache_creation tokens (5m) — 1500 * 1.25 = 1875 cents.
        cost, approx = cost_cents(
            "claude-opus-4-7", {"input": 0, "output": 0, "cached_read": 0, "cache_creation": 1_000_000}
        )
        self.assertAlmostEqual(cost, 1875.0, places=2)
        self.assertFalse(approx)

    def test_opus_1h_cache_is_2x_input(self) -> None:
        cost, _ = cost_cents(
            "claude-opus-4-7",
            {
                "input": 0,
                "output": 0,
                "cached_read": 0,
                "cache_creation": 0,
                "cache_creation_1h": 1_000_000,
            },
        )
        self.assertAlmostEqual(cost, 3000.0, places=2)

    def test_unknown_model_flagged_approx(self) -> None:
        _, approx = cost_cents("not-a-real-model", {"input": 0, "output": 0, "cached_read": 0, "cache_creation": 0})
        self.assertTrue(approx)


class TestTracerEndToEnd(IsolatedSpoolHome):
    def test_one_step_run_lands_in_sqlite(self) -> None:
        tracer = SpoolTracer(project="test-app", agent="unit-test")
        run_id = tracer.run_id
        step = tracer.start_step(
            model="claude-opus-4-7",
            system_prompt="you are helpful",
            history=[{"role": "user", "content": "hello"}],
        )
        step.record_message("hi back").record_outcome({"status": "ok"}).record_tokens(
            input=10, output=2, cached_read=0, cache_creation=0
        )
        step.end()
        tracer.end()

        with self._db() as db:
            run = db.execute(
                "SELECT run_id, status, step_count, source_runtime FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            self.assertIsNotNone(run)
            self.assertEqual(run[0], run_id)
            self.assertEqual(run[1], "ok")
            self.assertEqual(run[2], 1)
            self.assertEqual(run[3], "sdk-py")

            steps = db.execute(
                "SELECT model, action_json, status, tokens_input, tokens_output, cost_cents "
                "FROM steps WHERE run_id = ? ORDER BY sequence",
                (run_id,),
            ).fetchall()
            self.assertEqual(len(steps), 1)
            (model, action_json, status, t_in, t_out, cost) = steps[0]
            self.assertEqual(model, "claude-opus-4-7")
            action = json.loads(action_json)
            self.assertEqual(action["kind"], "message")
            self.assertEqual(action["text"], "hi back")
            self.assertEqual(status, "ok")
            self.assertEqual(t_in, 10)
            self.assertEqual(t_out, 2)
            self.assertGreater(cost, 0)

            snaps = db.execute(
                "SELECT component_count FROM context_snapshots"
            ).fetchall()
            self.assertEqual(len(snaps), 1)
            self.assertEqual(snaps[0][0], 2)  # system_prompt + history

    def test_tool_call_action_persists_input_blob(self) -> None:
        tracer = SpoolTracer(project="test-app", agent="unit-test")
        step = tracer.start_step(model="claude-opus-4-7")
        step.record_action(tool_call_action("Read", {"path": "/foo.py"}, "tool_use_1"))
        step.record_tool_result(
            {"text": "print('hi')\n"}, summary="read 1 line"
        )
        step.record_tokens(input=5, output=3, cached_read=0, cache_creation=0)
        step.end()
        tracer.end()

        with self._db() as db:
            row = db.execute(
                "SELECT action_json, outcome_json FROM steps WHERE run_id = ?",
                (tracer.run_id,),
            ).fetchone()
            self.assertIsNotNone(row)
            action = json.loads(row[0])
            outcome = json.loads(row[1])
            self.assertEqual(action["tool_name"], "Read")
            self.assertEqual(action["tool_input"], {"path": "/foo.py"})
            # tool_result_ref must be a sha256 blob hash, not the value itself.
            self.assertIn("tool_result_ref", outcome)
            self.assertEqual(len(outcome["tool_result_ref"]), 64)
            self.assertEqual(outcome["status"], "ok")

    def test_error_outcome_marks_run_error(self) -> None:
        tracer = SpoolTracer(project="test-app", agent="unit-test")
        step = tracer.start_step(model="claude-opus-4-7")
        step.record_message("oops")
        step.record_outcome(
            {"status": "error", "is_error": True, "summary": "boom"}
        )
        step.record_tokens(input=1, output=1, cached_read=0, cache_creation=0)
        step.end()
        tracer.end()

        with self._db() as db:
            row = db.execute(
                "SELECT status FROM runs WHERE run_id = ?", (tracer.run_id,)
            ).fetchone()
            self.assertEqual(row[0], "error")
            srow = db.execute(
                "SELECT status FROM steps WHERE run_id = ?", (tracer.run_id,)
            ).fetchone()
            self.assertEqual(srow[0], "error")

    def test_context_manager_seals_run_on_exception(self) -> None:
        with self.assertRaises(RuntimeError):
            with SpoolTracer(project="test-app", agent="unit-test") as tracer:
                step = tracer.start_step(model="claude-opus-4-7")
                step.record_message("partial").record_tokens(input=1, output=1)
                step.end()
                raise RuntimeError("simulated agent crash")
        run_id = tracer.run_id
        with self._db() as db:
            status = db.execute(
                "SELECT status FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            self.assertEqual(status, "error")

    def test_redaction_log_records_anthropic_key(self) -> None:
        tracer = SpoolTracer(project="test-app", agent="unit-test")
        leaked = "auth: sk-ant-" + ("Z" * 40)
        step = tracer.start_step(
            model="claude-opus-4-7",
            system_prompt=leaked,
        )
        step.record_message("ack")
        step.record_tokens(input=1, output=1)
        step.end()
        tracer.end()

        with self._db() as db:
            rule_counts = db.execute(
                "SELECT rule, count FROM redaction_log"
            ).fetchall()
            self.assertTrue(
                any(r[0] == "anthropic-key" and r[1] >= 1 for r in rule_counts),
                f"expected anthropic-key redaction, got {rule_counts}",
            )


class FakeAnthropicResponse:
    """Pydantic-lite stand-in for an Anthropic Message — duck-types attrs."""

    def __init__(
        self,
        *,
        content,
        model="claude-opus-4-7",
        input_tokens=10,
        output_tokens=4,
        cache_read_input_tokens=0,
        cache_creation_5m=0,
        cache_creation_1h=0,
    ) -> None:
        self.model = model
        self.content = content

        class _CC:
            def __init__(self, m, h):
                self.ephemeral_5m_input_tokens = m
                self.ephemeral_1h_input_tokens = h

        class _Usage:
            def __init__(self):
                self.input_tokens = input_tokens
                self.output_tokens = output_tokens
                self.cache_read_input_tokens = cache_read_input_tokens
                self.cache_creation = _CC(cache_creation_5m, cache_creation_1h)
                self.cache_creation_input_tokens = cache_creation_5m

        self.usage = _Usage()


class FakeAnthropicMessages:
    def __init__(self, responder):
        self._responder = responder

    def create(self, **req):
        return self._responder(req)


class FakeAnthropicClient:
    def __init__(self, responder):
        self.messages = FakeAnthropicMessages(responder)


class TestTraceAnthropic(IsolatedSpoolHome):
    def test_one_message_call_captures_one_step(self) -> None:
        def responder(req):
            return FakeAnthropicResponse(
                content=[{"type": "text", "text": "hello!"}],
                input_tokens=12,
                output_tokens=3,
            )

        tracer = SpoolTracer(project="test-app", agent="unit-test")
        traced = trace_anthropic(tracer, FakeAnthropicClient(responder))
        resp = traced.messages.create(
            model="claude-opus-4-7",
            max_tokens=128,
            system="you are helpful",
            messages=[{"role": "user", "content": "hi"}],
        )
        self.assertEqual(resp.content[0]["text"], "hello!")
        tracer.end()

        with self._db() as db:
            steps = db.execute(
                "SELECT model, action_json, tokens_input, tokens_output FROM steps WHERE run_id = ?",
                (tracer.run_id,),
            ).fetchall()
            self.assertEqual(len(steps), 1)
            self.assertEqual(steps[0][0], "claude-opus-4-7")
            action = json.loads(steps[0][1])
            self.assertEqual(action["kind"], "message")
            self.assertEqual(action["text"], "hello!")
            self.assertEqual(steps[0][2], 12)
            self.assertEqual(steps[0][3], 3)

    def test_tool_use_response_captures_tool_call_action(self) -> None:
        def responder(req):
            return FakeAnthropicResponse(
                content=[
                    {
                        "type": "tool_use",
                        "id": "tu_1",
                        "name": "search",
                        "input": {"q": "spool"},
                    }
                ],
                input_tokens=20,
                output_tokens=2,
            )

        tracer = SpoolTracer(project="test-app", agent="unit-test")
        traced = trace_anthropic(tracer, FakeAnthropicClient(responder))
        traced.messages.create(
            model="claude-opus-4-7",
            max_tokens=128,
            messages=[{"role": "user", "content": "find it"}],
        )
        tracer.end()

        with self._db() as db:
            row = db.execute(
                "SELECT action_json FROM steps WHERE run_id = ?",
                (tracer.run_id,),
            ).fetchone()
            action = json.loads(row[0])
            self.assertEqual(action["kind"], "tool_call")
            self.assertEqual(action["tool_name"], "search")
            self.assertEqual(action["tool_input"], {"q": "spool"})
            self.assertEqual(action["tool_use_id"], "tu_1")

    def test_exception_in_call_is_recorded_as_error(self) -> None:
        def responder(req):
            raise RuntimeError("upstream 500")

        tracer = SpoolTracer(project="test-app", agent="unit-test")
        traced = trace_anthropic(tracer, FakeAnthropicClient(responder))
        with self.assertRaises(RuntimeError):
            traced.messages.create(
                model="claude-opus-4-7",
                max_tokens=128,
                messages=[{"role": "user", "content": "x"}],
            )
        tracer.end()

        with self._db() as db:
            row = db.execute(
                "SELECT outcome_json, status FROM steps WHERE run_id = ?",
                (tracer.run_id,),
            ).fetchone()
            outcome = json.loads(row[0])
            self.assertEqual(outcome["status"], "error")
            self.assertEqual(row[1], "error")


if __name__ == "__main__":
    unittest.main()
