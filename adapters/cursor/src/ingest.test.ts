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

test("re-ingesting the same composer twice does not duplicate steps", async () => {
  freshMeterbilityHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-reingest",
        name: "Twice",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
          { bubbleId: "a2", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          {
            bubbleId: "a1",
            type: 2,
            tool: { name: "read_file", rawArgs: "{}", result: "ok" },
            tokens: { input: 10, output: 5 },
          },
          { bubbleId: "a2", type: 2, text: "done", tokens: { input: 20, output: 8 } },
        ],
      },
    ],
  });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const firstRun = listRuns(store)[0]!;
  assert.equal(firstRun.step_count, 3);
  const firstSteps = listSteps(store, firstRun.run_id);

  const r2 = await ingestCursorGlobal(store, { dbPath });
  assert.equal(r2.steps_added, 0, "no-op re-ingest must report zero new steps");
  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.step_count, 3);
  assert.equal(runs[0]!.run_id, firstRun.run_id);

  const secondSteps = listSteps(store, runs[0]!.run_id);
  assert.equal(secondSteps.length, 3);
  // Same deterministic ids and sequences — upserted in place, not appended.
  assert.deepEqual(
    secondSteps.map((s) => [s.step_id, s.sequence]),
    firstSteps.map((s) => [s.step_id, s.sequence]),
  );
  // Token totals must not double either.
  assert.equal(runs[0]!.tokens_total_input, firstRun.tokens_total_input);
  assert.equal(runs[0]!.tokens_total_output, firstRun.tokens_total_output);
  store.close();
});

test("bubbles appended between ingests extend the run without disturbing earlier steps", async () => {
  freshMeterbilityHome();
  const composerBase = {
    id: "comp-append",
    name: "Growing",
    headers: [
      { bubbleId: "u1", type: 1 as const },
      { bubbleId: "a1", type: 2 as const },
    ],
    bubbles: [
      { bubbleId: "u1", type: 1 as const, text: "hello" },
      {
        bubbleId: "a1",
        type: 2 as const,
        text: "first answer",
        tokens: { input: 10, output: 5 },
      },
    ],
  };
  const dbPathV1 = buildCursorDb({ composers: [composerBase] });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: dbPathV1 });
  const firstRun = listRuns(store)[0]!;
  assert.equal(firstRun.step_count, 2);
  const firstSteps = listSteps(store, firstRun.run_id);

  // Cursor appended two more bubbles to the same composer since the
  // last ingest — same composer id, longer conversation.
  const dbPathV2 = buildCursorDb({
    composers: [
      {
        ...composerBase,
        headers: [
          ...composerBase.headers,
          { bubbleId: "u2", type: 1 as const },
          { bubbleId: "a2", type: 2 as const },
        ],
        bubbles: [
          ...composerBase.bubbles,
          { bubbleId: "u2", type: 1 as const, text: "and then?" },
          {
            bubbleId: "a2",
            type: 2 as const,
            text: "second answer",
            tokens: { input: 20, output: 8 },
          },
        ],
      },
    ],
  });
  await ingestCursorGlobal(store, { dbPath: dbPathV2 });

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.run_id, firstRun.run_id);
  assert.equal(runs[0]!.step_count, 4);

  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 4);
  // Old steps keep their ids and sequences.
  assert.deepEqual(
    steps.slice(0, 2).map((s) => [s.step_id, s.sequence]),
    firstSteps.map((s) => [s.step_id, s.sequence]),
  );
  // New bubbles appended at the next sequences, chained to the old tail.
  assert.deepEqual(steps.map((s) => s.sequence), [0, 1, 2, 3]);
  assert.equal(steps[2]!.action.kind, "message");
  assert.equal(steps[2]!.action.text, "and then?");
  assert.equal(steps[2]!.parent_step_id, firstSteps[1]!.step_id);
  // Totals reflect the full conversation, counted once.
  assert.equal(runs[0]!.tokens_total_input, 30);
  assert.equal(runs[0]!.tokens_total_output, 13);
  store.close();
});

test("same bubbleId in two different composers yields distinct step ids", async () => {
  freshMeterbilityHome();
  // Cursor bubble ids are only unique within a composer; two composers
  // reusing "u1"/"a1" must not collide across runs.
  const mkComposer = (id: string, answer: string) => ({
    id,
    name: id,
    headers: [
      { bubbleId: "u1", type: 1 as const },
      { bubbleId: "a1", type: 2 as const },
    ],
    bubbles: [
      { bubbleId: "u1", type: 1 as const, text: `ask ${id}` },
      { bubbleId: "a1", type: 2 as const, text: answer },
    ],
  });
  const dbPath = buildCursorDb({
    composers: [mkComposer("comp-x", "answer x"), mkComposer("comp-y", "answer y")],
  });

  const store = Store.open();
  const r = await ingestCursorGlobal(store, { dbPath });
  assert.equal(r.composers_ingested, 2);
  assert.equal(r.steps_added, 4);

  const runs = listRuns(store);
  assert.equal(runs.length, 2);
  const allSteps = runs.flatMap((run) => listSteps(store, run.run_id));
  assert.equal(allSteps.length, 4);
  const ids = new Set(allSteps.map((s) => s.step_id));
  assert.equal(ids.size, 4, "step ids must be unique across runs despite shared bubbleIds");
  // Each run kept its own two steps.
  for (const run of runs) {
    assert.equal(listSteps(store, run.run_id).length, 2);
  }
  store.close();
});

