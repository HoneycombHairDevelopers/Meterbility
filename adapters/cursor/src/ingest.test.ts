import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store, listRuns, listSteps } from "@meterbility/collector";
import { ingestCursorGlobal } from "./ingest.ts";

function freshMeterbilityHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-cursor-"));
  process.env.METERBILITY_HOME = dir;
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
      tool?: {
        name: string;
        rawArgs?: string;
        params?: string;
        result?: unknown;
        status?: string;
        additionalData?: unknown;
      };
    }>;
  }>;
  /** Arbitrary extra KV rows (content blobs, fate ledgers, ...). */
  extraKv?: Record<string, string>;
  /** Rows for the composerHeaders relational table (workspace links). */
  composerHeaders?: Array<{ composerId: string; workspaceId: string }>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-fixture-"));
  const path = join(dir, "state.vscdb");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (args.composerHeaders) {
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        workspaceId TEXT,
        createdAt INTEGER,
        lastUpdatedAt INTEGER
      );
    `);
    const ch = db.prepare(
      "INSERT INTO composerHeaders(composerId, workspaceId) VALUES (?, ?)",
    );
    for (const h of args.composerHeaders) ch.run(h.composerId, h.workspaceId);
  }
  const insert = db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(args.extraKv ?? {})) insert.run(k, v);
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
          params: b.tool.params,
          status: b.tool.status ?? "completed",
          result: b.tool.result,
          additionalData: b.tool.additionalData,
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
  freshMeterbilityHome();
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
  freshMeterbilityHome();
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
  freshMeterbilityHome();
  const store = Store.open();
  const r = await ingestCursorGlobal(store, { dbPath: "/nope/state.vscdb" });
  assert.equal(r.status, "no_db");
  assert.match(r.reason ?? "", /cannot open/);
  store.close();
});

test("limit + since options filter composers", async () => {
  freshMeterbilityHome();
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

// ---------------------------------------------------------------------------
// Cross-vendor parity (2026-08-04): file-change extraction, pricing,
// workspace cwd resolution. Fixture shapes mirror the audited real DB.
// ---------------------------------------------------------------------------

test("parity: search_replace produces a partial_diff file_change with patch_text", async () => {
  freshMeterbilityHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-sr",
        name: "fix bug",
        headers: [{ bubbleId: "a1", type: 2 }],
        bubbles: [
          {
            bubbleId: "a1",
            type: 2,
            tokens: { input: 500, output: 40 },
            tool: {
              name: "search_replace",
              params: JSON.stringify({ relativeWorkspacePath: "src/app.ts" }),
              result: JSON.stringify({
                diff: {
                  chunks: [
                    {
                      diffString: "@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2",
                      linesAdded: 1,
                      linesRemoved: 1,
                    },
                  ],
                },
              }),
              additionalData: { codeblockId: "cb-1" },
            },
          },
        ],
      },
    ],
    extraKv: {
      "codeBlockPartialInlineDiffFates:comp-sr:cb-1": JSON.stringify({
        fates: [{ fate: "accepted" }, { fate: "accepted" }],
      }),
    },
  });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  const fc = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ?`)
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(fc.length, 1);
  assert.equal(fc[0]!.path, "src/app.ts");
  assert.equal(fc[0]!.op, "modify");
  assert.equal(fc[0]!.partial_diff, 1);
  assert.ok(String(fc[0]!.patch_text).includes("+const a = 2"));
  assert.equal(fc[0]!.lines_added, 1);
  assert.equal(fc[0]!.lines_removed, 1);
  assert.match(String(fc[0]!.normalizer_notes), /fates\{accepted:2\}/);

  // Pricing: tokens present → cost computed (approx, but nonzero).
  const steps = listSteps(store, runs[0]!.run_id);
  const toolStep = steps.find((s) => s.action.kind === "tool_call")!;
  assert.ok(toolStep.cost_cents > 0, "local tokens are priced, not zeroed");
  store.close();
});

test("parity: edit_file_v2 resolves content blobs into full before/after file_change", async () => {
  freshMeterbilityHome();
  const before = "line one\nline two\n";
  const after = "line one\nline two changed\nline three\n";
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-efv2",
        name: "edit file",
        headers: [{ bubbleId: "a1", type: 2 }],
        bubbles: [
          {
            bubbleId: "a1",
            type: 2,
            tool: {
              name: "edit_file_v2",
              params: JSON.stringify({ relativeWorkspacePath: "notes.md" }),
              result: JSON.stringify({
                beforeContentId: "sha-before",
                afterContentId: "sha-after",
              }),
            },
          },
        ],
      },
    ],
    extraKv: {
      "composer.content.sha-before": before,
      "composer.content.sha-after": after,
    },
  });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  const fc = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ?`)
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(fc.length, 1);
  assert.equal(fc[0]!.op, "modify");
  assert.equal(fc[0]!.partial_diff, 0, "full before/after recovered");
  assert.ok(fc[0]!.before_blob_ref);
  assert.ok(fc[0]!.after_blob_ref);
  assert.equal(fc[0]!.line_count_before, 2);
  assert.equal(fc[0]!.line_count_after, 3);
  assert.ok((fc[0]!.lines_added as number) >= 1);
  store.close();
});

test("parity: composer cwd resolves via composerHeaders + workspace.json", async () => {
  freshMeterbilityHome();
  // Fake Cursor user dir with a workspace mapping.
  const userDir = mkdtempSync(join(tmpdir(), "cursor-user-"));
  process.env.CURSOR_USER_DIR = userDir;
  const wsDir = join(userDir, "workspaceStorage", "ws-hash-1");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(
    join(wsDir, "workspace.json"),
    JSON.stringify({ folder: "file:///tmp/real-project" }),
  );

  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-ws",
        name: "workspace test",
        headers: [{ bubbleId: "u1", type: 1 }],
        bubbles: [{ bubbleId: "u1", type: 1, text: "hello" }],
      },
    ],
    composerHeaders: [{ composerId: "comp-ws", workspaceId: "ws-hash-1" }],
  });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  assert.equal(runs[0]!.cwd, "/tmp/real-project", "no more (cursor) placeholder");
  delete process.env.CURSOR_USER_DIR;
  store.close();
});

test("parity: pruned content blobs degrade to fact-only partial rows", async () => {
  freshMeterbilityHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-pruned",
        name: "pruned",
        headers: [{ bubbleId: "a1", type: 2 }],
        bubbles: [
          {
            bubbleId: "a1",
            type: 2,
            tool: {
              name: "edit_file_v2",
              params: JSON.stringify({ relativeWorkspacePath: "gone.ts" }),
              result: JSON.stringify({
                beforeContentId: "sha-x",
                afterContentId: "sha-y",
              }),
            },
          },
        ],
      },
    ],
    // No composer.content rows — Cursor's retention pruned them.
  });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  const fc = store.db
    .prepare(`SELECT * FROM file_change WHERE run_id = ?`)
    .all(runs[0]!.run_id) as Array<Record<string, unknown>>;
  assert.equal(fc.length, 1);
  assert.equal(fc[0]!.partial_diff, 1);
  assert.match(String(fc[0]!.normalizer_notes), /pruned/);
  store.close();
});
