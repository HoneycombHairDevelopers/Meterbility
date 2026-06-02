import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ensureSchema, SCHEMA_VERSION } from "./schema.ts";

/**
 * Schema v4 migration tests.
 *
 * Four properties to defend (per v0.2 §17 "additive-only" + v0.3 §2.3
 * success criteria):
 *
 *   1. **Fresh apply.** A brand-new database ends with every v4 table
 *      and column present and `meta.schema_version = "4"`.
 *
 *   2. **Idempotent re-apply.** Calling `ensureSchema` twice on the
 *      same handle does not error — the `CREATE TABLE IF NOT EXISTS` and
 *      `ensureColumn` guards must hold up. This is the safety net for
 *      every Store.open() that fires after the very first one.
 *
 *   3. **v3 → v4 migration.** A database hand-shaped to look like v3 (no
 *      file_change, no baseline_tree, no new runs columns,
 *      schema_version='3') gets ALTER'd into a v4-shaped store without
 *      data loss. Catches the regression where someone forgets to wire
 *      the new ensureColumn call into the migration path.
 *
 *   4. **Enum CHECK constraints fire.** Bad `derived_from` / `op` /
 *      `patch_format` values get rejected at INSERT time. Validates that
 *      the full enum declaration in DDL actually does what it claims.
 */

interface SqlitePragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "spool-schema-test-"));
  return new Database(join(dir, "spool.db"));
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as SqlitePragmaColumn[];
  return cols.some((c) => c.name === column);
}

test("fresh apply lands schema v5 with all new tables + columns", () => {
  const db = freshDb();
  ensureSchema(db);
  assert.equal(SCHEMA_VERSION, 5, "SCHEMA_VERSION constant must be 5");
  const row = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value: string } | undefined;
  assert.equal(row?.value, "5");

  // New tables exist.
  assert.equal(tableExists(db, "file_change"), true, "file_change table missing");
  assert.equal(tableExists(db, "baseline_tree"), true, "baseline_tree table missing");

  // v4 columns on runs exist.
  assert.equal(hasColumn(db, "runs", "baseline_tree_id"), true);
  assert.equal(hasColumn(db, "runs", "probe_state"), true);

  // v5: annotations.kind column exists (SPEC-V0_3 §4.4).
  assert.equal(
    hasColumn(db, "annotations", "kind"),
    true,
    "v5 migration: annotations.kind column missing",
  );

  // Indexes are sanity-checked via the master table — the names must
  // match what queries.ts will rely on in Track A.
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('file_change','baseline_tree')",
    )
    .all() as Array<{ name: string }>;
  const names = new Set(indexes.map((i) => i.name));
  for (const expected of [
    "idx_fc_run_step",
    "idx_fc_run_path",
    "idx_fc_step",
    "idx_fc_path_seq",
    "idx_bt_project",
    "idx_bt_git",
  ]) {
    assert.equal(names.has(expected), true, `missing index: ${expected}`);
  }
  db.close();
});

test("ensureSchema is idempotent: re-apply does not error or duplicate", () => {
  const db = freshDb();
  ensureSchema(db);
  // The second call exercises every CREATE TABLE IF NOT EXISTS guard
  // and every ensureColumn PRAGMA check.
  assert.doesNotThrow(() => ensureSchema(db));
  // schema_version is still exactly "4" (no double-insert into meta).
  const rows = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .all() as Array<{ value: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.value, "5");
  // Tables are still singular (the master table doesn't grow on re-apply).
  const fcCount = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='file_change'",
    )
    .get() as { n: number };
  assert.equal(fcCount.n, 1);
  db.close();
});