test("legacy run with random step ids is upgraded in place, not duplicated", async () => {
  freshMeterbilityHome();
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-legacy",
        name: "Legacy",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "done", tokens: { input: 20, output: 8 } },
        ],
      },
    ],
  });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath });
  const run = listRuns(store)[0]!;
  // Simulate rows written by the pre-fix adapter: non-deterministic
  // step ids at the same (run_id, sequence) slots.
  store.db
    .prepare(
      `UPDATE steps SET
         step_id = 'stp_legacy_' || sequence,
         parent_step_id = CASE WHEN sequence > 0 THEN 'stp_legacy_' || (sequence - 1) END
       WHERE run_id = ?`,
    )
    .run(run.run_id);

  await ingestCursorGlobal(store, { dbPath });
  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.step_count, 2);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 2);
  // The UNIQUE(run_id, sequence) conflict clause keeps the existing
  // step_id so children stay attached; content is refreshed in place.
  assert.deepEqual(steps.map((s) => s.step_id), ["stp_legacy_0", "stp_legacy_1"]);
  // The parent chain must point at the surviving (legacy) ids, not the
  // deterministic ids the walk computed.
  assert.equal(steps[0]!.parent_step_id, undefined);
  assert.equal(steps[1]!.parent_step_id, "stp_legacy_0");
  assert.equal(steps[1]!.action.kind, "message");
  assert.equal(steps[1]!.action.text, "done");
  assert.equal(runs[0]!.tokens_total_input, 20);
  assert.equal(runs[0]!.tokens_total_output, 8);
  store.close();
});

test("bubble inserted before existing bubbles rebuilds the run instead of crashing", async () => {
  freshMeterbilityHome();
  const v1 = buildCursorDb({
    composers: [
      {
        id: "comp-ins",
        name: "Ins",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "answer", tokens: { input: 10, output: 5 } },
        ],
      },
    ],
  });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: v1 });

  // A checkpoint restore / edited turn shifted the conversation: a new
  // bubble now sits BEFORE the previously ingested ones. Every stored
  // (step_id, sequence) pair is wrong; the adapter must rebuild, not
  // die on the UNIQUE(run_id, sequence) constraint.
  const v2 = buildCursorDb({
    composers: [
      {
        id: "comp-ins",
        name: "Ins",
        headers: [
          { bubbleId: "u0", type: 1 },
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u0", type: 1, text: "new first" },
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "answer", tokens: { input: 10, output: 5 } },
        ],
      },
    ],
  });
  const r2 = await ingestCursorGlobal(store, { dbPath: v2 });
  assert.equal(r2.steps_added, 1, "only the inserted bubble is genuinely new");

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.step_count, 3);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.deepEqual(steps.map((s) => s.sequence), [0, 1, 2]);
  assert.deepEqual(
    steps.map((s) => s.action.kind === "message" && s.action.text),
    ["new first", "hello", "answer"],
  );
  // Parent chain is consistent: every parent id is a real step in the run.
  const ids = new Set(steps.map((s) => s.step_id));
  assert.equal(ids.size, 3);
  assert.equal(steps[0]!.parent_step_id, undefined);
  assert.equal(steps[1]!.parent_step_id, steps[0]!.step_id);
  assert.equal(steps[2]!.parent_step_id, steps[1]!.step_id);
  assert.equal(runs[0]!.tokens_total_input, 10);
  store.close();
});

