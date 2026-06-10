import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns, listSteps } from "@spool-ai/collector";
import { ingestCodexSession } from "./ingest.ts";

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-codex-"));
  process.env.SPOOL_HOME = dir;
  return Store.open();
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-codex-session-"));
  const path = join(dir, "rollout-2026-05-11T10-12-04-test-session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

test("ingest codex message-only session", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-05-11T17:12:04Z",
      payload: {
        id: "sess1",
        timestamp: "2026-05-11T17:12:04Z",
        cwd: "/tmp/proj",
        model_provider: "openai",
        base_instructions: { text: "you are a careful coder" },
        git: { branch: "main" },
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:05Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "list the files" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:06Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "[external_agent_tool_call: Bash]\ncommand: ls -la\n[/external_agent_tool_call]",
          },
        ],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:07Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-11T17:12:08Z",
      payload: { type: "task_complete", turn_id: "t1" },
    },
  ]);

  const r = await ingestCodexSession(store, path);
  assert.equal(r.status, "ok");
  assert.equal(r.steps_added, 2);

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.source_runtime, "codex-cli");
  assert.equal(runs[0]!.git_branch, "main");
  assert.equal(runs[0]!.cwd, "/tmp/proj");
  assert.equal(runs[0]!.status, "ok");
  assert.ok(runs[0]!.tags.includes("cost:approx"));

  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "Bash");
  assert.equal(steps[1]!.action.kind, "message");
  store.close();
});

test("function_call + function_call_output pair becomes one step with outcome", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-05-11T17:12:04Z",
      payload: { id: "sess2", timestamp: "2026-05-11T17:12:04Z", cwd: "/tmp/p2" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:05Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "compute 1+1" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:06Z",
      payload: {
        type: "function_call",
        call_id: "c1",
        name: "calculator",
        arguments: '{"expr":"1+1"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:07Z",
      payload: { type: "function_call_output", call_id: "c1", output: "2" },
    },
  ]);

  const r = await ingestCodexSession(store, path);
  assert.equal(r.steps_added, 1);
  const runs = listRuns(store);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(steps[0]!.action.kind, "tool_call");
  assert.equal(steps[0]!.action.tool_name, "calculator");
  assert.deepEqual(steps[0]!.action.tool_input, { expr: "1+1" });
  assert.equal(steps[0]!.outcome.status, "ok");
  assert.ok(steps[0]!.outcome.tool_result_ref);
  store.close();
});

test("codex ingest is idempotent", async () => {
  const store = freshStore();
  const path = writeSession([
    {
      type: "session_meta",
      timestamp: "2026-05-11T17:12:04Z",
      payload: { id: "sess3", timestamp: "2026-05-11T17:12:04Z", cwd: "/tmp/p3" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-11T17:12:05Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    },
  ]);
  await ingestCodexSession(store, path);
  const r2 = await ingestCodexSession(store, path);
  assert.equal(r2.status, "empty");
  store.close();
});
