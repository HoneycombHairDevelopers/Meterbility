"""
Tier 11 — exhaustive coverage of ``meterbility_agent.tracer`` (MeterbilityTracer +
MeterbilityStep), the Python SDK's user-facing runtime.

Mirrors TS Tier 9 (``packages/agent/src/step.exhaustive.test.ts``)
section-for-section so a future audit can diff the two test rosters
and confirm parity.

Sections:
  1. Builder method shape contracts (12 tests)
  2. Tag management (3 tests)
  3. end() persistence (7 tests)
  4. Status derivation (4 tests)
  5. Latency rules (3 tests)
  6. Context snapshot composition (6 tests)
  7. Collector integration (4 tests)
  8. Tracer lifecycle (3 tests)
  9. Hand-rolled property loops (3 tests)

Zero install footprint: pure stdlib unittest, no `hypothesis`. Property
tests use deterministic N-iteration loops instead.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from meterbility_agent import MeterbilityTracer  # noqa: E402
from meterbility_agent.tracer import MeterbilityStep  # noqa: E402


# ─── Shared fixture ────────────────────────────────────────────────────


class IsolatedMeterbilityHome(unittest.TestCase):
    """Redirect METERBILITY_HOME to a per-test tempdir."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_home = os.environ.get("METERBILITY_HOME")
        os.environ["METERBILITY_HOME"] = self._tmp.name

    def tearDown(self) -> None:
        if self._prev_home is None:
            os.environ.pop("METERBILITY_HOME", None)
        else:
            os.environ["METERBILITY_HOME"] = self._prev_home
        self._tmp.cleanup()

    def _db(self) -> sqlite3.Connection:
        return sqlite3.connect(str(Path(self._tmp.name) / "meterbility.db"))

    def _tracer(self, **kwargs: Any) -> MeterbilityTracer:
        defaults: Dict[str, Any] = {
            "project": "/tmp/tracer-exh",
            "agent": "tester",
            "run_title": "tracer-exh-fixture",
        }
        defaults.update(kwargs)
        return MeterbilityTracer(**defaults)


ZERO_TOKENS: Dict[str, int] = {
    "input": 0,
    "output": 0,
    "cached_read": 0,
    "cache_creation": 0,
}


# ─────────────────────────────────────────────────────────────────────
# Section 1 — Builder method shape contracts (12 tests)
# ─────────────────────────────────────────────────────────────────────