test("composer rewound to fewer bubbles trims the stale tail from totals", async () => {
  freshMeterbilityHome();
  const allHeaders = [
    { bubbleId: "u1", type: 1 as const },
    { bubbleId: "a1", type: 2 as const },
    { bubbleId: "u2", type: 1 as const },
    { bubbleId: "a2", type: 2 as const },
  ];
  const allBubbles = [
    { bubbleId: "u1", type: 1 as const, text: "hello" },
    { bubbleId: "a1", type: 2 as const, text: "answer", tokens: { input: 10, output: 5 } },
    { bubbleId: "u2", type: 1 as const, text: "more" },
    { bubbleId: "a2", type: 2 as const, text: "extra", tokens: { input: 20, output: 8 } },
  ];
  const mk = (n: number) =>
    buildCursorDb({
      composers: [
        {
          id: "comp-shrink",
          name: "Shrink",
          headers: allHeaders.slice(0, n),
          bubbles: allBubbles.slice(0, n),
        },
      ],
    });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: mk(4) });
  assert.equal(listRuns(store)[0]!.step_count, 4);

  // Cursor checkpoint restore rewound the conversation to 2 bubbles.
  await ingestCursorGlobal(store, { dbPath: mk(2) });
  const run = listRuns(store)[0]!;
  assert.equal(run.step_count, 2);
  assert.equal(run.tokens_total_input, 10);
  assert.equal(run.tokens_total_output, 5);
  const steps = listSteps(store, run.run_id);
  assert.deepEqual(
    steps.map((s) => s.action.kind === "message" && s.action.text),
    ["hello", "answer"],
  );
  store.close();
});

test("shifted bubbles keep their step ids so children stay attached", async () => {
  freshMeterbilityHome();
  const mk = (withNewFirst: boolean) =>
    buildCursorDb({
      composers: [
        {
          id: "comp-keep",
          name: "Keep",
          headers: [
            ...(withNewFirst ? [{ bubbleId: "u0", type: 1 as const }] : []),
            { bubbleId: "u1", type: 1 as const },
            { bubbleId: "a1", type: 2 as const },
          ],
          bubbles: [
            ...(withNewFirst
              ? [{ bubbleId: "u0", type: 1 as const, text: "new first" }]
              : []),
            { bubbleId: "u1", type: 1 as const, text: "hello" },
            { bubbleId: "a1", type: 2 as const, text: "answer" },
          ],
        },
      ],
    });

  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: mk(false) });
  const before = listSteps(store, listRuns(store)[0]!.run_id);

  await ingestCursorGlobal(store, { dbPath: mk(true) });
  const after = listSteps(store, listRuns(store)[0]!.run_id);
  assert.equal(after.length, 3);
  // The surviving bubbles moved to new sequences but kept their step ids
  // — anything referencing them (file_change rows) stays attached.
  assert.equal(after[1]!.step_id, before[0]!.step_id);
  assert.equal(after[2]!.step_id, before[1]!.step_id);
  store.close();
});

test("empty bubble walk on an existing run is a torn read, not a rewind", async () => {
  freshMeterbilityHome();
  const full = buildCursorDb({
    composers: [
      {
        id: "comp-torn",
        name: "Torn",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "answer", tokens: { input: 10, output: 5 } },
        ],
      },
    ],
  });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: full });
  assert.equal(listRuns(store)[0]!.step_count, 2);

  // Cursor flushed the composer envelope but not the bubble rows yet —
  // the headers claim content the walk can't see. This must NOT be
  // treated as a rewind (which would delete every step and cascade away
  // file_change children).
  const torn = buildCursorDb({
    composers: [
      {
        id: "comp-torn",
        name: "Torn",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [],
      },
    ],
  });
  const r = await ingestCursorGlobal(store, { dbPath: torn });
  assert.equal(r.steps_added, 0);
  const run = listRuns(store)[0]!;
  assert.equal(run.step_count, 2, "torn read must leave stored steps untouched");
  assert.equal(run.tokens_total_input, 10);
  store.close();
});

test("partial bubble walk (missing rows) leaves the existing run untouched", async () => {
  freshMeterbilityHome();
  const full = buildCursorDb({
    composers: [
      {
        id: "comp-partial",
        name: "Partial",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
          { bubbleId: "u2", type: 1 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "answer", tokens: { input: 10, output: 5 } },
          { bubbleId: "u2", type: 1, text: "more" },
        ],
      },
    ],
  });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: full });
  assert.equal(listRuns(store)[0]!.step_count, 3);

  // Headers list three bubbles but one row hasn't flushed yet (or is
  // mid-write). Reconciling against this partial view would shift-
  // rebuild or trim away real steps and their children.
  const partial = buildCursorDb({
    composers: [
      {
        id: "comp-partial",
        name: "Partial",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
          { bubbleId: "u2", type: 1 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "u2", type: 1, text: "more" },
        ],
      },
    ],
  });
  const r = await ingestCursorGlobal(store, { dbPath: partial });
  assert.equal(r.steps_added, 0);
  assert.equal(listRuns(store)[0]!.step_count, 3, "partial read must not mutate the run");
  store.close();
});

