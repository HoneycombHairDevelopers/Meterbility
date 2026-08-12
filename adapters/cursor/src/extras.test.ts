import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store, listRuns, listSteps } from "@meterbility/collector";
import { ingestCursorGlobal } from "./ingest.ts";
import { CHECKPOINT_SEQUENCE_BASE } from "./extras.ts";

function freshHome(): void {
  process.env.METERBILITY_HOME = mkdtempSync(join(tmpdir(), "meter-cursor-extras-"));
}

/**
 * Fixture: one composer whose only tool call touches src/covered.ts,
 * a checkpoint that references BOTH src/covered.ts (already captured —
 * must be skipped) and src/orphan.ts (captured by nothing else — the
 * fallback row), and an aiCodeTrackingLines ledger with entries for
 * this composer plus noise (tab entries, другой composer).
 */
function buildDb(opts: { withItemTable?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-extras-fixture-"));
  const path = join(dir, "state.vscdb");
  const db = new Database(path);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const ins = db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");

  ins.run(
    "composerData:comp-x",
    JSON.stringify({
      _v: 10,
      composerId: "comp-x",
      name: "extras test",
      status: "completed",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      fullConversationHeadersOnly: [{ bubbleId: "a1", type: 2 }],
      text: "extras test",
      unifiedMode: "agent",
    }),
  );
  ins.run(
    "bubbleId:comp-x:a1",
    JSON.stringify({
      _v: 3,
      bubbleId: "a1",
      type: 2,
      text: "",
      createdAt: new Date().toISOString(),
      toolFormerData: {
        name: "search_replace",
        tool: 0,
        status: "completed",
        params: JSON.stringify({ relativeWorkspacePath: "src/covered.ts" }),
        result: JSON.stringify({
          diff: {
            chunks: [{ diffString: "@@ -1 +1 @@\n-a\n+b", linesAdded: 1, linesRemoved: 1 }],
          },
        }),
      },
    }),
  );
  ins.run(
    "checkpointId:comp-x:ckpt-uuid-1",
    JSON.stringify({
      files: [
        {
          uri: { path: "/tmp/extras-proj/src/covered.ts" },
          isNewlyCreated: false,
          originalModelDiffWrtV0: [
            { original: { startLineNumber: 1, endLineNumberExclusive: 2 }, modified: ["b"] },
          ],
        },
        {
          uri: { path: "/tmp/extras-proj/src/orphan.ts" },
          isNewlyCreated: true,
          originalModelDiffWrtV0: [
            {
              original: { startLineNumber: 0, endLineNumberExclusive: 0 },
              modified: ["export const x = 1;", "export const y = 2;"],
            },
          ],
        },
      ],
    }),
  );

  if (opts.withItemTable !== false) {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);");
    db.prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run(
      "aiCodeTrackingLines",
      JSON.stringify([
        { hash: "h1", metadata: { composerId: "comp-x", fileName: "src/covered.ts", source: "composer" } },
        { hash: "h2", metadata: { composerId: "comp-x", fileName: "src/covered.ts", source: "composer" } },
        { hash: "h3", metadata: { composerId: "comp-x", fileName: "src/orphan.ts", source: "composer" } },
        { hash: "h4", metadata: { composerId: "", fileName: "tab.ts", source: "tab" } },
        { hash: "h5", metadata: { composerId: "comp-other", fileName: "z.ts", source: "composer" } },
      ]),
    );
  }
  db.close();
  return path;
}

