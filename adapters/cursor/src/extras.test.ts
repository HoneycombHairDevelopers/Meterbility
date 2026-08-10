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
