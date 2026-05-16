import type { Client } from "pg";

/**
 * Postgres schema mirroring `@spool/collector` (SQLite). Same column
 * names, same semantics. Differences:
 *   - JSON columns use `jsonb` (queryable + indexable later).
 *   - Timestamps use `timestamptz` rather than free-form text.
 *   - Indexes are explicit; SQLite's `WAL` / `synchronous` pragmas have
 *     no Postgres equivalent and aren't applied.
 *
 * Designed for Spool's hosted/team tier (SPEC §15.3). Local mode keeps
 * the SQLite store as default; this exists for the deployments where
 * multiple operators share a project's run history.
 */
/**
 * Version history (mirrors `@spool/collector` SCHEMA_VERSION):
 *   v3 → v4 — file_change + baseline_tree tables, runs.baseline_tree_id,
 *             runs.probe_state. Per v0.3 §3.3, full enum coverage in
 *             CHECK constraints up front so v0.4 / v0.5 don't need
 *             migrations as new derived_from / op values come online.
 *             Additive-only per v0.2 §17.
 */
export const POSTGRES_SCHEMA_VERSION = 4;

export async function ensurePostgresSchema(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
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
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      git_branch TEXT,
      cwd TEXT,
      fork_origin_run_id TEXT REFERENCES runs(run_id),
      fork_origin_step_id TEXT,
      tokens_total_input BIGINT NOT NULL DEFAULT 0,
      tokens_total_output BIGINT NOT NULL DEFAULT 0,
      tokens_total_cached BIGINT NOT NULL DEFAULT 0,
      cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb
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
      timestamp TIMESTAMPTZ NOT NULL,
      model TEXT NOT NULL,
      context_snapshot_id TEXT NOT NULL,
      decision_ref TEXT NOT NULL,
      action JSONB NOT NULL,
      outcome JSONB NOT NULL,
      tokens_input BIGINT NOT NULL DEFAULT 0,
      tokens_output BIGINT NOT NULL DEFAULT 0,
      tokens_cached_read BIGINT NOT NULL DEFAULT 0,
      tokens_cache_creation BIGINT NOT NULL DEFAULT 0,
      tokens_cache_creation_1h BIGINT NOT NULL DEFAULT 0,
      tokens_reasoning BIGINT,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
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
      created_at TIMESTAMPTZ NOT NULL
    );

    -- Blob content is stored inline as bytea in Postgres mode (no
    -- separate filesystem layer). Use BlobStore.put / .get on the store.
    CREATE TABLE IF NOT EXISTS blobs (
      blob_ref TEXT PRIMARY KEY,
      content BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forks (
      fork_id TEXT PRIMARY KEY,
      origin_run_id TEXT NOT NULL REFERENCES runs(run_id),
      origin_step_id TEXT NOT NULL,
      fork_run_id TEXT NOT NULL REFERENCES runs(run_id),
      edit_type TEXT NOT NULL,
      edit_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
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
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_annotations_target
      ON annotations(target_kind, target_id);

    CREATE TABLE IF NOT EXISTS regression_tests (
      test_id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      assertions JSONB NOT NULL,
      canonical_run_id TEXT REFERENCES runs(run_id),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regression_results (
      result_id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL REFERENCES regression_tests(test_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      passed BOOLEAN NOT NULL,
      details JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_regression_results_test
      ON regression_results(test_id, created_at DESC);

    -- ─── v0.3 Track A: per-step file change capture (mirror) ──────────
    -- See packages/collector/src/schema.ts for the design rationale.
    CREATE TABLE IF NOT EXISTS file_change (
      file_change_id      TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      step_id             TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
      sequence            INTEGER NOT NULL,
      tool_call_id        TEXT,
      derived_from        TEXT NOT NULL
        CHECK (derived_from IN ('tool_call','filesystem_watch','git_diff')),
      path                TEXT NOT NULL,
      old_path            TEXT,
      op                  TEXT NOT NULL
        CHECK (op IN ('create','modify','delete','rename','chmod')),
      before_blob_ref     TEXT,
      after_blob_ref      TEXT,
      partial_diff        BOOLEAN NOT NULL DEFAULT FALSE,
      gitignored          BOOLEAN NOT NULL DEFAULT FALSE,
      patch_text          TEXT,
      patch_format        TEXT
        CHECK (patch_format IN ('unified','binary','notebook_cell')
               OR patch_format IS NULL),
      encoding            TEXT,
      bom                 BOOLEAN NOT NULL DEFAULT FALSE,
      line_endings        TEXT,
      mime                TEXT,
      language            TEXT,
      size_before         BIGINT,
      size_after          BIGINT,
      line_count_before   INTEGER,
      line_count_after    INTEGER,
      lines_added         INTEGER NOT NULL DEFAULT 0,
      lines_removed       INTEGER NOT NULL DEFAULT 0,
      mode_before         INTEGER,
      mode_after          INTEGER,
      source_tool_name    TEXT,
      source_tool_input   JSONB,
      redacted            BOOLEAN NOT NULL DEFAULT FALSE,
      normalizer_notes    JSONB,
      created_at          TIMESTAMPTZ NOT NULL,
      UNIQUE(step_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_fc_run_step
      ON file_change(run_id, step_id);
    CREATE INDEX IF NOT EXISTS idx_fc_run_path
      ON file_change(run_id, path);
    CREATE INDEX IF NOT EXISTS idx_fc_step
      ON file_change(step_id);
    CREATE INDEX IF NOT EXISTS idx_fc_path_seq
      ON file_change(run_id, path, step_id);

    -- ─── v0.3 Track A: baseline working tree (mirror) ─────────────────
    CREATE TABLE IF NOT EXISTS baseline_tree (
      baseline_tree_id    TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(project_id),
      manifest_blob_ref   TEXT NOT NULL,
      git_head            TEXT,
      git_dirty           BOOLEAN NOT NULL DEFAULT FALSE,
      captured_at         TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bt_project
      ON baseline_tree(project_id);
    CREATE INDEX IF NOT EXISTS idx_bt_git
      ON baseline_tree(project_id, git_head);
  `);

  // Migrations from v2 → v3. ALTER TABLE ADD COLUMN IF NOT EXISTS is
  // standard Postgres, so this is naturally idempotent.
  await client.query(
    "ALTER TABLE steps ADD COLUMN IF NOT EXISTS tokens_cache_creation_1h BIGINT NOT NULL DEFAULT 0",
  );

  // v4 — Track A: link a run to its baseline working tree (nullable).
  await client.query(
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS baseline_tree_id TEXT",
  );
  // v4 — Track B: Live Probe state (NULL = never probed).
  await client.query(
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS probe_state TEXT",
  );

  const versionRow = await client.query(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  );
  if (versionRow.rowCount === 0) {
    await client.query(
      "INSERT INTO meta(key,value) VALUES ($1,$2)",
      ["schema_version", String(POSTGRES_SCHEMA_VERSION)],
    );
  } else if (Number(versionRow.rows[0].value) < POSTGRES_SCHEMA_VERSION) {
    await client.query(
      "UPDATE meta SET value = $1 WHERE key = 'schema_version'",
      [String(POSTGRES_SCHEMA_VERSION)],
    );
  }
}
