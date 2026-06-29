import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRunStatus,
  contextUtilization,
  detectLoop,
} from "./live-heuristics.ts";
import type { Run, Step } from "@meterbility/shared";

function step(partial: Partial<Step>): Step {
  return {
    step_id: "stp_x",
    run_id: "run_x",
    sequence: 0,
    timestamp: new Date().toISOString(),
    model: "claude-opus-4-7",
    context_snapshot_id: "ctx",
    decision_ref: "dec",
    action: { kind: "none" },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
    ...partial,
  };
}

const RUN: Run = {
  run_id: "r1",
  agent_id: "a",
  project_id: "p",
  source_runtime: "claude-code",
  status: "in_progress",
  started_at: new Date().toISOString(),
  tokens_total_input: 0,
  tokens_total_output: 0,
  tokens_total_cached: 0,
  cost_cents: 0,
  step_count: 0,
  tags: [],
};

test("contextUtilization handles empty + populated steps", () => {
  assert.equal(contextUtilization(undefined), 0);
  assert.equal(
    contextUtilization(
      step({ tokens: { input: 100_000, output: 0, cached_read: 0, cache_creation: 0 } }),
    ),
    50,
  );
});

test("loop detection fires on N identical tool calls", () => {
  const steps: Step[] = Array.from({ length: 4 }, (_, i) =>
    step({
      sequence: i,
      action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "x" } },
    }),
  );
  const loop = detectLoop(steps, 4);
  assert.ok(loop);
  assert.equal(loop?.tool, "Bash");
  assert.equal(loop?.repeats, 4);
});

test("loop detection ignores varied inputs", () => {
  const steps: Step[] = [
    step({ sequence: 0, action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "x" } } }),
    step({ sequence: 1, action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "y" } } }),
    step({ sequence: 2, action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "x" } } }),
    step({ sequence: 3, action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "z" } } }),
  ];
  assert.equal(detectLoop(steps, 4), undefined);
});

test("classifyRunStatus ladders through states", () => {
  // Stalled: last step was 3min ago
  const stale = step({
    timestamp: new Date(Date.now() - 200_000).toISOString(),
  });
  assert.equal(classifyRunStatus(RUN, [stale], 60), "stalled");

  // Awaiting input: pending outcome
  const pending = step({
    timestamp: new Date().toISOString(),
    outcome: { status: "pending" },
  });
  assert.equal(classifyRunStatus(RUN, [pending], 60), "awaiting_input");

  // Errored: run.status overrides everything
  assert.equal(classifyRunStatus({ ...RUN, status: "error" }, [pending], 60), "errored");
});
