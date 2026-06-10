import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns, listSteps } from "@spool-ai/collector";
import { ingestSession } from "./ingest.ts";

function fresh(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-ingest-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-session-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

test("ingest produces one step per assistant record", async () => {
  const store = fresh();
  const path = writeSession([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "s1",
      timestamp: "2026-05-11T00:00:00.000Z",
      cwd: "/tmp/proj",
      gitBranch: "main",
      message: { role: "user", content: "please run ls" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "s1",
      timestamp: "2026-05-11T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: "s1",
      timestamp: "2026-05-11T00:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "file1\nfile2" }],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      sessionId: "s1",
      timestamp: "2026-05-11T00:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 50,
          output_tokens: 5,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ]);

  const result = await ingestSession(store, path);
  assert.equal(result.status, "ok");
  assert.equal(result.steps_added, 2);

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.source_session_id, "s1");
  assert.equal(runs[0]!.cwd, "/tmp/proj");
  assert.equal(runs[0]!.git_branch, "main");
  assert.equal(runs[0]!.step_count, 2);
  assert.equal(runs[0]!.status, "ok");

  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "Bash");
  assert.equal(steps[0]!.outcome.status, "ok");
  assert.ok(steps[0]!.outcome.tool_result_ref);
  assert.equal(steps[1]!.action.kind, "message");
  assert.equal(steps[1]!.action.text, "done");
  assert.equal(steps[1]!.tokens.cached_read, 90);
  store.close();
});

test("ingest is idempotent — re-running same path adds no new steps", async () => {
  const store = fresh();
  const path = writeSession([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "sX",
      cwd: "/tmp/proj",
      timestamp: "2026-05-11T00:00:00.000Z",
      message: { role: "user", content: "hi" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "sX",
      timestamp: "2026-05-11T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]);
  const r1 = await ingestSession(store, path);
  const r2 = await ingestSession(store, path);
  assert.equal(r1.steps_added, 1);
  // Second call has no new bytes to read.
  assert.equal(r2.status, "empty");
  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.step_count, 1);
  store.close();
});

test("error tool result propagates to step status", async () => {
  const store = fresh();
  const path = writeSession([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "sErr",
      cwd: "/tmp/proj",
      timestamp: "2026-05-11T00:00:00.000Z",
      message: { role: "user", content: "run a broken command" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "sErr",
      timestamp: "2026-05-11T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "doesnotexist" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: "sErr",
      timestamp: "2026-05-11T00:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "command not found",
            is_error: true,
          },
        ],
      },
    },
  ]);
  await ingestSession(store, path);
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps[0]!.status, "error");
  assert.equal(steps[0]!.outcome.is_error, true);
  assert.equal(runs[0]!.status, "error");
  store.close();
});
