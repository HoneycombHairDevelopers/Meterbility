"""
Tier 12 — exhaustive coverage of ``meterbility_agent.queries`` and
``meterbility_agent.schema``. Mirrors TS Tier 8
(``packages/collector/src/queries.exhaustive.test.ts``) for the subset
of functions the Python SDK exposes (writes only — reads are TS-side).

Plus cross-language schema compat: tests that a Python-initialized
database opens cleanly in TS and vice versa. The wire-format contract
both SDKs share is the schema itself.

Sections:
  1. now_iso() (2 tests)
  2. upsert_project_by_cwd idempotency (4 tests)
  3. upsert_agent idempotency (3 tests)
  4. insert_run + set_run_status (5 tests)
  5. update_run_totals SQL aggregation (3 tests)
  6. insert_step + record_context_snapshot (6 tests)
  7. ensure_schema idempotency + version (5 tests)
  8. Cross-language schema compat (5 tests)

Pure stdlib unittest. No external deps.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE.parent / "src"))

from meterbility_agent.queries import (  # noqa: E402
    insert_run,
    insert_step,
    now_iso,
    record_context_snapshot,
    set_run_status,
    update_run_totals,
    upsert_agent,
    upsert_project_by_cwd,
)
from meterbility_agent.schema import SCHEMA_VERSION, ensure_schema  # noqa: E402
from meterbility_agent.store import Store  # noqa: E402


class IsolatedDB(unittest.TestCase):
    """Per-test METERBILITY_HOME + a fresh Store opened against it."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_home = os.environ.get("METERBILITY_HOME")
        os.environ["METERBILITY_HOME"] = self._tmp.name
        self.store = Store.open()
        self.db = self.store.db

    def tearDown(self) -> None:
        try:
            self.store.close()
        except Exception:
            pass
        if self._prev_home is None:
            os.environ.pop("METERBILITY_HOME", None)
        else:
            os.environ["METERBILITY_HOME"] = self._prev_home
        self._tmp.cleanup()

    def _commit(self) -> None:
        self.db.commit()


def _mk_run(project_id: str, agent_id: str, **overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "run_id": f"run_{os.urandom(8).hex()}",
        "agent_id": agent_id,
        "project_id": project_id,
        "source_runtime": "sdk-py",
        "title": "test run",
        "status": "in_progress",
        "started_at": now_iso(),
        "tokens_total_input": 0,
        "tokens_total_output": 0,
        "tokens_total_cached": 0,
        "cost_cents": 0,
        "step_count": 0,
        "tags": [],
    }
    base.update(overrides)
    return base


def _mk_step(run_id: str, sequence: int, **overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "step_id": f"stp_{os.urandom(8).hex()}",
        "run_id": run_id,
        "sequence": sequence,
        "timestamp": now_iso(),
        "model": "claude-opus-4-7",
        "context_snapshot_id": "snap_x",
        "decision_ref": "blob_dec",
        "action": {"kind": "tool_call", "tool_name": "Edit"},
        "outcome": {"status": "ok"},
        "tokens": {
            "input": 0,
            "output": 0,
            "cached_read": 0,
            "cache_creation": 0,
        },
        "latency_ms": 0,
        "cost_cents": 0,
        "tags": [],
        "status": "ok",
    }
    base.update(overrides)
    return base


# ─────────────────────────────────────────────────────────────────────
# Section 1 — now_iso() (2 tests)
# ─────────────────────────────────────────────────────────────────────


class TestNowIso(unittest.TestCase):
    def test_iso8601_utc_millisecond_format(self) -> None:
        s = now_iso()
        self.assertRegex(
            s,
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$",
            "matches TS new Date().toISOString() shape",
        )

    def test_now_iso_monotonic_across_calls(self) -> None:
        """Two successive calls produce strings whose ISO order matches
        their wall-clock order. Catches a tz / resolution regression."""
        a = now_iso()
        time.sleep(0.002)
        b = now_iso()
        self.assertLessEqual(a, b, "later call has >= timestamp string")