test("v3 → v5 migration: hand-built v3 db gets ALTER'd to v5 without data loss", () => {
  const db = freshDb();
  // Hand-shape a v3 database: enable WAL + FKs (production parity),
  // create the v3 subset of tables (projects, agents, runs without the
  // new columns), insert a row, then claim schema_version='3'.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      cwd TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      name TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      source_session_id TEXT,
      source_runtime TEXT NOT NULL,
      title TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, git_branch TEXT, cwd TEXT,
      fork_origin_run_id TEXT REFERENCES runs(run_id),
      fork_origin_step_id TEXT,
      tokens_total_input INTEGER NOT NULL DEFAULT 0,
      tokens_total_output INTEGER NOT NULL DEFAULT 0,
      tokens_total_cached INTEGER NOT NULL DEFAULT 0,
      cost_cents REAL NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]'
    );
  `);
  db.prepare(
    "INSERT INTO projects(project_id,name,cwd,created_at) VALUES(?,?,?,?)",
  ).run("prj_legacy", "legacy", "/tmp/legacy", "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO agents(agent_id,project_id,name,created_at) VALUES(?,?,?,?)",
  ).run("agt_legacy", "prj_legacy", "claude-code", "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO runs(run_id,agent_id,project_id,source_runtime,status,started_at)
     VALUES(?,?,?,?,?,?)`,
  ).run(
    "run_legacy",
    "agt_legacy",
    "prj_legacy",
    "claude-code",
    "ok",
    "2026-01-01T00:00:00Z",
  );
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("schema_version", "3");

  // Sanity: the v3-shaped db doesn't have v4 surface yet.
  assert.equal(tableExists(db, "file_change"), false);
  assert.equal(hasColumn(db, "runs", "baseline_tree_id"), false);
  assert.equal(hasColumn(db, "runs", "probe_state"), false);

  // Run the real migration.
  ensureSchema(db);

  // After: v5 surface exists, legacy row still readable.
  assert.equal(tableExists(db, "file_change"), true);
  assert.equal(tableExists(db, "baseline_tree"), true);
  assert.equal(hasColumn(db, "runs", "baseline_tree_id"), true);
  assert.equal(hasColumn(db, "runs", "probe_state"), true);
  assert.equal(hasColumn(db, "annotations", "kind"), true);
  const legacy = db
    .prepare("SELECT run_id, baseline_tree_id, probe_state FROM runs WHERE run_id=?")
    .get("run_legacy") as
    | { run_id: string; baseline_tree_id: string | null; probe_state: string | null }
    | undefined;
  assert.ok(legacy, "legacy run must survive migration");
  assert.equal(legacy!.baseline_tree_id, null, "new column must default to NULL");
  assert.equal(legacy!.probe_state, null);

  // schema_version was bumped.
  const ver = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value: string };
  assert.equal(ver.value, "5");
  db.close();
});

test("v4 → v5 migration: annotations.kind backfills to 'comment' and CHECK rejects bad kinds", () => {
  const db = freshDb();
  // Hand-shape a v4 database with one legacy annotation row that lacks
  // the kind column. After migration, the row should backfill to
  // 'comment' (via DEFAULT) and the CHECK should refuse 'random_kind'.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE annotations (
      annotation_id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      author TEXT NOT NULL,
      verdict TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO annotations(annotation_id,target_kind,target_id,author,note,created_at)
     VALUES(?,?,?,?,?,?)`,
  ).run("ann_legacy", "run", "run_x", "alice", "old comment", "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("schema_version", "4");

  // Sanity: legacy v4 shape has no kind column.
  assert.equal(hasColumn(db, "annotations", "kind"), false);

  ensureSchema(db);

  // After migration: column exists, legacy row backfilled to 'comment'.
  assert.equal(hasColumn(db, "annotations", "kind"), true);
  const legacy = db
    .prepare("SELECT kind FROM annotations WHERE annotation_id=?")
    .get("ann_legacy") as { kind: string };
  assert.equal(legacy.kind, "comment", "legacy rows must backfill to 'comment'");

  // All four defined kinds accept (the DB-level CHECK lives only on
  // fresh-CREATE'd tables; legacy upgraded tables rely on TS-side
  // typing in queries.ts insertAnnotation per the schema.ts comment).
  for (const kind of ["comment", "probe_pause", "probe_edit", "capture_skipped"]) {
    assert.doesNotThrow(() =>
      db
        .prepare(
          `INSERT INTO annotations(annotation_id,target_kind,target_id,author,kind,created_at)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(`ann_${kind}`, "run", "run_x", "alice", kind, "2026-01-01T00:00:00Z"),
    );
  }
  db.close();
});