test("checkpoints add fallback rows only for uncovered paths; ledger becomes an annotation", async () => {
  freshHome();
  const store = Store.open();
  const dbPath = buildDb();
  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/extras-proj" });

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  const runId = runs[0]!.run_id;

  const fc = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ? ORDER BY path`)
    .all(runId) as Array<Record<string, unknown>>;
  // covered.ts once (from toolFormerData), orphan.ts once (checkpoint fallback).
  assert.equal(fc.length, 2);
  const covered = fc.filter((r) => r.path === "src/covered.ts");
  assert.equal(covered.length, 1, "checkpoint did NOT duplicate the covered path");
  assert.equal(covered[0]!.source_tool_name, "search_replace");

  const orphan = fc.find((r) => r.path === "src/orphan.ts")!;
  assert.equal(orphan.source_tool_name, "cursor-checkpoint");
  assert.equal(orphan.op, "create", "isNewlyCreated → create");
  assert.equal(orphan.partial_diff, 1);
  assert.equal(orphan.lines_added, 2);
  assert.ok(String(orphan.patch_text).includes("+export const x = 1;"));

  // Checkpoint step lives in the protected band.
  const steps = listSteps(store, runId);
  const ckptStep = steps.find((s) => s.tags.includes("cursor-checkpoint"))!;
  assert.ok(
    ckptStep.sequence >= CHECKPOINT_SEQUENCE_BASE && ckptStep.sequence < 1_000_000,
  );

  // Ledger annotation: comp-x entries only (3 lines, 2 files).
  const ann = store.db
    .prepare(`SELECT * FROM annotations WHERE target_id = ? AND author = 'meter/cursor-tracking'`)
    .all(runId) as Array<Record<string, unknown>>;
  assert.equal(ann.length, 1);
  assert.match(String(ann[0]!.note), /3 across 2 file\(s\)/);
  assert.ok(!String(ann[0]!.note).includes("z.ts"), "other composers' entries excluded");
  store.close();
});

test("extras are idempotent across re-ingests (rows, steps, annotation all stable)", async () => {
  freshHome();
  const store = Store.open();
  const dbPath = buildDb();
  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/extras-proj" });
  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/extras-proj" });
  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/extras-proj" });

  const runs = listRuns(store);
  const runId = runs[0]!.run_id;
  const fcN = (
    store.db.prepare(`SELECT COUNT(*) AS n FROM file_change WHERE run_id = ?`).get(runId) as { n: number }
  ).n;
  assert.equal(fcN, 2);
  const annN = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM annotations WHERE target_id = ? AND author = 'meter/cursor-tracking'`)
      .get(runId) as { n: number }
  ).n;
  assert.equal(annN, 1, "one annotation, refreshed not duplicated");
  const ckptSteps = listSteps(store, runId).filter((s) =>
    s.tags.includes("cursor-checkpoint"),
  );
  assert.equal(ckptSteps.length, 1);
  store.close();
});

