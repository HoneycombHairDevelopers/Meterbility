import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store, listRuns, listSteps } from "@spool-ai/collector";
import { ingestCursorGlobal } from "./ingest.ts";

function freshSpoolHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-cursor-"));
  process.env.SPOOL_HOME = dir;
  return dir;
}

/**
 * Build a synthetic Cursor `state.vscdb` with the same shape Cursor
 * itself emits — `cursorDiskKV` table with `composerData:` and
 * `bubbleId:` rows. The fields we set are the ones the adapter reads;
 * the rest of the schema is allowed to be missing.
 */
function buildCursorDb(args: {
  composers: Array<{
    id: string;
    name?: string;
    status?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    headers: Array<{ bubbleId: string; type: 1 | 2 }>;
    bubbles: Array<{
      bubbleId: string;
      type: 1 | 2;
      text?: string;
      createdAt?: string;
      tokens?: { input: number; output: number };
      tool?: { name: string; rawArgs?: string; result?: unknown; status?: string };
    }>;
  }>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-fixture-"));
  const path = join(dir, "state.vscdb");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  for (const c of args.composers) {
    const composerData = {
      _v: 10,
      composerId: c.id,
      name: c.name,
      status: c.status ?? "completed",
      createdAt: c.createdAt ?? Date.now(),
      lastUpdatedAt: c.lastUpdatedAt ?? Date.now(),
      fullConversationHeadersOnly: c.headers,
      text: c.name ?? "",
      unifiedMode: "agent",
    };
    insert.run(`composerData:${c.id}`, JSON.stringify(composerData));
    for (const b of c.bubbles) {
      const bubble: Record<string, unknown> = {
        _v: 3,
        bubbleId: b.bubbleId,
        type: b.type,
        text: b.text ?? "",
        createdAt: b.createdAt ?? new Date().toISOString(),
        tokenCount: b.tokens
          ? { inputTokens: b.tokens.input, outputTokens: b.tokens.output }
          : undefined,
      };
      if (b.tool) {
        bubble.toolFormerData = {
          name: b.tool.name,
          tool: 0,
          rawArgs: b.tool.rawArgs ?? "{}",
          status: b.tool.status ?? "completed",
          result: b.tool.result,
        };
      }
      insert.run(
        `bubbleId:${c.id}:${b.bubbleId}`,
        JSON.stringify(bubble),
      );
    }
  }
  db.close();
  return path;
}

test("ingest one composer with user + assistant tool call + assistant message", async () => {
  freshSpoolHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-1",
        name: "Refactor login",
        createdAt: Date.parse("2026-04-01T12:00:00Z"),
        lastUpdatedAt: Date.parse("2026-04-01T12:30:00Z"),
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
          { bubbleId: "a2", type: 2 },
        ],
        bubbles: [
          {
            bubbleId: "u1",
            type: 1,
            text: "Refactor LoginScreen to use hooks",
            createdAt: "2026-04-01T12:00:00.000Z",
          },
          {
            bubbleId: "a1",
            type: 2,
            createdAt: "2026-04-01T12:00:05.000Z",
            tokens: { input: 50, output: 10 },
            tool: {
              name: "read_file",
              rawArgs: '{"target_file":"LoginScreen.tsx"}',
              result: "import React from 'react'",
              status: "completed",
            },
          },
          {
            bubbleId: "a2",
            type: 2,
            text: "Refactored — 12 lines changed.",
            createdAt: "2026-04-01T12:00:30.000Z",
            tokens: { input: 80, output: 20 },
          },
        ],
      },
    ],
  });

  const store = Store.open();
  const r = await ingestCursorGlobal(store, { dbPath });
  assert.equal(r.status, "ok");
  assert.equal(r.composers_ingested, 1);
  assert.equal(r.steps_added, 3);

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.title, "Refactor login");
  assert.equal(runs[0]!.source_runtime, "cursor");
  assert.equal(runs[0]!.status, "ok");

  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.action.kind, "message");
  assert.equal(steps[0]!.action.text, "Refactor LoginScreen to use hooks");
  assert.equal(steps[1]!.action.kind, "tool_call");
  assert.equal(steps[1]!.action.tool_name, "read_file");
  assert.deepEqual(steps[1]!.action.tool_input, { target_file: "LoginScreen.tsx" });
  assert.ok(steps[1]!.outcome.tool_result_ref);
  assert.equal(steps[2]!.action.kind, "message");
  assert.equal(steps[2]!.tokens.input, 80);
  store.close();
});

test("erroed tool propagates to step status", async () => {
  freshSpoolHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-err",
        headers: [
          { bubbleId: "u", type: 1 },
          { bubbleId: "a", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u", type: 1, text: "do a broken thing" },
          {
            bubbleId: "a",
            type: 2,
            tool: {
              name: "broken_tool",
              status: "errored",
              result: "permission denied",
            },
          },
        ],
      },
    ],
  });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  const toolStep = steps.find((s) => s.action.kind === "tool_call");
  assert.equal(toolStep?.status, "error");
  assert.equal(toolStep?.outcome.is_error, true);
  store.close();
});

test("missing db returns no_db status, no throw", async () => {
  freshSpoolHome();
  const store = Store.open();
  const r = await ingestCursorGlobal(store, { dbPath: "/nope/state.vscdb" });
  assert.equal(r.status, "no_db");
  assert.match(r.reason ?? "", /cannot open/);
  store.close();
});

test("limit + since options filter composers", async () => {
  freshSpoolHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "old",
        name: "old",
        lastUpdatedAt: Date.parse("2025-01-01T00:00:00Z"),
        headers: [{ bubbleId: "u", type: 1 }],
        bubbles: [{ bubbleId: "u", type: 1, text: "old" }],
      },
      {
        id: "new",
        name: "new",
        lastUpdatedAt: Date.parse("2026-05-01T00:00:00Z"),
        headers: [{ bubbleId: "u", type: 1 }],
        bubbles: [{ bubbleId: "u", type: 1, text: "new" }],
      },
    ],
  });
  const store = Store.open();
  const r = await ingestCursorGlobal(store, {
    dbPath,
    sinceMs: Date.parse("2026-01-01T00:00:00Z"),
  });
  assert.equal(r.composers_ingested, 1);
  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.title, "new");
  store.close();
});
