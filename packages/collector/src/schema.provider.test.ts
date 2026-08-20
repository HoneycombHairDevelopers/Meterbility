import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ensureSchema } from "./schema.ts";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "meter-schema-provider-test-"));
  return new Database(join(dir, "meterbility.db"));
}

/**
 * v6 migration — runs.provider + steps.provider (proxy multi-upstream).
 * Legacy DBs gain the columns via the additive ensureColumn path;
 * fresh DBs get them in the CREATE TABLE. Both must converge and both
 * must be idempotent.
 */

interface PragmaCol {
  name: string;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as PragmaCol[]).map((c) => c.name);
}

test("fresh DB has provider columns on runs and steps", () => {
  const db = freshDb();
  ensureSchema(db);
  assert.ok(columns(db, "runs").includes("provider"));
  assert.ok(columns(db, "steps").includes("provider"));
  assert.ok(columns(db, "runs").includes("upstream_host"));
  db.close();
});

test("legacy (pre-v6) DB gains provider columns idempotently", () => {
  const db = freshDb();
  // Minimal pre-v6 shape: runs/steps WITHOUT the provider column, plus
  // the meta table ensureSchema reads. CREATE TABLE IF NOT EXISTS in
  // ensureSchema will skip these, so ensureColumn must do the work.
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_session_id TEXT,
      source_runtime TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      git_branch TEXT,
      cwd TEXT,
      fork_origin_run_id TEXT,
      fork_origin_step_id TEXT,
      tokens_total_input INTEGER NOT NULL DEFAULT 0,
      tokens_total_output INTEGER NOT NULL DEFAULT 0,
      tokens_total_cached INTEGER NOT NULL DEFAULT 0,
      cost_cents REAL NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]'
    );
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
      latency_ms INTEGER NOT NULL DEFAULT 0,
      cost_cents REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      UNIQUE(run_id, sequence)
    );
    INSERT INTO runs(run_id, agent_id, project_id, source_runtime, status, started_at)
      VALUES ('run_legacy', 'agt_x', 'prj_x', 'proxy', 'ok', '2026-01-01T00:00:00Z');
  `);
  assert.ok(!columns(db, "runs").includes("provider"), "precondition: legacy shape");

  ensureSchema(db);
  assert.ok(columns(db, "runs").includes("provider"));
  assert.ok(columns(db, "steps").includes("provider"));
  assert.ok(columns(db, "runs").includes("upstream_host"));

  // Legacy row survives with NULL provider.
  const row = db
    .prepare("SELECT provider FROM runs WHERE run_id = 'run_legacy'")
    .get() as { provider: string | null };
  assert.equal(row.provider, null);

  // Idempotent: a second pass must not throw or duplicate.
  ensureSchema(db);
  assert.equal(
    columns(db, "runs").filter((c) => c === "provider").length,
    1,
  );
  db.close();
});