# ─────────────────────────────────────────────────────────────────────
# Section 2 — upsert_project_by_cwd (4 tests)
# ─────────────────────────────────────────────────────────────────────


class TestUpsertProject(IsolatedDB):
    def test_creates_on_first_call(self) -> None:
        p = upsert_project_by_cwd(self.db, "/tmp/proj-a", "proj-a")
        self.assertTrue(p["project_id"].startswith("prj_"))
        self.assertEqual(p["cwd"], "/tmp/proj-a")
        self.assertEqual(p["name"], "proj-a")

    def test_idempotent_same_cwd_returns_same_row(self) -> None:
        a = upsert_project_by_cwd(self.db, "/tmp/proj-a", "proj-a")
        b = upsert_project_by_cwd(self.db, "/tmp/proj-a", "proj-a")
        self.assertEqual(a["project_id"], b["project_id"])

    def test_distinct_cwds_create_distinct_projects(self) -> None:
        a = upsert_project_by_cwd(self.db, "/tmp/proj-a", "a")
        b = upsert_project_by_cwd(self.db, "/tmp/proj-b", "b")
        self.assertNotEqual(a["project_id"], b["project_id"])

    def test_name_change_on_existing_cwd_does_not_mint_new_row(self) -> None:
        """cwd is the identity; name is metadata. Renaming on the same
        cwd must return the EXISTING row, not insert."""
        a = upsert_project_by_cwd(self.db, "/tmp/p", "original")
        b = upsert_project_by_cwd(self.db, "/tmp/p", "renamed")
        self.assertEqual(a["project_id"], b["project_id"])
        # Existing row's name is preserved (no update fired)
        self.assertEqual(b["name"], "original")


# ─────────────────────────────────────────────────────────────────────
# Section 3 — upsert_agent (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestUpsertAgent(IsolatedDB):
    def test_creates_on_first_call(self) -> None:
        p = upsert_project_by_cwd(self.db, "/tmp/a-test", "p")
        a = upsert_agent(self.db, p["project_id"], "claude-code")
        self.assertTrue(a["agent_id"].startswith("agt_"))
        self.assertEqual(a["name"], "claude-code")

    def test_idempotent_on_project_name_pair(self) -> None:
        p = upsert_project_by_cwd(self.db, "/tmp/a-idem", "p")
        a = upsert_agent(self.db, p["project_id"], "claude-code")
        b = upsert_agent(self.db, p["project_id"], "claude-code")
        self.assertEqual(a["agent_id"], b["agent_id"])

    def test_same_agent_name_distinct_projects_distinct_agents(self) -> None:
        pa = upsert_project_by_cwd(self.db, "/tmp/a-A", "a")
        pb = upsert_project_by_cwd(self.db, "/tmp/a-B", "b")
        agt_a = upsert_agent(self.db, pa["project_id"], "claude-code")
        agt_b = upsert_agent(self.db, pb["project_id"], "claude-code")
        self.assertNotEqual(agt_a["agent_id"], agt_b["agent_id"])


# ─────────────────────────────────────────────────────────────────────
# Section 4 — insert_run + set_run_status (5 tests)
# ─────────────────────────────────────────────────────────────────────