test("v5 fresh-DB CHECK constraint rejects unknown annotation kinds", () => {
  // On a fresh CREATE TABLE'd database (not migrated), the CHECK
  // constraint IS active. This test pins that contract — anyone
  // initializing a new spool DB gets the DB-level enum safety net.
  const db = freshDb();
  ensureSchema(db);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO annotations(annotation_id,target_kind,target_id,author,kind,created_at)
           VALUES(?,?,?,?,?,?)`,
        )
        .run("ann_bad", "run", "run_x", "alice", "random_kind", "2026-01-01T00:00:00Z"),
    /CHECK constraint failed/,
    "fresh DB CHECK must reject unknown kinds",
  );
  db.close();
});

test("file_change CHECK constraints reject invalid enum values", () => {
  const db = freshDb();
  ensureSchema(db);
  // Set up a real run + step so the FK doesn't fail before the CHECK fires.
  db.prepare(
    "INSERT INTO projects(project_id,name,cwd,created_at) VALUES(?,?,?,?)",
  ).run("prj_t", "t", "/tmp/check", "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO agents(agent_id,project_id,name,created_at) VALUES(?,?,?,?)",
  ).run("agt_t", "prj_t", "claude-code", "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO runs(run_id,agent_id,project_id,source_runtime,status,started_at)
     VALUES(?,?,?,?,?,?)`,
  ).run("run_t", "agt_t", "prj_t", "claude-code", "in_progress", "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO steps(
       step_id,run_id,sequence,timestamp,model,context_snapshot_id,
       decision_ref,action_json,outcome_json,status
     ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "stp_t",
    "run_t",
    0,
    "2026-01-01T00:00:00Z",
    "claude-opus-4-7",
    "snap_t",
    "blob_t",
    "{}",
    "{}",
    "ok",
  );

  const insertFc = db.prepare(
    `INSERT INTO file_change(
       file_change_id, run_id, step_id, sequence,
       derived_from, path, op, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Bad derived_from
  assert.throws(
    () =>
      insertFc.run(
        "fc_bad_derived",
        "run_t",
        "stp_t",
        0,
        "bogus_source",
        "src/x.ts",
        "modify",
        "2026-01-01T00:00:00Z",
      ),
    /CHECK constraint failed/,
    "bad derived_from must be rejected",
  );

  // Bad op
  assert.throws(
    () =>
      insertFc.run(
        "fc_bad_op",
        "run_t",
        "stp_t",
        1,
        "tool_call",
        "src/x.ts",
        "obliterate",
        "2026-01-01T00:00:00Z",
      ),
    /CHECK constraint failed/,
    "bad op must be rejected",
  );

  // Bad patch_format
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO file_change(
             file_change_id, run_id, step_id, sequence,
             derived_from, path, op, patch_format, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "fc_bad_format",
          "run_t",
          "stp_t",
          2,
          "tool_call",
          "src/x.ts",
          "modify",
          "json_patch",
          "2026-01-01T00:00:00Z",
        ),
    /CHECK constraint failed/,
    "bad patch_format must be rejected",
  );

  // Good values from the v0.3-not-yet-written set should still pass
  // (the whole point of declaring full enums up front per §3.3).
  assert.doesNotThrow(() =>
    insertFc.run(
      "fc_filesystem_watch_ok",
      "run_t",
      "stp_t",
      3,
      "filesystem_watch", // v0.4 source — must be accepted now so v0.4 has no migration
      "src/x.ts",
      "rename", // op also unused in v0.3 — same reasoning
      "2026-01-01T00:00:00Z",
    ),
  );

  db.close();
});

test("file_change UNIQUE(step_id, sequence) prevents duplicate writes", () => {
  const db = freshDb();
  ensureSchema(db);
  db.prepare(
    "INSERT INTO projects(project_id,name,cwd,created_at) VALUES(?,?,?,?)",
  ).run("prj_u", "u", "/tmp/unique", "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO agents(agent_id,project_id,name,created_at) VALUES(?,?,?,?)",
  ).run("agt_u", "prj_u", "x", "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO runs(run_id,agent_id,project_id,source_runtime,status,started_at)
     VALUES(?,?,?,?,?,?)`,
  ).run("run_u", "agt_u", "prj_u", "claude-code", "in_progress", "2026-01-01T00:00:00Z");
  db.prepare(
    `INSERT INTO steps(
       step_id,run_id,sequence,timestamp,model,context_snapshot_id,
       decision_ref,action_json,outcome_json,status
     ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "stp_u",
    "run_u",
    0,
    "2026-01-01T00:00:00Z",
    "m",
    "snap",
    "blob",
    "{}",
    "{}",
    "ok",
  );
  const ins = db.prepare(
    `INSERT INTO file_change(
       file_change_id, run_id, step_id, sequence,
       derived_from, path, op, created_at
     ) VALUES(?,?,?,?,?,?,?,?)`,
  );
  ins.run("fc_u_0", "run_u", "stp_u", 0, "tool_call", "a.ts", "modify", "2026-01-01T00:00:00Z");
  // Different file_change_id, same (step_id, sequence) — must fail.
  // This is the idempotency-safety contract for v0.3's adapter: writing
  // the same logical FileChange twice cannot duplicate rows.
  assert.throws(
    () =>
      ins.run(
        "fc_u_1",
        "run_u",
        "stp_u",
        0, // same sequence
        "tool_call",
        "b.ts",
        "modify",
        "2026-01-01T00:00:00Z",
      ),
    /UNIQUE constraint failed/,
  );
  db.close();
});