class TestStepBuilder(IsolatedMeterbilityHome):
    def test_step_id_format(self) -> None:
        """step_id has `stp_` prefix and a real UUID body."""
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            self.assertTrue(step.step_id.startswith("stp_"))
            # Verify the body parses as a UUID.
            uuid.UUID(step.step_id[len("stp_"):])
        finally:
            tracer.end()

    def test_sequence_from_tracer_counter(self) -> None:
        tracer = self._tracer()
        try:
            s0 = tracer.start_step(model="claude-opus-4-7")
            self.assertEqual(s0.sequence, 0)
            s0.record_tokens(**ZERO_TOKENS).end()
            s1 = tracer.start_step(model="claude-opus-4-7")
            self.assertEqual(s1.sequence, 1)
            s1.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()

    def test_construction_tags_carry_through_to_final_step(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7", tags=["benchmark", "fast"]
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        user_tags = sorted(t for t in persisted["tags"] if t != "cost:approx")
        self.assertEqual(user_tags, ["benchmark", "fast"])

    def test_record_decision_stores_both_decision_and_action(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_decision(
                decision={"thinking": "I should call Read", "choice": "Read"},
                action={
                    "kind": "tool_call",
                    "tool_name": "Read",
                    "tool_input": {"path": "/x"},
                },
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["action"]["kind"], "tool_call")
        self.assertEqual(persisted["action"]["tool_name"], "Read")
        self.assertTrue(persisted["decision_ref"])

    def test_record_action_overwrites_action(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_call("Read", {"path": "/a"}).record_action(
                {"kind": "message", "text": "never mind"}
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["action"]["kind"], "message")

    def test_record_tool_call_with_id(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_call(
                "Bash", {"command": "ls"}, tool_use_id="tu_abc"
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["action"]["tool_name"], "Bash")
        self.assertEqual(persisted["action"]["tool_use_id"], "tu_abc")
        self.assertEqual(
            persisted["action"]["tool_input"], {"command": "ls"}
        )

    def test_record_tool_call_id_optional(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_call("Read", {"path": "/x"}).record_tokens(
                **ZERO_TOKENS
            )
            persisted = step.end()
        finally:
            tracer.end()
        self.assertIsNone(persisted["action"]["tool_use_id"])

    def test_record_message(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_message("hello, world").record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["action"]["kind"], "message")
        self.assertEqual(persisted["action"]["text"], "hello, world")

    def test_record_outcome_stores_verbatim(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_outcome(
                {"status": "ok", "summary": "did it"}
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["outcome"]["status"], "ok")
        self.assertEqual(persisted["outcome"]["summary"], "did it")

    def test_record_tool_result_ok_path(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_result(
                {"output": "file contents"}, summary="read ok"
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["outcome"]["status"], "ok")
        self.assertEqual(persisted["outcome"]["is_error"], False)
        self.assertEqual(persisted["outcome"]["summary"], "read ok")
        self.assertTrue(persisted["outcome"].get("tool_result_ref"))

    def test_record_tool_result_error_path(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_result(
                "EACCES", is_error=True, summary="permission denied"
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["outcome"]["status"], "error")
        self.assertEqual(persisted["outcome"]["is_error"], True)

    def test_record_tokens_with_explicit_latency(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(
                input=1234,
                output=56,
                cached_read=78,
                cache_creation=9,
                cache_creation_1h=1,
                latency_ms=999,
            )
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["tokens"]["input"], 1234)
        self.assertEqual(persisted["tokens"]["output"], 56)
        self.assertEqual(persisted["tokens"]["cached_read"], 78)
        self.assertEqual(persisted["tokens"]["cache_creation"], 9)
        self.assertEqual(persisted["tokens"]["cache_creation_1h"], 1)
        self.assertEqual(persisted["latency_ms"], 999, "explicit latency wins")


# ─────────────────────────────────────────────────────────────────────
# Section 2 — Tag management (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestStepTags(IsolatedMeterbilityHome):
    def test_tag_adds_new_tag(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.tag("manual").record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertIn("manual", persisted["tags"])

    def test_tag_is_idempotent(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.tag("retry").tag("retry").tag("retry").record_tokens(
                **ZERO_TOKENS
            )
            persisted = step.end()
        finally:
            tracer.end()
        retry_count = sum(1 for t in persisted["tags"] if t == "retry")
        self.assertEqual(retry_count, 1, "tag deduplicated")

    def test_tag_chains_with_construction_tags(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7", tags=["benchmark"]
            )
            step.tag("manual-add").record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        user_tags = sorted(t for t in persisted["tags"] if t != "cost:approx")
        self.assertEqual(user_tags, ["benchmark", "manual-add"])


# ─────────────────────────────────────────────────────────────────────
# Section 3 — end() persistence (7 tests)
# ─────────────────────────────────────────────────────────────────────


class TestStepPersistence(IsolatedMeterbilityHome):
    def _step_row(self, step_id: str) -> Dict[str, Any]:
        """Read the persisted step row back via SQL."""
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM steps WHERE step_id = ?", (step_id,)
            ).fetchone()
        self.assertIsNotNone(row, f"step {step_id} not in DB")
        cols = [
            "step_id",
            "run_id",
            "parent_step_id",
            "fork_origin_id",
            "sequence",
            "timestamp",
            "model",
            "context_snapshot_id",
            "decision_ref",
            "action_json",
            "outcome_json",
            "tokens_input",
            "tokens_output",
            "tokens_cached_read",
            "tokens_cache_creation",
            "tokens_cache_creation_1h",
            "tokens_reasoning",
            "latency_ms",
            "cost_cents",
            "status",
            "tags",
        ]
        return dict(zip(cols, row))

    def test_step_row_persisted(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(**ZERO_TOKENS)
            step_id = step.step_id
            step.end()
        finally:
            tracer.end()
        row = self._step_row(step_id)
        self.assertEqual(row["step_id"], step_id)

    def test_context_snapshot_and_decision_blobs_persisted(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7", system_prompt="you are a tester"
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        self.assertTrue(persisted["context_snapshot_id"])
        self.assertTrue(persisted["decision_ref"])

    def test_tool_result_blob_persisted_only_when_recorded(self) -> None:
        tracer = self._tracer()
        try:
            # Step A — no tool result
            a = tracer.start_step(model="claude-opus-4-7")
            a.record_tool_call("Read", {"path": "/x"}).record_tokens(
                **ZERO_TOKENS
            )
            persisted_a = a.end()
            # Step B — with tool result
            b = tracer.start_step(model="claude-opus-4-7")
            b.record_tool_call("Read", {"path": "/y"}).record_tool_result(
                "contents"
            ).record_tokens(**ZERO_TOKENS)
            persisted_b = b.end()
        finally:
            tracer.end()
        self.assertIsNone(
            persisted_a["outcome"].get("tool_result_ref"),
            "no tool_result_ref when record_tool_result skipped",
        )
        self.assertTrue(
            persisted_b["outcome"].get("tool_result_ref"),
            "tool_result_ref present when record_tool_result fired",
        )

    def test_end_returns_full_step_shape(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_call("Read", {"path": "/x"}).record_tokens(
                **ZERO_TOKENS
            )
            persisted = step.end()
        finally:
            tracer.end()
        for field in [
            "step_id",
            "run_id",
            "sequence",
            "timestamp",
            "model",
            "context_snapshot_id",
            "decision_ref",
            "action",
            "outcome",
            "tokens",
            "latency_ms",
            "cost_cents",
            "tags",
            "status",
        ]:
            self.assertIn(field, persisted, f"missing field: {field}")

    def test_end_called_twice_raises(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(**ZERO_TOKENS).end()
            with self.assertRaisesRegex(RuntimeError, "twice"):
                step.end()
        finally:
            tracer.end()

    def test_cost_approx_tag_for_unknown_model(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="model-that-pricing-doesnt-know-about")
            step.record_tokens(input=100, output=50)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertIn(
            "cost:approx",
            persisted["tags"],
            "approx tag added for unknown model",
        )

    def test_no_cost_approx_tag_for_known_model(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(input=100, output=50)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertNotIn(
            "cost:approx",
            persisted["tags"],
            "approx tag NOT added for known-pricing model",
        )


# ─────────────────────────────────────────────────────────────────────
# Section 4 — Status derivation (4 tests)
# ─────────────────────────────────────────────────────────────────────


class TestStatusDerivation(IsolatedMeterbilityHome):
    def test_outcome_ok_maps_to_status_ok(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_call("Read", {"path": "/x"}).record_tool_result(
                "contents", is_error=False
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["status"], "ok")

    def test_outcome_error_via_tool_result_maps_to_error(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_call("Read", {"path": "/x"}).record_tool_result(
                "EACCES", is_error=True
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["status"], "error")

    def test_pending_outcome_maps_to_in_progress(self) -> None:
        """No record_outcome / record_tool_result → outcome stays at the
        construct-time `pending` default. Status derives to in_progress."""
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["status"], "in_progress")

    def test_explicit_record_outcome_error(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_outcome(
                {"status": "error", "is_error": True}
            ).record_tokens(**ZERO_TOKENS)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["status"], "error")


# ─────────────────────────────────────────────────────────────────────
# Section 5 — Latency (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestLatency(IsolatedMeterbilityHome):
    def test_explicit_latency_preserved(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(**ZERO_TOKENS, latency_ms=12345)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["latency_ms"], 12345)

    def test_explicit_latency_zero_is_honored(self) -> None:
        """Bug-likely: a `latency_ms or wall_clock` shortcut would treat
        0 as falsy. The actual implementation checks `is not None`."""
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(**ZERO_TOKENS, latency_ms=0)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertEqual(persisted["latency_ms"], 0, "explicit 0 must not fall back")

    def test_no_explicit_latency_uses_monotonic_clock(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tokens(**ZERO_TOKENS)
            time.sleep(0.005)
            persisted = step.end()
        finally:
            tracer.end()
        self.assertGreaterEqual(
            persisted["latency_ms"], 0, "wall-clock latency is non-negative"
        )


# ─────────────────────────────────────────────────────────────────────
# Section 6 — Context snapshot composition (6 tests)
# ─────────────────────────────────────────────────────────────────────


class TestContextComposition(IsolatedMeterbilityHome):
    def _read_context(self, snapshot_id: str) -> List[Dict[str, Any]]:
        """Read context components back through the BlobStore."""
        with self._db() as conn:
            row = conn.execute(
                "SELECT blob_ref FROM context_snapshots WHERE snapshot_id = ?",
                (snapshot_id,),
            ).fetchone()
        self.assertIsNotNone(row, "snapshot not in DB")
        from meterbility_agent.paths import meter_home
        blob_root = Path(meter_home()) / "blobs"
        sha = row[0]
        path = blob_root / sha[:2] / sha[2:4] / sha
        text = path.read_text(encoding="utf-8")
        snapshot = json.loads(text)
        return snapshot["components"]

    def test_empty_options_yields_empty_components(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(model="claude-opus-4-7")
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        components = self._read_context(persisted["context_snapshot_id"])
        self.assertEqual(components, [], "no components when no context fields")

    def test_system_prompt_component(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7", system_prompt="you are a tester"
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        components = self._read_context(persisted["context_snapshot_id"])
        self.assertEqual(len(components), 1)
        self.assertEqual(components[0]["type"], "system_prompt")
        self.assertTrue(components[0]["content_ref"])

    def test_tool_definitions_component(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7",
                tool_definitions=[{"name": "Read", "description": "reads files"}],
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        components = self._read_context(persisted["context_snapshot_id"])
        self.assertEqual(len(components), 1)
        self.assertEqual(components[0]["type"], "tool_definitions")

    def test_history_component_with_n_messages(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7",
                history=[
                    {"role": "user", "content": "first"},
                    {"role": "assistant", "content": "ack"},
                    {"role": "user", "content": "second"},
                ],
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        components = self._read_context(persisted["context_snapshot_id"])
        self.assertEqual(len(components), 1)
        hist = components[0]
        self.assertEqual(hist["type"], "conversation_history")
        self.assertEqual(len(hist["messages"]), 3)
        self.assertEqual(hist["messages"][0]["role"], "user")
        self.assertTrue(hist["messages"][0]["content_ref"])

    def test_retrieved_docs_component(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7",
                retrieved_docs=[
                    {"source": "docs.md", "content": "doc one"},
                    {"source": "guide.md", "content": "doc two"},
                ],
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        components = self._read_context(persisted["context_snapshot_id"])
        self.assertEqual(len(components), 1)
        docs = components[0]
        self.assertEqual(docs["type"], "retrieved_documents")
        self.assertEqual(len(docs["docs"]), 2)
        self.assertEqual(docs["docs"][0]["source"], "docs.md")

    def test_all_four_components_together(self) -> None:
        tracer = self._tracer()
        try:
            step = tracer.start_step(
                model="claude-opus-4-7",
                system_prompt="system",
                tool_definitions=[{"name": "Read"}],
                history=[{"role": "user", "content": "hi"}],
                retrieved_docs=[{"source": "x.md", "content": "y"}],
            )
            persisted = step.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        components = self._read_context(persisted["context_snapshot_id"])
        types = [c["type"] for c in components]
        self.assertEqual(
            types,
            [
                "system_prompt",
                "tool_definitions",
                "conversation_history",
                "retrieved_documents",
            ],
        )


# ─────────────────────────────────────────────────────────────────────
# Section 7 — Collector integration (4 tests)
# ─────────────────────────────────────────────────────────────────────


class TestCollectorIntegration(IsolatedMeterbilityHome):
    def test_multiple_steps_share_run_id(self) -> None:
        tracer = self._tracer()
        run_id = tracer.run_id
        try:
            s0 = tracer.start_step(model="claude-opus-4-7")
            p0 = s0.record_tokens(**ZERO_TOKENS).end()
            s1 = tracer.start_step(model="claude-opus-4-7")
            p1 = s1.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        self.assertEqual(p0["run_id"], run_id)
        self.assertEqual(p1["run_id"], run_id)

    def test_end_triggers_refresh_totals_on_run_row(self) -> None:
        tracer = self._tracer()
        run_id = tracer.run_id
        try:
            for _ in range(3):
                step = tracer.start_step(model="claude-opus-4-7")
                step.record_tokens(
                    input=100, output=50
                ).end()
        finally:
            tracer.end()
        with self._db() as conn:
            row = conn.execute(
                """SELECT step_count, tokens_total_input, tokens_total_output
                   FROM runs WHERE run_id = ?""",
                (run_id,),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], 3, "step_count reflects three end() calls")
        self.assertEqual(row[1], 300, "input tokens summed")
        self.assertEqual(row[2], 150, "output tokens summed")

    def test_identical_context_produces_identical_snapshot_id(self) -> None:
        """Two steps with identical context options produce the same
        snapshot id — the dedup contract the BlobStore relies on."""
        tracer = self._tracer()
        try:
            opts: Dict[str, Any] = {
                "model": "claude-opus-4-7",
                "system_prompt": "same prompt",
            }
            s0 = tracer.start_step(**opts)
            p0 = s0.record_tokens(**ZERO_TOKENS).end()
            s1 = tracer.start_step(**opts)
            p1 = s1.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        self.assertEqual(
            p0["context_snapshot_id"],
            p1["context_snapshot_id"],
            "identical context → identical snapshot id",
        )

    def test_distinct_context_produces_distinct_snapshot_ids(self) -> None:
        tracer = self._tracer()
        try:
            s0 = tracer.start_step(
                model="claude-opus-4-7", system_prompt="first prompt"
            )
            p0 = s0.record_tokens(**ZERO_TOKENS).end()
            s1 = tracer.start_step(
                model="claude-opus-4-7", system_prompt="different prompt"
            )
            p1 = s1.record_tokens(**ZERO_TOKENS).end()
        finally:
            tracer.end()
        self.assertNotEqual(p0["context_snapshot_id"], p1["context_snapshot_id"])


# ─────────────────────────────────────────────────────────────────────
# Section 8 — Tracer lifecycle (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestTracerLifecycle(IsolatedMeterbilityHome):
    def test_context_manager_normal_exit_seals_run_ok(self) -> None:
        with self._tracer() as tracer:
            run_id = tracer.run_id
            step = tracer.start_step(model="claude-opus-4-7")
            step.record_tool_result("ok").record_tokens(**ZERO_TOKENS).end()
        with self._db() as conn:
            status = conn.execute(
                "SELECT status FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
        self.assertEqual(status, "ok")

    def test_context_manager_exception_seals_run_error(self) -> None:
        """Body raising → run sealed as error before propagating."""
        run_id_holder: Dict[str, str] = {}
        with self.assertRaisesRegex(RuntimeError, "boom"):
            with self._tracer() as tracer:
                run_id_holder["id"] = tracer.run_id
                raise RuntimeError("boom")
        with self._db() as conn:
            status = conn.execute(
                "SELECT status FROM runs WHERE run_id = ?",
                (run_id_holder["id"],),
            ).fetchone()[0]
        self.assertEqual(status, "error")

    def test_end_is_idempotent(self) -> None:
        """end() called twice is a silent no-op (not an error)."""
        tracer = self._tracer()
        tracer.end()
        # Second call must not raise.
        tracer.end()


# ─────────────────────────────────────────────────────────────────────
# Section 9 — Hand-rolled property loops (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestStepProperties(IsolatedMeterbilityHome):
    N_ITERATIONS = 20

    def test_step_id_format_holds_across_many_constructions(self) -> None:
        """Property P1: every step_id matches `stp_<UUID>` pattern."""
        import re
        pattern = re.compile(
            r"^stp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            re.IGNORECASE,
        )
        tracer = self._tracer()
        try:
            for _ in range(self.N_ITERATIONS):
                step = tracer.start_step(model="claude-opus-4-7")
                self.assertRegex(step.step_id, pattern)
                # Don't persist — just verifying the construction-time id
                # format. The step is never end()'d.
        finally:
            tracer.end()

    def test_tag_dedup_n_applications_count_as_one(self) -> None:
        """Property P2: N applications of the same tag yield exactly 1."""
        for n in [1, 2, 5, 10]:
            tracer = self._tracer()
            try:
                step = tracer.start_step(model="claude-opus-4-7")
                for _ in range(n):
                    step.tag("dedup-test")
                persisted = step.record_tokens(**ZERO_TOKENS).end()
            finally:
                tracer.end()
            count = sum(1 for t in persisted["tags"] if t == "dedup-test")
            self.assertEqual(count, 1, f"n={n}: expected 1 dedup-test tag")

    def test_record_tokens_stores_values_exactly(self) -> None:
        """Property P3: token values are stored verbatim, no coercion."""
        cases = [
            (0, 0, 0, 0),
            (1, 1, 1, 1),
            (100, 50, 25, 12),
            (1_000_000, 500_000, 0, 0),
        ]
        for inp, out, cr, cc in cases:
            tracer = self._tracer()
            try:
                step = tracer.start_step(model="claude-opus-4-7")
                step.record_tokens(
                    input=inp, output=out, cached_read=cr, cache_creation=cc
                )
                persisted = step.end()
            finally:
                tracer.end()
            self.assertEqual(persisted["tokens"]["input"], inp)
            self.assertEqual(persisted["tokens"]["output"], out)
            self.assertEqual(persisted["tokens"]["cached_read"], cr)
            self.assertEqual(persisted["tokens"]["cache_creation"], cc)


if __name__ == "__main__":
    unittest.main()