test("missing ItemTable degrades silently (no annotation, no throw)", async () => {
  freshHome();
  const store = Store.open();
  const dbPath = buildDb({ withItemTable: false });
  const r = await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/extras-proj" });
  assert.equal(r.status, "ok");
  const runs = listRuns(store);
  const annN = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM annotations WHERE target_id = ?`)
      .get(runs[0]!.run_id) as { n: number }
  ).n;
  assert.equal(annN, 0);
  store.close();
});

test("checkpoint fallback row is superseded (deleted) once a tool channel covers the path", async () => {
  freshHome();
  const store = Store.open();

  // Pass 1: composer has only a user bubble; the checkpoint is the sole
  // evidence for src/late.ts → fallback row inserted.
  const dir = mkdtempSync(join(tmpdir(), "cursor-supersede-"));
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const ins = db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  const composerData = {
    _v: 10,
    composerId: "comp-s",
    name: "supersede test",
    status: "completed",
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
    fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }],
    text: "supersede test",
    unifiedMode: "agent",
  };
  ins.run("composerData:comp-s", JSON.stringify(composerData));
  ins.run(
    "bubbleId:comp-s:u1",
    JSON.stringify({
      _v: 3,
      bubbleId: "u1",
      type: 1,
      text: "hi",
      createdAt: new Date().toISOString(),
    }),
  );
  ins.run(
    "checkpointId:comp-s:ckpt-uuid-9",
    JSON.stringify({
      files: [
        {
          uri: { path: "/tmp/supersede-proj/src/late.ts" },
          isNewlyCreated: false,
          originalModelDiffWrtV0: [
            { original: { startLineNumber: 1, endLineNumberExclusive: 2 }, modified: ["x"] },
          ],
        },
      ],
    }),
  );
  db.close();

  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/supersede-proj" });
  const runId = listRuns(store)[0]!.run_id;
  const before = store.db
    .prepare(`SELECT source_tool_name FROM file_change WHERE run_id = ? AND path = 'src/late.ts'`)
    .all(runId) as Array<{ source_tool_name: string }>;
  assert.equal(before.length, 1);
  assert.equal(before[0]!.source_tool_name, "cursor-checkpoint");

  // Pass 2: the tool row for the same path shows up (retention un-lag /
  // late toolFormerData flush) — the checkpoint fallback must yield.
  const db2 = new Database(dbPath);
  const ins2 = db2.prepare(
    "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?)",
  );
  ins2.run(
    "composerData:comp-s",
    JSON.stringify({
      ...composerData,
      fullConversationHeadersOnly: [
        { bubbleId: "u1", type: 1 },
        { bubbleId: "a1", type: 2 },
      ],
    }),
  );
  ins2.run(
    "bubbleId:comp-s:a1",
    JSON.stringify({
      _v: 3,
      bubbleId: "a1",
      type: 2,
      text: "",
      createdAt: new Date().toISOString(),
      toolFormerData: {
        name: "search_replace",
        tool: 0,
        status: "completed",
        params: JSON.stringify({ relativeWorkspacePath: "src/late.ts" }),
        result: JSON.stringify({
          diff: { chunks: [{ diffString: "@@ -1 +1 @@\n-x\n+y", linesAdded: 1, linesRemoved: 1 }] },
        }),
      },
    }),
  );
  db2.close();

  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/supersede-proj" });
  const after = store.db
    .prepare(`SELECT source_tool_name FROM file_change WHERE run_id = ? AND path = 'src/late.ts'`)
    .all(runId) as Array<{ source_tool_name: string }>;
  assert.equal(after.length, 1, "exactly one row for the path — no double-count");
  assert.equal(
    after[0]!.source_tool_name,
    "search_replace",
    "tool-attributed row superseded the checkpoint fallback",
  );
  store.close();
});

test("checkpoint ingestion is skipped entirely for '(cursor)' placeholder cwd", async () => {
  freshHome();
  const store = Store.open();
  // No cwd option and no composerHeaders → run.cwd = "(cursor)". Path
  // canonicalization against absolute checkpoint URIs is impossible, so
  // checkpoints must not double-count.
  const dbPath = buildDb();
  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  assert.equal(runs[0]!.cwd, "(cursor)");
  const ckptRows = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM file_change WHERE run_id = ? AND source_tool_name = 'cursor-checkpoint'`,
    )
    .get(runs[0]!.run_id) as { n: number };
  assert.equal(ckptRows.n, 0, "no checkpoint rows for placeholder cwd");
  const ckptSteps = listSteps(store, runs[0]!.run_id).filter((s) =>
    s.tags.includes("cursor-checkpoint"),
  );
  assert.equal(ckptSteps.length, 0);
  store.close();
});

test("checkpoint fallback patch_text is redacted before it hits SQLite", async () => {
  freshHome();
  const store = Store.open();
  const key =
    "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  const dir = mkdtempSync(join(tmpdir(), "cursor-ckpt-redact-"));
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const ins = db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  ins.run(
    "composerData:comp-r",
    JSON.stringify({
      _v: 10,
      composerId: "comp-r",
      name: "redact test",
      status: "completed",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }],
      text: "redact test",
      unifiedMode: "agent",
    }),
  );
  ins.run(
    "bubbleId:comp-r:u1",
    JSON.stringify({
      _v: 3,
      bubbleId: "u1",
      type: 1,
      text: "hi",
      createdAt: new Date().toISOString(),
    }),
  );
  // Checkpoint is the ONLY evidence for .env — its edit script carries
  // the secret in the modified lines.
  ins.run(
    "checkpointId:comp-r:ckpt-uuid-r",
    JSON.stringify({
      files: [
        {
          uri: { path: "/tmp/redact-proj/.env" },
          isNewlyCreated: true,
          originalModelDiffWrtV0: [
            {
              original: { startLineNumber: 0, endLineNumberExclusive: 0 },
              modified: [`ANTHROPIC_API_KEY=${key}`],
            },
          ],
        },
      ],
    }),
  );
  db.close();

  await ingestCursorGlobal(store, { dbPath, cwd: "/tmp/redact-proj" });
  const runId = listRuns(store)[0]!.run_id;
  const fc = store.db
    .prepare(
      `SELECT patch_text FROM file_change WHERE run_id = ? AND source_tool_name = 'cursor-checkpoint'`,
    )
    .get(runId) as { patch_text: string };
  assert.ok(fc, "checkpoint fallback row exists");
  assert.ok(!fc.patch_text.includes("sk-ant-"), "raw secret absent");
  assert.ok(
    fc.patch_text.includes("«meter:redacted:"),
    "redaction placeholder present",
  );
  store.close();
});
