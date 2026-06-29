import type Database from "better-sqlite3";

/**
 * Schema — flat tables that map directly onto SPEC §6 entities. JSON
 * columns hold the structured-but-not-indexed parts (action, outcome,
 * tags). Foreign keys are enforced; large content lives in the blob store
 * referenced by SHA256.
 *
 * Migration policy (locked in by SPEC v0.2 §17 and re-affirmed by v0.3
 * §3.3): **additive only**. No renames, no drops, no CHECK-constraint
 * tightening — SQLite can't ALTER a CHECK without a table rebuild, so we
 * declare full enum coverage up front even for values future milestones
 * write. v0.3 only writes `derived_from='tool_call'` and three of the
 * five ops, but the constraint allows all of them so v0.4's file watcher
 * and v0.5's normalizer don't need a migration.
 *
 * Version history:
 *   v1 → v2 — split 5m vs 1h cache write tokens on `steps`
 *   v2 → v3 — settings table for the web UI Settings page
 *   v3 → v4 — file_change, baseline_tree, runs.baseline_tree_id,
 *             runs.probe_state (Track A file capture + Track B Live Probe)
 */
export const SCHEMA_VERSION = 5;

export function ensureSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
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

    -- Stored context snapshots. The 'id' is the SHA256 of the canonicalized
    -- snapshot JSON; the snapshot JSON itself lives in the blob store.
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
      kind TEXT NOT NULL DEFAULT 'comment'
        CHECK (kind IN ('comment', 'probe_pause', 'probe_edit', 'capture_skipped')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_annotations_target
      ON annotations(target_kind, target_id);
    -- idx_annotations_kind is created AFTER ensureColumn below so
    -- legacy v4 DBs (which lack the kind column at executescript
    -- time) don't trip on referencing a column that doesn't exist
    -- yet. For fresh DBs the column is created above so the index
    -- still fires on the same call path, just a few statements later.

    -- Idempotency aid for the Claude Code adapter: remember the last byte
    -- offset we ingested per session file so we can resume cheaply.
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

    -- ─── v0.3 Track A: per-step file change capture ───────────────────
    -- One row per file mutation attributed to a Step. Vendor-neutral —
    -- Claude Code hook adapter writes v0.3; Codex / SDK / proxy / file
    -- watcher fill in additional source paths in v0.4. Path-keyed
    -- queries are core (per v0.3 §3.1.2: "show me every change to
    -- src/auth.ts across this run"), so indexes cover (run_id, path)
    -- as well as the step join.
    --
    -- before_blob_ref / after_blob_ref are content addresses into the
    -- blob store. NULL sentinels carry meaning: NULL before = 'create'
    -- (or partial); NULL after = 'delete' (or partial). The
    -- partial_diff flag distinguishes "we didn't capture this" from
    -- "this side genuinely doesn't exist" so the UI can render the
    -- right affordance.
    --
    -- CHECK constraints declare the full enum even where v0.3 only
    -- writes a subset — see the additive-only note above the schema
    -- version constant.
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
      partial_diff        INTEGER NOT NULL DEFAULT 0,
      gitignored          INTEGER NOT NULL DEFAULT 0,
      patch_text          TEXT,
      patch_format        TEXT
        CHECK (patch_format IN ('unified','binary','notebook_cell')
               OR patch_format IS NULL),
      encoding            TEXT,
      bom                 INTEGER NOT NULL DEFAULT 0,
      line_endings        TEXT,
      mime                TEXT,
      language            TEXT,
      size_before         INTEGER,
      size_after          INTEGER,
      line_count_before   INTEGER,
      line_count_after    INTEGER,
      lines_added         INTEGER NOT NULL DEFAULT 0,
      lines_removed       INTEGER NOT NULL DEFAULT 0,
      mode_before         INTEGER,
      mode_after          INTEGER,
      source_tool_name    TEXT,
      source_tool_input   TEXT,
      redacted            INTEGER NOT NULL DEFAULT 0,
      normalizer_notes    TEXT,
      created_at          TEXT NOT NULL,
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

    -- ─── v0.3 Track A: baseline working tree ──────────────────────────
    -- Content-addressed snapshot of the project's files at Run start,
    -- captured lazily on the first FileChange (per v0.3 §3.5). The
    -- replay algorithm (§3.6) layers FileChange rows on top of this to
    -- compute working_tree_at(run, step) in O(touched_paths) instead of
    -- O(total_files_in_repo).
    --
    -- manifest_blob_ref points at a sorted, NUL-separated, newline-
    -- delimited blob (each record is path + NUL + mode + NUL + blob_ref
    -- followed by a newline). Sortedness gives byte-identical manifests
    -- for identical trees, which dedups via SHA naturally — two runs
    -- against the same git HEAD share one baseline blob.
    --
    -- git_head / git_dirty are advisory metadata only. Meterbility never
    -- depends on git being present.
    CREATE TABLE IF NOT EXISTS baseline_tree (
      baseline_tree_id    TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(project_id),
      manifest_blob_ref   TEXT NOT NULL,
      git_head            TEXT,
      git_dirty           INTEGER NOT NULL DEFAULT 0,
      captured_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bt_project
      ON baseline_tree(project_id);
    CREATE INDEX IF NOT EXISTS idx_bt_git
      ON baseline_tree(project_id, git_head);

    -- Regression suite (v0.1). A test = name + assertion list.
    -- Optionally references a canonical run that originated the test.
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
  `);

  // Apply idempotent column-additions for v2+. SQLite has no
  // CREATE-OR-ALTER, so we check PRAGMA table_info before each ADD.
  ensureColumn(
    db,
    "steps",
    "tokens_cache_creation_1h",
    "INTEGER NOT NULL DEFAULT 0",
  );

  // v3: settings table for the web UI Settings page (Slack webhook,
  // default fork model, watched tools, etc.). Created via the
  // CREATE TABLE IF NOT EXISTS above; no ALTER needed.

  // v4 — Track A: link a run to its baseline working tree. Nullable
  // because legacy runs predate the feature and many runs (research,
  // customer-support, anything that never touches a filesystem) never
  // capture a baseline. Coding-agent runs populate this lazily on the
  // first FileChange.
  ensureColumn(db, "runs", "baseline_tree_id", "TEXT");

  // v4 — Track B: Live Probe pause/resume state. NULL = never probed
  // (the dominant case). 'paused' makes the next tracer.startStep()
  // block; 'resumed' is a transient state set by the resume endpoint
  // and cleared once the next step actually fires. Only meaningful
  // for source_runtime in (sdk-ts, sdk-py) — hook and proxy runs
  // can't be probed cleanly (see v0.3 §4.2).
  ensureColumn(db, "runs", "probe_state", "TEXT");

  // v5 — Annotation `kind` discriminator. Distinguishes human comments
  // (the historical-default) from system-generated event markers
  // emitted by the Live Probe (`probe_pause`, `probe_edit` per
  // SPEC-V0_3 §4.4) and the file-capture size policy
  // (`capture_skipped` per §11.1). Pre-v5 rows get backfilled to
  // 'comment' atomically via the ADD COLUMN ... DEFAULT clause.
  //
  // CHECK constraint nuance: SQLite's ALTER TABLE ADD COLUMN does
  // NOT accept inline CHECK clauses; the constraint engine only
  // wires CHECKs at CREATE time. So:
  //   - Fresh DBs: CHECK lives on the CREATE TABLE above. Database
  //     enforcement of the kind enum is the safety net.
  //   - Legacy DBs upgraded via ALTER: column exists but DB-level
  //     CHECK does NOT. Application-level validation in
  //     queries.ts insertAnnotation (typed `kind: AnnotationKind`)
  //     carries the enforcement.
  // Standard SQLite migration pattern; rebuilding the table to add
  // the CHECK would cost a table-copy on every upgrade for a
  // column whose enum is already typed at the API layer.
  ensureColumn(
    db,
    "annotations",
    "kind",
    "TEXT NOT NULL DEFAULT 'comment'",
  );
  // Index AFTER ensureColumn — see the note in the CREATE TABLE block.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_annotations_kind ON annotations(kind)",
  );

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(
      "schema_version",
      String(SCHEMA_VERSION),
    );
  } else if (Number(row.value) < SCHEMA_VERSION) {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION),
    );
  }
}

interface SqlitePragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as SqlitePragmaColumn[];
  if (cols.find((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
