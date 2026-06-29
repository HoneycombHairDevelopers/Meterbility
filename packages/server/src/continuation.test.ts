import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listRuns, listSteps } from "@meterbility/collector";
import { MeterbilityTracer } from "@meterbility/agent";
import { forkRun, fakeResponder } from "./fork.ts";
import {
  continueFork,
  type ContinuationModelCaller,
  type ToolExecutor,
} from "./continuation.ts";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-cont-"));
  process.env.METERBILITY_HOME = dir;
  return dir;
}

async function seedOriginRun(): Promise<{ store: Store; runId: string }> {
  fresh();
  const tracer = new MeterbilityTracer({ project: "/tmp/o", agent: "t" });
  // s0: user-shaped (we'll use a tool call to keep the schema)
  const s0 = tracer.startStep({
    model: "claude-opus-4-7",
    history: [{ role: "user", content: "compute 2+2" }],
  });
  s0.recordToolCall("calculator", { expr: "2+2" }, "tu1")
    .recordToolResult("4", { isError: false })
    .recordTokens({ tokens: { input: 10, output: 5, cached_read: 0, cache_creation: 0 } });
  await s0.end();

  const s1 = tracer.startStep({ model: "claude-opus-4-7" });
  s1.recordToolCall("calculator", { expr: "3+3" }, "tu2")
    .recordToolResult("6", { isError: false })
    .recordTokens({ tokens: { input: 12, output: 5, cached_read: 0, cache_creation: 0 } });
  await s1.end();

  const s2 = tracer.startStep({ model: "claude-opus-4-7" });
  s2.recordMessage("done — both computed")
    .recordOutcome({ outcome: { status: "ok" } })
    .recordTokens({ tokens: { input: 15, output: 8, cached_read: 0, cache_creation: 0 } });
  await s2.end();
  await tracer.end();

  const store = Store.open();
  const runs = listRuns(store);
  return { store, runId: runs[0]!.run_id };
}

test("continueFork in simulate mode replays tools from origin and terminates on message", async () => {
  const { store, runId } = await seedOriginRun();
  const fork = await forkRun(
    store,
    {
      origin_run_id: runId,
      at: 0,
      edit: { type: "replace_user_message", payload: { text: "compute 2+2" } },
    },
    fakeResponder("starting"), // produces sequence=1
  );

  // Build a model caller that scripts the next two moves:
  //   1) tool_call calculator(2+2)  → simulate finds "4"
  //   2) message "all done"         → terminates
  const scripted: ContinuationModelCaller = async (args) => {
    if (args.iteration === 0) {
      return {
        model: "scripted",
        decision_content: { mock: 1 },
        action: {
          kind: "tool_call",
          tool_name: "calculator",
          tool_use_id: "x1",
          tool_input: { expr: "2+2" },
        },
        tokens: { input: 1, output: 1, cached_read: 0, cache_creation: 0 },
        latency_ms: 1,
      };
    }
    return {
      model: "scripted",
      decision_content: { mock: 2 },
      action: { kind: "message", text: "all done" },
      tokens: { input: 1, output: 1, cached_read: 0, cache_creation: 0 },
      latency_ms: 1,
    };
  };

  const r = await continueFork(store, fork.fork_run_id, {
    mode: "simulate",
    modelCaller: scripted,
    originRunId: runId,
    maxIterations: 10,
  });

  assert.equal(r.terminal_reason, "model_completed");
  assert.equal(r.steps_added, 2);
  const steps = listSteps(store, fork.fork_run_id);
  // prefix(1) + initial suffix(1) + 2 continuation steps = 4
  assert.equal(steps.length, 4);
  const last = steps[steps.length - 1]!;
  assert.equal(last.action.kind, "message");
  assert.equal(last.action.text, "all done");
  store.close();
});

test("simulate stops with simulate_miss when model picks an unknown tool", async () => {
  const { store, runId } = await seedOriginRun();
  const fork = await forkRun(
    store,
    {
      origin_run_id: runId,
      at: 0,
      edit: { type: "replace_user_message", payload: { text: "x" } },
    },
    fakeResponder("starting"),
  );
  const scripted: ContinuationModelCaller = async () => ({
    model: "scripted",
    decision_content: {},
    action: {
      kind: "tool_call",
      tool_name: "unknown_tool",
      tool_input: { foo: "bar" },
    },
    tokens: { input: 1, output: 1, cached_read: 0, cache_creation: 0 },
    latency_ms: 1,
  });
  const r = await continueFork(store, fork.fork_run_id, {
    mode: "simulate",
    modelCaller: scripted,
    originRunId: runId,
    maxIterations: 5,
  });
  assert.equal(r.terminal_reason, "simulate_miss");
  const steps = listSteps(store, fork.fork_run_id);
  assert.ok(steps[steps.length - 1]!.tags.includes("simulate_miss"));
  store.close();
});

test("live mode terminates on tool_error", async () => {
  const { store, runId } = await seedOriginRun();
  const fork = await forkRun(
    store,
    {
      origin_run_id: runId,
      at: 0,
      edit: { type: "replace_user_message", payload: { text: "x" } },
    },
    fakeResponder("starting"),
  );
  const scripted: ContinuationModelCaller = async () => ({
    model: "scripted",
    decision_content: {},
    action: {
      kind: "tool_call",
      tool_name: "broken",
      tool_input: {},
    },
    tokens: { input: 1, output: 1, cached_read: 0, cache_creation: 0 },
    latency_ms: 1,
  });
  const failing: ToolExecutor = async () => ({
    output: { msg: "nope" },
    is_error: true,
    summary: "tool failed",
  });
  const r = await continueFork(store, fork.fork_run_id, {
    mode: "live",
    modelCaller: scripted,
    toolExecutor: failing,
    maxIterations: 5,
  });
  assert.equal(r.terminal_reason, "tool_error");
  store.close();
});

test("max_iterations cap fires when model never completes", async () => {
  const { store, runId } = await seedOriginRun();
  const fork = await forkRun(
    store,
    {
      origin_run_id: runId,
      at: 0,
      edit: { type: "replace_user_message", payload: { text: "x" } },
    },
    fakeResponder("starting"),
  );
  // Forever tool-calls calculator(2+2) — known signature, so simulate hits.
  const scripted: ContinuationModelCaller = async () => ({
    model: "scripted",
    decision_content: {},
    action: {
      kind: "tool_call",
      tool_name: "calculator",
      tool_input: { expr: "2+2" },
    },
    tokens: { input: 1, output: 1, cached_read: 0, cache_creation: 0 },
    latency_ms: 1,
  });
  const r = await continueFork(store, fork.fork_run_id, {
    mode: "simulate",
    modelCaller: scripted,
    originRunId: runId,
    maxIterations: 3,
  });
  assert.equal(r.terminal_reason, "max_iterations");
  assert.equal(r.iterations_run, 3);
  store.close();
});