test("bubbles that stop classifying as user/assistant do not wipe the run", async () => {
  freshMeterbilityHome();
  const good = buildCursorDb({
    composers: [
      {
        id: "comp-drift",
        name: "Drift",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "answer" },
        ],
      },
    ],
  });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: good });
  assert.equal(listRuns(store)[0]!.step_count, 2);

  // Cursor drifts the bubble type encoding (types.ts warns the schema
  // changes without notice): all rows fetch but none classify. An empty
  // walk must not be mistaken for an empty conversation.
  const drifted = buildCursorDb({
    composers: [
      {
        id: "comp-drift",
        name: "Drift",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 3 as unknown as 1, text: "hello" },
          { bubbleId: "a1", type: 3 as unknown as 2, text: "answer" },
        ],
      },
    ],
  });
  const r = await ingestCursorGlobal(store, { dbPath: drifted });
  assert.equal(r.steps_added, 0);
  assert.equal(listRuns(store)[0]!.step_count, 2, "type drift must not wipe the run");
  store.close();
});

test("single bubble losing its classification does not trim the run", async () => {
  freshMeterbilityHome();
  const mk = (middleType: 1 | 2) =>
    buildCursorDb({
      composers: [
        {
          id: "comp-pdrift",
          name: "PDrift",
          headers: [
            { bubbleId: "u1", type: 1 },
            { bubbleId: "a1", type: 2 },
            { bubbleId: "u2", type: 1 },
          ],
          bubbles: [
            { bubbleId: "u1", type: 1, text: "hello" },
            { bubbleId: "a1", type: middleType, text: "answer" },
            { bubbleId: "u2", type: 1, text: "more" },
          ],
        },
      ],
    });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: mk(2) });
  assert.equal(listRuns(store)[0]!.step_count, 3);

  // One bubble's type drifts to an unknown value: the walk still sees
  // all rows, but only two classify. The compressed view looks like a
  // shift — reconciling against it would delete the middle turn.
  const r = await ingestCursorGlobal(store, {
    dbPath: mk(3 as unknown as 2),
  });
  assert.equal(r.steps_added, 0);
  assert.equal(listRuns(store)[0]!.step_count, 3, "partial drift must not trim the run");
  store.close();
});

test("rewind plus new message replaces the turn instead of grafting onto its id", async () => {
  freshMeterbilityHome();
  const v1 = buildCursorDb({
    composers: [
      {
        id: "comp-div",
        name: "Diverge",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
          { bubbleId: "u2", type: 1 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "old answer" },
          { bubbleId: "u2", type: 1, text: "old tail" },
        ],
      },
    ],
  });
  const store = Store.open();
  await ingestCursorGlobal(store, { dbPath: v1 });
  const before = listSteps(store, listRuns(store)[0]!.run_id);
  assert.equal(before.length, 3);

  // Checkpoint restore rewound past a1/u2, then the user sent a new
  // message: same prefix, divergent tail. The new bubble must get its
  // OWN step id — not silently inherit a1's id through the
  // (run_id, sequence) conflict clause.
  const v2 = buildCursorDb({
    composers: [
      {
        id: "comp-div",
        name: "Diverge",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "u9", type: 1 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "u9", type: 1, text: "different question" },
        ],
      },
    ],
  });
  const r = await ingestCursorGlobal(store, { dbPath: v2 });
  assert.equal(r.steps_added, 1, "exactly one genuinely new turn");

  const run = listRuns(store)[0]!;
  assert.equal(run.step_count, 2);
  const after = listSteps(store, run.run_id);
  assert.equal(after[0]!.step_id, before[0]!.step_id, "shared prefix keeps its id");
  assert.notEqual(after[1]!.step_id, before[1]!.step_id, "new turn must not inherit the replaced turn's id");
  assert.equal(after[1]!.action.kind, "message");
  assert.equal(after[1]!.action.text, "different question");
  store.close();
});

test("duplicated header bubbleId ingests once and stays stable", async () => {
  freshMeterbilityHome();
  // Cursor's db is trusted verbatim — a repeated header entry must not
  // give one bubble two walk slots (sequence corruption + perpetual
  // rebuilds on every subsequent ingest).
  const dbPath = buildCursorDb({
    composers: [
      {
        id: "comp-dup",
        name: "Dup",
        headers: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
          { bubbleId: "u1", type: 1 },
        ],
        bubbles: [
          { bubbleId: "u1", type: 1, text: "hello" },
          { bubbleId: "a1", type: 2, text: "answer" },
        ],
      },
    ],
  });
  const store = Store.open();
  const r1 = await ingestCursorGlobal(store, { dbPath });
  assert.equal(r1.steps_added, 2);
  const run = listRuns(store)[0]!;
  assert.equal(run.step_count, 2);
  const steps = listSteps(store, run.run_id);
  assert.deepEqual(steps.map((s) => s.sequence), [0, 1]);
  assert.equal(steps[0]!.parent_step_id, undefined);
  assert.equal(steps[1]!.parent_step_id, steps[0]!.step_id);

  const r2 = await ingestCursorGlobal(store, { dbPath });
  assert.equal(r2.steps_added, 0, "identical re-ingest must not rebuild");
  assert.equal(listRuns(store)[0]!.step_count, 2);
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