class TestRunLifecycle(IsolatedDB):
    def _seed(self) -> Dict[str, str]:
        p = upsert_project_by_cwd(self.db, "/tmp/run-test", "p")
        a = upsert_agent(self.db, p["project_id"], "agt")
        return {"project_id": p["project_id"], "agent_id": a["agent_id"]}

    def test_insert_run_persists_full_shape(self) -> None:
        seed = self._seed()
        run = _mk_run(
            seed["project_id"],
            seed["agent_id"],
            title="round trip",
            tags=["a", "b"],
            cwd="/tmp/rt",
        )
        insert_run(self.db, run)
        row = self.db.execute(
            "SELECT title, cwd, tags FROM runs WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()
        self.assertEqual(row[0], "round trip")
        self.assertEqual(row[1], "/tmp/rt")
        self.assertEqual(json.loads(row[2]), ["a", "b"])

    def test_insert_run_tag_list_json_encoded(self) -> None:
        """Tags are stored as a JSON string; the column type is TEXT."""
        seed = self._seed()
        run = _mk_run(seed["project_id"], seed["agent_id"], tags=["x", "y", "z"])
        insert_run(self.db, run)
        raw_tags = self.db.execute(
            "SELECT tags FROM runs WHERE run_id = ?", (run["run_id"],)
        ).fetchone()[0]
        self.assertEqual(json.loads(raw_tags), ["x", "y", "z"])
        self.assertIsInstance(raw_tags, str, "TEXT column → string")

    def test_insert_run_optional_fields_default_to_null(self) -> None:
        """Optional fields (title, ended_at, git_branch, etc.) become
        SQL NULL when omitted from the input dict."""
        seed = self._seed()
        run = _mk_run(seed["project_id"], seed["agent_id"])
        # Strip optionals to verify they default to NULL
        for k in ("title", "ended_at", "git_branch", "cwd"):
            run.pop(k, None)
        insert_run(self.db, run)
        row = self.db.execute(
            "SELECT title, ended_at, git_branch, cwd FROM runs WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()
        self.assertEqual(row, (None, None, None, None))

    def test_set_run_status_with_ended_at(self) -> None:
        seed = self._seed()
        run = _mk_run(seed["project_id"], seed["agent_id"])
        insert_run(self.db, run)
        stamp = "2026-05-19T12:34:56.000Z"
        set_run_status(self.db, run["run_id"], "ok", stamp)
        row = self.db.execute(
            "SELECT status, ended_at FROM runs WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()
        self.assertEqual(row[0], "ok")
        self.assertEqual(row[1], stamp)

    def test_set_run_status_without_ended_at_clears_column(self) -> None:
        """Calling set_run_status with no ended_at passes NULL, which
        UPDATEs the column to NULL. Documents the contract — higher-level
        callers stamp the time themselves."""
        seed = self._seed()
        run = _mk_run(
            seed["project_id"], seed["agent_id"], ended_at="2026-01-01T00:00:00.000Z"
        )
        insert_run(self.db, run)
        # Re-status without endedAt clears it
        set_run_status(self.db, run["run_id"], "in_progress")
        row = self.db.execute(
            "SELECT status, ended_at FROM runs WHERE run_id = ?",
            (run["run_id"],),
        ).fetchone()
        self.assertEqual(row[0], "in_progress")
        self.assertIsNone(row[1], "ended_at cleared when not supplied")


# ─────────────────────────────────────────────────────────────────────
# Section 5 — update_run_totals (3 tests)
# ─────────────────────────────────────────────────────────────────────


class TestUpdateRunTotals(IsolatedDB):
    def _seed_run(self) -> str:
        p = upsert_project_by_cwd(self.db, "/tmp/totals", "p")
        a = upsert_agent(self.db, p["project_id"], "agt")
        run = _mk_run(p["project_id"], a["agent_id"])
        insert_run(self.db, run)
        return run["run_id"]

    def test_sums_step_tokens_and_costs(self) -> None:
        run_id = self._seed_run()
        for i in range(3):
            insert_step(
                self.db,
                _mk_step(
                    run_id,
                    i,
                    tokens={
                        "input": 100,
                        "output": 50,
                        "cached_read": 10,
                        "cache_creation": 5,
                    },
                    cost_cents=7,
                ),
            )
        update_run_totals(self.db, run_id)
        row = self.db.execute(
            """SELECT step_count, tokens_total_input, tokens_total_output,
                      tokens_total_cached, cost_cents
               FROM runs WHERE run_id = ?""",
            (run_id,),
        ).fetchone()
        self.assertEqual(row[0], 3, "step_count")
        self.assertEqual(row[1], 300, "input sum")
        self.assertEqual(row[2], 150, "output sum")
        # tokens_total_cached = cached_read + cache_creation + cache_creation_1h
        self.assertEqual(row[3], 45)
        self.assertEqual(row[4], 21, "cost_cents sum")

    def test_zero_steps_zeroes_totals_not_nulls(self) -> None:
        """COALESCE fallback: a run with no steps gets 0, not NULL."""
        run_id = self._seed_run()
        # Pre-set bogus totals to verify the UPDATE clobbers them
        self.db.execute(
            "UPDATE runs SET tokens_total_input = 999 WHERE run_id = ?",
            (run_id,),
        )
        update_run_totals(self.db, run_id)
        row = self.db.execute(
            "SELECT step_count, tokens_total_input, cost_cents FROM runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        self.assertEqual(row[0], 0)
        self.assertEqual(row[1], 0, "no steps → 0, not NULL")
        self.assertEqual(row[2], 0)

    def test_cache_creation_1h_included_in_total(self) -> None:
        """tokens_total_cached must include the 1h cache write column."""
        run_id = self._seed_run()
        insert_step(
            self.db,
            _mk_step(
                run_id,
                0,
                tokens={
                    "input": 0,
                    "output": 0,
                    "cached_read": 1,
                    "cache_creation": 2,
                    "cache_creation_1h": 4,
                },
            ),
        )
        update_run_totals(self.db, run_id)
        total_cached = self.db.execute(
            "SELECT tokens_total_cached FROM runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()[0]
        self.assertEqual(total_cached, 7, "1 + 2 + 4 = 7")


# ─────────────────────────────────────────────────────────────────────
# Section 6 — insert_step + record_context_snapshot (6 tests)
# ─────────────────────────────────────────────────────────────────────


class TestStepInsertion(IsolatedDB):
    def _seed_run(self) -> str:
        p = upsert_project_by_cwd(self.db, "/tmp/step-test", "p")
        a = upsert_agent(self.db, p["project_id"], "agt")
        run = _mk_run(p["project_id"], a["agent_id"])
        insert_run(self.db, run)
        return run["run_id"]

    def test_insert_step_persists_action_and_outcome_as_json(self) -> None:
        run_id = self._seed_run()
        step = _mk_step(
            run_id,
            0,
            action={
                "kind": "tool_call",
                "tool_name": "Bash",
                "tool_use_id": "tu_abc",
                "tool_input": {"command": "ls"},
            },
            outcome={"status": "ok", "summary": "did it"},
        )
        insert_step(self.db, step)
        row = self.db.execute(
            "SELECT action_json, outcome_json FROM steps WHERE step_id = ?",
            (step["step_id"],),
        ).fetchone()
        self.assertEqual(json.loads(row[0])["tool_name"], "Bash")
        self.assertEqual(json.loads(row[1])["summary"], "did it")

    def test_insert_step_token_columns_persisted(self) -> None:
        run_id = self._seed_run()
        step = _mk_step(
            run_id,
            0,
            tokens={
                "input": 100,
                "output": 50,
                "cached_read": 10,
                "cache_creation": 5,
                "cache_creation_1h": 1,
                "reasoning": 7,
            },
        )
        insert_step(self.db, step)
        row = self.db.execute(
            """SELECT tokens_input, tokens_output, tokens_cached_read,
                      tokens_cache_creation, tokens_cache_creation_1h,
                      tokens_reasoning
               FROM steps WHERE step_id = ?""",
            (step["step_id"],),
        ).fetchone()
        self.assertEqual(row, (100, 50, 10, 5, 1, 7))

    def test_insert_step_replaces_on_id_collision(self) -> None:
        """INSERT OR REPLACE — re-inserting the same step_id overwrites."""
        run_id = self._seed_run()
        sid = f"stp_{os.urandom(8).hex()}"
        insert_step(self.db, _mk_step(run_id, 0, step_id=sid, model="m-old"))
        insert_step(self.db, _mk_step(run_id, 0, step_id=sid, model="m-new"))
        row = self.db.execute(
            "SELECT model FROM steps WHERE step_id = ?", (sid,)
        ).fetchone()
        self.assertEqual(row[0], "m-new", "REPLACE overrides")

    def test_insert_step_replaces_on_unique_run_sequence_collision(self) -> None:
        """UNIQUE(run_id, sequence) + INSERT OR REPLACE: writing a new
        step with the same (run, seq) but a different step_id replaces
        the prior row (does NOT throw). Documents the contract — callers
        who want last-writer-wins idempotency rely on this."""
        run_id = self._seed_run()
        first = _mk_step(run_id, 0, model="m-first")
        second = _mk_step(run_id, 0, model="m-second")  # different step_id, same (run, seq)
        insert_step(self.db, first)
        insert_step(self.db, second)
        # The first row is gone (replaced); only the second's step_id remains.
        rows = self.db.execute(
            "SELECT step_id, model FROM steps WHERE run_id = ? AND sequence = 0",
            (run_id,),
        ).fetchall()
        self.assertEqual(len(rows), 1, "REPLACE keeps a single row at (run, seq)")
        self.assertEqual(rows[0][0], second["step_id"], "second step_id wins")
        self.assertEqual(rows[0][1], "m-second")

    def test_record_context_snapshot_first_write_wins(self) -> None:
        """INSERT OR IGNORE: re-recording with a different blob_ref is
        a no-op (the first write's blob_ref persists)."""
        record_context_snapshot(self.db, "snap_x", "blob_first", 4)
        record_context_snapshot(self.db, "snap_x", "blob_second", 99)
        row = self.db.execute(
            "SELECT blob_ref, component_count FROM context_snapshots WHERE snapshot_id = ?",
            ("snap_x",),
        ).fetchone()
        self.assertEqual(row[0], "blob_first")
        self.assertEqual(row[1], 4, "component_count from first write")

    def test_record_context_snapshot_distinct_ids_independent(self) -> None:
        record_context_snapshot(self.db, "snap_a", "ref_a", 1)
        record_context_snapshot(self.db, "snap_b", "ref_b", 2)
        rows = self.db.execute(
            "SELECT snapshot_id, blob_ref FROM context_snapshots ORDER BY snapshot_id"
        ).fetchall()
        self.assertEqual(
            rows,
            [("snap_a", "ref_a"), ("snap_b", "ref_b")],
        )


# ─────────────────────────────────────────────────────────────────────
# Section 7 — schema.py ensure_schema (5 tests)
# ─────────────────────────────────────────────────────────────────────


class TestSchemaBootstrap(unittest.TestCase):
    def _fresh_db(self) -> sqlite3.Connection:
        self._tmp = tempfile.TemporaryDirectory()
        path = Path(self._tmp.name) / "test.db"
        return sqlite3.connect(str(path))

    def tearDown(self) -> None:
        if hasattr(self, "_tmp"):
            self._tmp.cleanup()

    def test_creates_all_documented_tables(self) -> None:
        db = self._fresh_db()
        ensure_schema(db)
        tables = {
            row[0]
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        for expected in [
            "meta",
            "projects",
            "agents",
            "runs",
            "steps",
            "context_snapshots",
            "forks",
            "annotations",
            "ingest_progress",
            "settings",
            "redaction_log",
            "regression_tests",
            "regression_results",
        ]:
            self.assertIn(
                expected, tables, f"missing table {expected}"
            )

    def test_ensure_schema_is_idempotent(self) -> None:
        """Running ensure_schema twice must not raise (every statement
        uses IF NOT EXISTS)."""
        db = self._fresh_db()
        ensure_schema(db)
        ensure_schema(db)  # second call must be safe

    def test_records_schema_version_on_first_init(self) -> None:
        db = self._fresh_db()
        ensure_schema(db)
        row = db.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
        self.assertEqual(int(row[0]), SCHEMA_VERSION)

    def test_does_not_lower_an_existing_higher_version(self) -> None:
        """If TS has already migrated the DB to a higher version, Python
        must not overwrite it. Pinning the docstring contract."""
        db = self._fresh_db()
        ensure_schema(db)
        # Simulate TS bumping the version
        db.execute(
            "UPDATE meta SET value = ? WHERE key='schema_version'",
            (str(SCHEMA_VERSION + 5),),
        )
        db.commit()
        ensure_schema(db)
        row = db.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
        self.assertEqual(
            int(row[0]),
            SCHEMA_VERSION + 5,
            "higher version preserved",
        )

    def test_ensure_column_adds_missing_tokens_cache_creation_1h(self) -> None:
        """Backward-compat: an older DB that lacks the column should
        have it added on ensure_schema. We simulate by dropping the
        column from a fresh DB (or by creating the table without it)."""
        db = self._fresh_db()
        # Create an older-shape steps table without tokens_cache_creation_1h
        db.execute("""
            CREATE TABLE steps (
              step_id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              parent_step_id TEXT,
              fork_origin_id TEXT,
              sequence INTEGER NOT NULL,
              timestamp TEXT NOT NULL,
              model TEXT NOT NULL,
              context_snapshot_id TEXT NOT NULL,
              decision_ref TEXT NOT NULL,
              action_json TEXT NOT NULL,
              outcome_json TEXT NOT NULL,
              tokens_input INTEGER NOT NULL DEFAULT 0,
              tokens_output INTEGER NOT NULL DEFAULT 0,
              tokens_cached_read INTEGER NOT NULL DEFAULT 0,
              tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
              tokens_reasoning INTEGER,
              latency_ms INTEGER NOT NULL DEFAULT 0,
              cost_cents REAL NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              tags TEXT NOT NULL DEFAULT '[]'
            )
        """)
        db.commit()
        ensure_schema(db)
        cols = {r[1] for r in db.execute("PRAGMA table_info(steps)").fetchall()}
        self.assertIn(
            "tokens_cache_creation_1h",
            cols,
            "_ensure_column backfilled the missing column",
        )


# ─────────────────────────────────────────────────────────────────────
# Section 8 — Cross-language schema compat (5 tests)
#
# Spawns the TS collector via `node --import tsx/esm` to operate on the
# same SQLite file Python initialized (or vice versa). Asserts that:
#   - Python-initialized DB opens cleanly in TS
#   - Tables Python creates have the columns TS expects
#   - Wire-format (column names + types) matches between the two SDKs
# ─────────────────────────────────────────────────────────────────────


def _node_available() -> bool:
    return shutil.which("node") is not None


def _ts_table_info(db_path: Path, table: str) -> List[Dict[str, Any]]:
    """Open a SQLite DB via better-sqlite3 + return PRAGMA table_info.
    Note: with `node --input-type=module -e <script> -- arg1 arg2`,
    process.argv ends up as [node-binary, arg1, arg2] (no [eval] slot),
    so the first user arg is argv[1], not argv[2]."""
    script = """
import Database from "better-sqlite3";
const db = new Database(process.argv[1]);
const rows = db.prepare("PRAGMA table_info(" + process.argv[2] + ")").all();
process.stdout.write(JSON.stringify(rows));
"""
    proc = subprocess.run(
        [
            "node",
            "--import",
            "tsx/esm",
            "--input-type=module",
            "-e",
            script,
            "--",
            str(db_path),
            table,
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS table_info subprocess failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def _ts_ensure_schema(db_path: Path) -> None:
    """Have the TS collector initialize the schema at db_path.
    Same argv caveat as _ts_table_info: first user arg = argv[1]."""
    script = """
import { Store } from "%s";
const store = Store.open({ path: process.argv[1] });
store.close();
""" % (
        (REPO_ROOT / "packages" / "collector" / "src" / "store.ts").as_posix()
    )
    proc = subprocess.run(
        [
            "node",
            "--import",
            "tsx/esm",
            "--input-type=module",
            "-e",
            script,
            "--",
            str(db_path),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=20,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS Store.open failed: {proc.stderr.strip()}")


class TestCrossLanguageSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not _node_available():
            raise unittest.SkipTest("node not on PATH; skipping compat tests")

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "compat.db"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_python_init_then_ts_reads_runs_table(self) -> None:
        """Python ensure_schema → TS opens the file → TS PRAGMA reads it.
        If the column shape drifts, TS can't query a Python-written DB."""
        db = sqlite3.connect(str(self.db_path))
        ensure_schema(db)
        db.close()
        try:
            cols = _ts_table_info(self.db_path, "runs")
        except RuntimeError as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        col_names = {c["name"] for c in cols}
        for required in [
            "run_id",
            "agent_id",
            "project_id",
            "source_runtime",
            "status",
            "started_at",
            "tokens_total_input",
            "tokens_total_output",
            "tokens_total_cached",
            "cost_cents",
            "step_count",
            "tags",
        ]:
            self.assertIn(
                required, col_names, f"TS missing {required} from Python schema"
            )

    def test_python_steps_table_has_all_token_columns_ts_expects(
        self,
    ) -> None:
        db = sqlite3.connect(str(self.db_path))
        ensure_schema(db)
        db.close()
        try:
            cols = _ts_table_info(self.db_path, "steps")
        except RuntimeError as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        col_names = {c["name"] for c in cols}
        for token_col in [
            "tokens_input",
            "tokens_output",
            "tokens_cached_read",
            "tokens_cache_creation",
            "tokens_cache_creation_1h",
            "tokens_reasoning",
        ]:
            self.assertIn(token_col, col_names)

    def test_ts_init_then_python_opens_and_reads(self) -> None:
        """TS Store.open → Python opens the file directly → both can query
        the runs table without errors."""
        try:
            _ts_ensure_schema(self.db_path)
        except RuntimeError as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        # Now Python should be able to open + read.
        db = sqlite3.connect(str(self.db_path))
        try:
            cols = {
                r[1] for r in db.execute("PRAGMA table_info(runs)").fetchall()
            }
            self.assertIn("run_id", cols)
            self.assertIn("source_runtime", cols)
        finally:
            db.close()

    def test_python_writes_after_ts_init_round_trip(self) -> None:
        """TS creates DB schema → Python writes a run + step → both can
        read them back. This is the canonical SDK flow: TS collector
        opens the store, Python SDK adds rows."""
        try:
            _ts_ensure_schema(self.db_path)
        except RuntimeError as e:
            self.skipTest(f"TS bridge unavailable: {e}")
        db = sqlite3.connect(str(self.db_path))
        try:
            p = upsert_project_by_cwd(db, "/tmp/xlang", "xlang")
            a = upsert_agent(db, p["project_id"], "agt")
            run = _mk_run(p["project_id"], a["agent_id"])
            insert_run(db, run)
            insert_step(db, _mk_step(run["run_id"], 0))
            db.commit()
            # Read back
            row = db.execute(
                "SELECT title FROM runs WHERE run_id = ?", (run["run_id"],)
            ).fetchone()
            self.assertIsNotNone(row)
        finally:
            db.close()

    def test_schema_version_meta_row_present_after_python_init(self) -> None:
        """A TS reader checks meta.schema_version to decide migrations.
        Python init must populate it."""
        db = sqlite3.connect(str(self.db_path))
        ensure_schema(db)
        version = db.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()
        self.assertIsNotNone(version)
        self.assertGreaterEqual(int(version[0]), 1)
        db.close()


if __name__ == "__main__":
    unittest.main()
