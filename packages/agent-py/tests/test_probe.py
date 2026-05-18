"""
Probe protocol + SDK hook tests — Python mirror of
``packages/shared/src/probe.test.ts`` and
``packages/agent/src/probe.test.ts``.

Two layers:
  1. Pure protocol tests (state machine, idempotency, race defenses,
     corrupt-file degradation, path-traversal guard).
  2. SDK hook tests through ``trace_anthropic`` (probe-disabled is a
     no-op; probe-enabled with pause blocks; probe-enabled with inject
     appends a user turn; ``tracer.end()`` clears the file).

Uses ``unittest`` (stdlib) so the suite has zero install footprint.
Mirrors the existing ``tests/test_sdk.py`` style: each test isolates
``$SPOOL_HOME`` to a tempdir.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from spool_agent import (  # noqa: E402
    ProbeRuntime,
    SpoolTracer,
    apply_probe_to_request,
    clear_probe,
    confirm_paused,
    consume_inject,
    probe_file_path,
    read_state,
    request_pause,
    request_resume,
    set_inject,
    trace_anthropic,
)


class IsolatedSpoolHome(unittest.TestCase):
    """Each test gets its own SPOOL_HOME tempdir."""

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


def make_clock(start: int):
    """Deterministic counter — each call returns start, start+1, ..."""
    n = [start]

    def tick() -> int:
        v = n[0]
        n[0] += 1
        return v

    return tick


def sleep_that_triggers(action):
    """
    Sleep stub that performs ``action()`` once on first invocation.
    Stands in for "operator pressed Resume after SDK started polling."
    """
    fired = [False]

    def sleep(_ms: int) -> None:
        if not fired[0]:
            fired[0] = True
            action()

    return sleep


# ─── Protocol tests ──────────────────────────────────────────────────


class TestProbeProtocol(IsolatedSpoolHome):
    def test_read_state_on_no_file_returns_running_default(self) -> None:
        r = read_state("run_abc")
        self.assertEqual(r.state, "running")
        self.assertIsNone(r.inject)
        self.assertEqual(r.run_id, "run_abc")
        self.assertIsNone(r.requested_at_ms)
        self.assertIsNone(r.paused_at_ms)

    def test_request_pause_running_to_pause_requested(self) -> None:
        clock = make_clock(1000)
        r = request_pause("run_p", clock)
        self.assertEqual(r.state, "pause_requested")
        self.assertEqual(r.requested_at_ms, 1000)
        # Persisted:
        self.assertEqual(read_state("run_p").state, "pause_requested")

    def test_request_pause_idempotent_preserves_requested_at(self) -> None:
        clock = make_clock(1000)
        request_pause("run_p", clock)
        r2 = request_pause("run_p", clock)
        self.assertEqual(r2.state, "pause_requested")
        self.assertEqual(r2.requested_at_ms, 1000)

    def test_confirm_paused_transitions_and_preserves_requested_at(self) -> None:
        clock = make_clock(1000)
        request_pause("run_p", clock)  # 1000
        r = confirm_paused("run_p", clock)  # 1001
        self.assertEqual(r.state, "paused")
        self.assertEqual(r.paused_at_ms, 1001)
        self.assertEqual(r.requested_at_ms, 1000)

    def test_confirm_paused_no_op_when_not_pause_requested(self) -> None:
        # Operator never paused; SDK shouldn't flip to paused.
        r = confirm_paused("run_p")
        self.assertEqual(r.state, "running")
        self.assertIsNone(r.paused_at_ms)

    def test_set_inject_queues_message_in_any_state(self) -> None:
        set_inject("run_i", "hey, fixture is stale")
        r = read_state("run_i")
        self.assertEqual(r.inject, "hey, fixture is stale")
        self.assertEqual(r.state, "running")

    def test_set_inject_while_paused_preserves_state(self) -> None:
        request_pause("run_i")
        confirm_paused("run_i")
        set_inject("run_i", "reset fixtures first")
        r = read_state("run_i")
        self.assertEqual(r.state, "paused")
        self.assertEqual(r.inject, "reset fixtures first")

    def test_set_inject_overwrites(self) -> None:
        set_inject("run_i", "first")
        set_inject("run_i", "second")
        self.assertEqual(read_state("run_i").inject, "second")

    def test_consume_inject_returns_and_clears(self) -> None:
        set_inject("run_c", "delivered")
        taken = consume_inject("run_c")
        self.assertEqual(taken, "delivered")
        self.assertIsNone(read_state("run_c").inject)

    def test_consume_inject_returns_none_when_empty(self) -> None:
        self.assertIsNone(consume_inject("run_c"))
        self.assertIsNone(consume_inject("run_never_touched"))

    def test_consume_inject_preserves_pause_state(self) -> None:
        request_pause("run_c")
        confirm_paused("run_c")
        set_inject("run_c", "while paused")
        consume_inject("run_c")
        r = read_state("run_c")
        self.assertEqual(r.state, "paused")
        self.assertIsNone(r.inject)

    def test_request_resume_paused_to_running(self) -> None:
        clock = make_clock(1000)
        request_pause("run_r", clock)
        confirm_paused("run_r", clock)
        r = request_resume("run_r", clock)
        self.assertEqual(r.state, "running")
        self.assertEqual(r.resumed_at_ms, 1002)

    def test_request_resume_cancels_pause_request(self) -> None:
        request_pause("run_r")
        r = request_resume("run_r")
        self.assertEqual(r.state, "running")

    def test_request_resume_preserves_pending_inject(self) -> None:
        request_pause("run_r")
        confirm_paused("run_r")
        set_inject("run_r", "carry this forward")
        request_resume("run_r")
        r = read_state("run_r")
        self.assertEqual(r.state, "running")
        self.assertEqual(r.inject, "carry this forward")

    def test_clear_probe_removes_file(self) -> None:
        request_pause("run_clear")
        self.assertTrue(probe_file_path("run_clear").exists())
        clear_probe("run_clear")
        self.assertFalse(probe_file_path("run_clear").exists())
        # Subsequent reads return the default:
        self.assertEqual(read_state("run_clear").state, "running")

    def test_clear_probe_is_idempotent(self) -> None:
        # Should not raise even if no file exists.
        clear_probe("run_never_existed")

    def test_corrupt_file_collapses_to_running(self) -> None:
        request_pause("run_corrupt")
        path = probe_file_path("run_corrupt")
        path.write_text("{not json", encoding="utf-8")
        r = read_state("run_corrupt")
        self.assertEqual(r.state, "running")

    def test_unknown_state_string_collapses_to_running(self) -> None:
        request_pause("run_n")
        path = probe_file_path("run_n")
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["state"] = "marquee-mode-engaged"
        path.write_text(json.dumps(raw), encoding="utf-8")
        self.assertEqual(read_state("run_n").state, "running")

    def test_probe_file_path_url_encodes_run_id(self) -> None:
        # Defensive: a malformed run_id with traversal must not escape
        # the probe directory.
        path = str(probe_file_path("../../escape"))
        self.assertNotIn("/../", path)
        self.assertIn("%2F", path)

    def test_two_runs_dont_collide(self) -> None:
        request_pause("run_a")
        set_inject("run_b", "for b")
        a = read_state("run_a")
        b = read_state("run_b")
        self.assertEqual(a.state, "pause_requested")
        self.assertIsNone(a.inject)
        self.assertEqual(b.state, "running")
        self.assertEqual(b.inject, "for b")


# ─── Hook tests (pure) ───────────────────────────────────────────────


class TestProbeHook(IsolatedSpoolHome):
    def test_pass_through_when_no_probe_activity(self) -> None:
        req = {
            "model": "claude-opus-4-7",
            "messages": [{"role": "user", "content": "hello"}],
        }
        out = apply_probe_to_request("run_q", req)
        self.assertEqual(out, req)

    def test_blocks_until_resumed(self) -> None:
        run_id = "run_pause"
        request_pause(run_id)
        runtime = ProbeRuntime(
            poll_interval_ms=1,
            sleep=sleep_that_triggers(lambda: request_resume(run_id)),
            now=lambda: 1000,
        )
        req = {
            "model": "claude-opus-4-7",
            "messages": [{"role": "user", "content": "carry on"}],
        }
        apply_probe_to_request(run_id, req, runtime)

        final = read_state(run_id)
        self.assertEqual(final.state, "running")
        self.assertIsNotNone(final.paused_at_ms)
        self.assertIsNotNone(final.resumed_at_ms)

    def test_appends_inject_as_user_turn(self) -> None:
        set_inject("run_inject", "remember the stale fixture")
        req = {
            "model": "claude-opus-4-7",
            "messages": [{"role": "user", "content": "what next?"}],
        }
        out = apply_probe_to_request("run_inject", req)
        self.assertEqual(len(out["messages"]), 2)
        self.assertEqual(out["messages"][0]["content"], "what next?")
        self.assertEqual(out["messages"][1]["role"], "user")
        self.assertEqual(out["messages"][1]["content"], "remember the stale fixture")
        # Inject consumed:
        self.assertIsNone(read_state("run_inject").inject)

    def test_input_request_not_mutated(self) -> None:
        set_inject("run_imm", "extra context")
        req = {
            "model": "claude-opus-4-7",
            "messages": [{"role": "user", "content": "x"}],
        }
        before = json.dumps(req, sort_keys=True)
        out = apply_probe_to_request("run_imm", req)
        self.assertEqual(json.dumps(req, sort_keys=True), before)
        self.assertIsNot(out, req)
        self.assertEqual(len(out["messages"]), 2)

    def test_pause_plus_inject_flow(self) -> None:
        run_id = "run_both"
        request_pause(run_id)
        set_inject(run_id, "do this first")
        runtime = ProbeRuntime(
            poll_interval_ms=1,
            sleep=sleep_that_triggers(lambda: request_resume(run_id)),
            now=lambda: 1000,
        )
        req = {
            "model": "claude-opus-4-7",
            "messages": [{"role": "user", "content": "original"}],
        }
        out = apply_probe_to_request(run_id, req, runtime)
        self.assertEqual(len(out["messages"]), 2)
        self.assertEqual(out["messages"][1]["content"], "do this first")
        self.assertEqual(read_state(run_id).state, "running")


# ─── Integration through trace_anthropic ─────────────────────────────


class FakeAnthropic:
    """
    Minimal stand-in for ``anthropic.Anthropic``. Captures the request
    so tests can assert on what the wrapped messages.create() received.
    """

    class _Messages:
        def __init__(self) -> None:
            self.last_req = None

        def create(self, **req):
            self.last_req = req
            return {
                "model": req["model"],
                "content": [{"type": "text", "text": "ok"}],
                "usage": {
                    "input_tokens": 1,
                    "output_tokens": 1,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                },
            }

    def __init__(self) -> None:
        self.messages = FakeAnthropic._Messages()


class TestProbeIntegration(IsolatedSpoolHome):
    def test_probe_disabled_default_is_a_no_op(self) -> None:
        tracer = SpoolTracer(project="/tmp/p-off", agent="tester")
        # Stale inject set, but probe_enabled defaults to False:
        set_inject(tracer.run_id, "should be ignored")
        client = FakeAnthropic()
        traced = trace_anthropic(tracer, client)
        traced.messages.create(
            model="claude-opus-4-7",
            max_tokens=64,
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.end()

        self.assertEqual(
            len(client.messages.last_req["messages"]),
            1,
            "inject must NOT be appended when probe_enabled is False",
        )

    def test_probe_enabled_no_activity_is_no_op(self) -> None:
        tracer = SpoolTracer(
            project="/tmp/p-noop", agent="tester", probe_enabled=True
        )
        client = FakeAnthropic()
        traced = trace_anthropic(tracer, client)
        traced.messages.create(
            model="claude-opus-4-7",
            max_tokens=64,
            messages=[{"role": "user", "content": "untouched"}],
        )
        tracer.end()
        self.assertEqual(len(client.messages.last_req["messages"]), 1)
        self.assertEqual(client.messages.last_req["messages"][0]["content"], "untouched")

    def test_probe_enabled_pause_blocks_until_resume(self) -> None:
        tracer = SpoolTracer(
            project="/tmp/p-pause", agent="tester", probe_enabled=True
        )
        # Swap in a deterministic sleep that triggers resume on first call.
        tracer.probe_runtime = ProbeRuntime(
            poll_interval_ms=1,
            sleep=sleep_that_triggers(lambda: request_resume(tracer.run_id)),
            now=tracer.probe_runtime.now,
        )
        request_pause(tracer.run_id)

        client = FakeAnthropic()
        traced = trace_anthropic(tracer, client)
        traced.messages.create(
            model="claude-opus-4-7",
            max_tokens=64,
            messages=[{"role": "user", "content": "go"}],
        )
        tracer.end()
        self.assertIsNotNone(client.messages.last_req, "call did eventually run")

    def test_probe_enabled_inject_appears_in_request(self) -> None:
        tracer = SpoolTracer(
            project="/tmp/p-inj", agent="tester", probe_enabled=True
        )
        set_inject(tracer.run_id, "operator nudge: check the logs")
        client = FakeAnthropic()
        traced = trace_anthropic(tracer, client)
        traced.messages.create(
            model="claude-opus-4-7",
            max_tokens=64,
            messages=[{"role": "user", "content": "what's next?"}],
        )
        tracer.end()
        msgs = client.messages.last_req["messages"]
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[1]["content"], "operator nudge: check the logs")

    def test_tracer_end_clears_probe_file(self) -> None:
        tracer = SpoolTracer(
            project="/tmp/p-clear", agent="tester", probe_enabled=True
        )
        set_inject(tracer.run_id, "force file creation")
        self.assertTrue(probe_file_path(tracer.run_id).exists())
        tracer.end()
        self.assertFalse(
            probe_file_path(tracer.run_id).exists(),
            "tracer.end() must clear the probe file",
        )

    def test_tracer_end_safe_when_probe_never_used(self) -> None:
        tracer = SpoolTracer(project="/tmp/p-noop-clear", agent="tester")
        # No exception even though no probe file ever existed:
        tracer.end()


if __name__ == "__main__":
    unittest.main()
