import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns, listSteps } from "@meterbility/collector";
import { handleCursorHookEvent } from "./hooks.ts";

function freshHome(): void {
  process.env.METERBILITY_HOME = mkdtempSync(join(tmpdir(), "meter-cursor-hooks-"));
}

test("afterFileEdit creates run + step + file_change rows, joined on conversation_id", async () => {
  freshHome();
  const store = Store.open();
  const res = await handleCursorHookEvent(store, {
    hook_event_name: "afterFileEdit",
    conversation_id: "comp-hook-1",
    generation_id: "gen-1",
    workspace_roots: ["/tmp/proj"],
    file_path: "/tmp/proj/src/app.ts",
    edits: [
      { old_string: "const a = 1", new_string: "const a = 2" },
      { old_string: "let b", new_string: "const b" },
    ],
  });
  assert.equal(res.handled, true);
  assert.equal(res.file_changes, 2);

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.source_session_id, "comp-hook-1");
  assert.equal(runs[0]!.cwd, "/tmp/proj");
  assert.ok(runs[0]!.tags.includes("cursor-hook"));

  const fc = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ? ORDER BY sequence`)
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(fc.length, 2);
  assert.equal(fc[0]!.path, "src/app.ts");
  assert.equal(fc[0]!.op, "modify");
  assert.equal(fc[0]!.partial_diff, 1);
  assert.ok(String(fc[0]!.patch_text).includes("+const a = 2"));
  assert.equal(fc[0]!.source_tool_name, "afterFileEdit");
  store.close();
});

test("afterFileEdit is idempotent per (generation, path, edit)", async () => {
  freshHome();
  const store = Store.open();
  const payload = {
    hook_event_name: "afterFileEdit",
    conversation_id: "comp-hook-2",
    generation_id: "gen-2",
    workspace_roots: ["/tmp/p2"],
    file_path: "/tmp/p2/x.ts",
    edits: [{ old_string: "a", new_string: "b" }],
  };
  const first = await handleCursorHookEvent(store, payload);
  const second = await handleCursorHookEvent(store, payload);
  assert.equal(first.file_changes, 1);
  assert.equal(second.file_changes, 0, "same event re-delivered inserts nothing");
  const runs = listRuns(store);
  const n = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM file_change WHERE run_id = ?`)
      .get(runs[0]!.run_id) as { n: number }
  ).n;
  assert.equal(n, 1);
  store.close();
});

test("beforeShellExecution records the command and always answers allow", async () => {
  freshHome();
  const store = Store.open();
  const res = await handleCursorHookEvent(store, {
    hook_event_name: "beforeShellExecution",
    conversation_id: "comp-hook-3",
    generation_id: "gen-3",
    workspace_roots: ["/tmp/p3"],
    command: "npm test",
    cwd: "/tmp/p3",
  });
  assert.equal(res.handled, true);
  assert.deepEqual(res.response, { continue: true, permission: "allow" });
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.action.tool_name, "beforeShellExecution");
  assert.deepEqual(steps[0]!.action.tool_input, {
    command: "npm test",
    cwd: "/tmp/p3",
  });
  // Hook steps live above the DB adapter's sequence space.
  assert.ok(steps[0]!.sequence >= 100_000);
  store.close();
});

test("stop seals the run with the mapped status", async () => {
  freshHome();
  const store = Store.open();
  await handleCursorHookEvent(store, {
    hook_event_name: "beforeShellExecution",
    conversation_id: "comp-hook-4",
    workspace_roots: ["/tmp/p4"],
    command: "ls",
  });
  const res = await handleCursorHookEvent(store, {
    hook_event_name: "stop",
    conversation_id: "comp-hook-4",
    status: "completed",
  });
  assert.equal(res.handled, true);
  const runs = listRuns(store);
  assert.equal(runs[0]!.status, "ok");
  store.close();
});

test("unknown events and missing conversation_id are ignored, never throw", async () => {
  freshHome();
  const store = Store.open();
  const unknown = await handleCursorHookEvent(store, {
    hook_event_name: "somethingNew",
    conversation_id: "c",
  });
  assert.equal(unknown.handled, false);
  const missing = await handleCursorHookEvent(store, {
    hook_event_name: "afterFileEdit",
  });
  assert.equal(missing.handled, false);
  assert.equal(listRuns(store).length, 0);
  store.close();
});

test("hook steps survive DB-ingest reconciliation (bounded trims/offsets)", async () => {
  freshHome();
  const store = Store.open();
  const { mkdtempSync: mkTmp } = await import("node:fs");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  const Database = (await import("better-sqlite3")).default;

  // 1. Hook event arrives first (real-time plane).
  await handleCursorHookEvent(store, {
    hook_event_name: "afterFileEdit",
    conversation_id: "comp-mixed",
    generation_id: "gen-x",
    workspace_roots: ["/tmp/mixed"],
    file_path: "/tmp/mixed/a.ts",
    edits: [{ old_string: "1", new_string: "2" }],
  });

  // 2. DB ingest of the same composer (batch plane) — twice, to run
  //    reconciliation against existing rows.
  const dir = mkTmp(j(tmp(), "cursor-mixed-"));
  const dbPath = j(dir, "state.vscdb");
  const cdb = new Database(dbPath);
  cdb.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const ins = cdb.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  ins.run(
    "composerData:comp-mixed",
    JSON.stringify({
      _v: 10,
      composerId: "comp-mixed",
      name: "mixed planes",
      status: "completed",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }],
      text: "mixed planes",
      unifiedMode: "agent",
    }),
  );
  ins.run(
    "bubbleId:comp-mixed:u1",
    JSON.stringify({ _v: 3, bubbleId: "u1", type: 1, text: "hi", createdAt: new Date().toISOString() }),
  );
  cdb.close();

  const { ingestCursorGlobal } = await import("./ingest.ts");
  await ingestCursorGlobal(store, { dbPath });
  await ingestCursorGlobal(store, { dbPath }); // reconcile pass

  const runs = listRuns(store);
  assert.equal(runs.length, 1, "hook run and DB run merged on conversation_id");
  const steps = listSteps(store, runs[0]!.run_id);
  const hookSteps = steps.filter((s) => s.sequence >= 100_000);
  const walkSteps = steps.filter((s) => s.sequence < 100_000);
  assert.equal(hookSteps.length, 1, "hook step survived reconciliation trims");
  assert.equal(walkSteps.length, 1, "bubble walk ingested normally");
  const fcCount = (
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM file_change WHERE run_id = ?`)
      .get(runs[0]!.run_id) as { n: number }
  ).n;
  assert.equal(fcCount, 1, "hook file_change not cascade-deleted");
  store.close();
});
