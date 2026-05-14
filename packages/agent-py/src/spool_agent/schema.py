"""
SQLite schema bootstrap — mirror packages/collector/src/schema.ts.

This is intentionally a verbatim copy of the TS schema (every CREATE
TABLE IF NOT EXISTS), so a Python-only user gets a working store on
first call. If the JS Store has already initialized the database, this
is a cheap idempotent no-op.

Whenever the TS schema changes, this file needs to mirror it. The
``SCHEMA_VERSION`` constant should stay in sync — but Python never
*lowers* the recorded version; only TS does migrations.
"""

from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 3

_DDL = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_session_id TEXT,
  source_runtime TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  git_branch TEXT,
  cwd TEXT,
  fork_origin_run_id TEXT REFERENCES runs(run_id),
  fork_origin_step_id TEXT,
  tokens_total_input INTEGER NOT NULL DEFAULT 0,
  tokens_total_output INTEGER NOT NULL DEFAULT 0,
  tokens_total_cached INTEGER NOT NULL DEFAULT 0,
  cost_cents REAL NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_runs_project_started
  ON runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_session
  ON runs(source_session_id);
CREATE INDEX IF NOT EXISTS idx_runs_fork_origin
  ON runs(fork_origin_run_id);

CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
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
  tokens_cache_creation_1h INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost_cents REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_steps_run
  ON steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_steps_context
  ON steps(context_snapshot_id);

CREATE TABLE IF NOT EXISTS context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  blob_ref TEXT NOT NULL,
  component_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forks (
  fork_id TEXT PRIMARY KEY,
  origin_run_id TEXT NOT NULL REFERENCES runs(run_id),
  origin_step_id TEXT NOT NULL,
  fork_run_id TEXT NOT NULL REFERENCES runs(run_id),
  edit_type TEXT NOT NULL,
  edit_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forks_origin
  ON forks(origin_run_id);

CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  author TEXT NOT NULL,
  verdict TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_target
  ON annotations(target_kind, target_id);

CREATE TABLE IF NOT EXISTS ingest_progress (
  source_runtime TEXT NOT NULL,
  source_path TEXT NOT NULL,
  last_offset INTEGER NOT NULL,
  last_ingested_at TEXT NOT NULL,
  PRIMARY KEY (source_runtime, source_path)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redaction_log (
  blob_ref TEXT NOT NULL,
  rule TEXT NOT NULL,
  count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redaction_blob
  ON redaction_log(blob_ref);

CREATE TABLE IF NOT EXISTS regression_tests (
  test_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  assertions_json TEXT NOT NULL,
  canonical_run_id TEXT REFERENCES runs(run_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regression_results (
  result_id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES regression_tests(test_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  passed INTEGER NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regression_results_test
  ON regression_results(test_id, created_at DESC);
"""


def ensure_schema(db: sqlite3.Connection) -> None:
    db.executescript("PRAGMA journal_mode = WAL;")
    db.executescript("PRAGMA synchronous = NORMAL;")
    db.executescript("PRAGMA foreign_keys = ON;")
    db.executescript(_DDL)

    # Idempotent column-add for v2+. SQLite has no CREATE-OR-ALTER, so we
    # check PRAGMA table_info before ADDing.
    _ensure_column(
        db,
        "steps",
        "tokens_cache_creation_1h",
        "INTEGER NOT NULL DEFAULT 0",
    )

    cur = db.execute("SELECT value FROM meta WHERE key = 'schema_version'")
    row = cur.fetchone()
    if row is None:
        db.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
    # Do not lower an existing higher version — TS owns migrations.
    db.commit()


def _ensure_column(
    db: sqlite3.Connection, table: str, column: str, ddl: str
) -> None:
    cur = db.execute(f"PRAGMA table_info({table})")
    cols = [r[1] for r in cur.fetchall()]
    if column in cols:
        return
    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
