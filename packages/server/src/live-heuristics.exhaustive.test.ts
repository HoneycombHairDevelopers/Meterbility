import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { Run, Step, TokenUsage } from "@meterbility/shared";
import {
  classifyRunStatus,
  contextUtilization,
  detectLoop,
  type LiveStatus,
} from "./live-heuristics.ts";

/**
 * Tier 15 — exhaustive coverage of live-heuristics.ts (89 LOC, prior
 * coverage: 0 direct tests, indirect only via web SSE tests).
 *
 * Three pure functions, each with non-trivial branching:
 *   - contextUtilization: window inference per model family + token math
 *   - classifyRunStatus: 6-way LiveStatus FSM with precedence rules
 *   - detectLoop: sliding-window pattern match over the last N steps
 *
 * Sections mirror the function boundaries. Section 4 adds three
 * fast-check properties for the invariants that hold across all inputs.
 *
 * Source-fix budget per the roadmap: "loop window edge cases." Tests
 * pin the edge cases (boundary at stallSeconds, signature truncation,
 * action-kind transitions inside the window) so a future refactor can't
 * silently change semantics.
 */

// ─── Fixture helpers ────────────────────────────────────────────────

function mkTokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 0,
    output: 0,
    cached_read: 0,
    cache_creation: 0,
    ...overrides,
  };
}

function mkStep(overrides: Partial<Step> = {}): Step {
  return {
    step_id: "stp_" + Math.random().toString(36).slice(2, 10),
    run_id: "run_x",
    sequence: 0,
    timestamp: new Date().toISOString(),
    model: "claude-opus-4-7",
    context_snapshot_id: "snap_x",
    decision_ref: "blob_dec",
    action: { kind: "tool_call", tool_name: "Edit", tool_input: { path: "/x" } },
    outcome: { status: "ok" },
    tokens: mkTokens(),
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
    ...overrides,
  };
}

function mkRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run_x",
    agent_id: "agt_x",
    project_id: "prj_x",
    source_runtime: "claude-code",
    title: "fixture",
    status: "in_progress",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
    ...overrides,
  };
}

/* ====================================================================
 * Section 1 — contextUtilization (6 tests)
 * ==================================================================== */

test("contextUtilization: no step → 0", () => {
  assert.equal(contextUtilization(undefined), 0);
});

test("contextUtilization: step with zero tokens → 0", () => {
  const step = mkStep({ tokens: mkTokens() });
  assert.equal(contextUtilization(step), 0);
});

test("contextUtilization: 200k-window model (opus) — 100k tokens → 50%", () => {
  const step = mkStep({
    model: "claude-opus-4-7",
    tokens: mkTokens({ input: 100_000 }),
  });
  assert.equal(contextUtilization(step), 50);
});

test("contextUtilization: 1M-window model variants are detected", () => {
  // Three documented suffix forms that opt into the 1M context.
  for (const model of [
    "claude-opus-4-7[1m]",
    "claude-opus-4-7-1m",
    "claude-opus-4-7-1m-context",
  ]) {
    const step = mkStep({ model, tokens: mkTokens({ input: 500_000 }) });
    assert.equal(
      contextUtilization(step),
      50,
      `${model} should use 1M window (500k → 50%)`,
    );
  }
});

test("contextUtilization: unknown model defaults to 128k window", () => {
  const step = mkStep({
    model: "made-up-model",
    tokens: mkTokens({ input: 64_000 }),
  });
  assert.equal(contextUtilization(step), 50, "64k of 128k → 50%");
});

test("contextUtilization: sums input + cached_read + cache_creation and caps at 100", () => {
  // 200k + 100k + 100k = 400k against a 200k window → would be 200%, capped at 100.
  const step = mkStep({
    model: "claude-opus-4-7",
    tokens: mkTokens({ input: 200_000, cached_read: 100_000, cache_creation: 100_000 }),
  });
  assert.equal(contextUtilization(step), 100, "cap at 100");
});

/* ====================================================================
 * Section 2 — classifyRunStatus (8 tests)
 * Order documented at the function: errored > completed > no-steps >
 * pending+old=stalled > pending+young=awaiting_input > old=stalled >
 * loop > progressing.
 * ==================================================================== */

test("classify: run.status='ok' → 'completed' (terminal short-circuit)", () => {
  const run = mkRun({ status: "ok" });
  assert.equal(classifyRunStatus(run, [mkStep()], 120), "completed");
});

test("classify: run.status='error' → 'errored' (terminal short-circuit, beats all)", () => {
  const run = mkRun({ status: "error" });
  // Even with a fresh pending step, error wins.
  const step = mkStep({ outcome: { status: "pending" } });
  assert.equal(classifyRunStatus(run, [step], 120), "errored");
});

test("classify: no steps yet → 'progressing'", () => {
  assert.equal(classifyRunStatus(mkRun(), [], 120), "progressing");
});

test("classify: last step pending + young (age < stallSeconds) → 'awaiting_input'", () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const step = mkStep({ timestamp: recent, outcome: { status: "pending" } });
  assert.equal(classifyRunStatus(mkRun(), [step], 120), "awaiting_input");
});

test("classify: last step pending + old (age > stallSeconds) → 'stalled'", () => {
  // 200s old, stall threshold 120s.
  const old = new Date(Date.now() - 200_000).toISOString();
  const step = mkStep({ timestamp: old, outcome: { status: "pending" } });
  assert.equal(classifyRunStatus(mkRun(), [step], 120), "stalled");
});

test("classify: last step finished + old → 'stalled' (no fresh activity)", () => {
  const old = new Date(Date.now() - 200_000).toISOString();
  const step = mkStep({ timestamp: old, outcome: { status: "ok" } });
  assert.equal(classifyRunStatus(mkRun(), [step], 120), "stalled");
});

test("classify: last step finished + young + 4-step loop → 'looping'", () => {
  const now = Date.now();
  const looping = Array.from({ length: 4 }, (_, i) =>
    mkStep({
      sequence: i,
      timestamp: new Date(now - (3 - i) * 1000).toISOString(),
      action: {
        kind: "tool_call",
        tool_name: "Read",
        tool_input: { path: "/loop.ts" },
      },
      outcome: { status: "ok" },
    }),
  );
  assert.equal(classifyRunStatus(mkRun(), looping, 120), "looping");
});

test("classify: last step finished + young + no loop → 'progressing'", () => {
  const now = Date.now();
  const steps = Array.from({ length: 4 }, (_, i) =>
    mkStep({
      sequence: i,
      timestamp: new Date(now - (3 - i) * 1000).toISOString(),
      action: {
        kind: "tool_call",
        tool_name: "Read",
        tool_input: { path: `/different-${i}.ts` },
      },
      outcome: { status: "ok" },
    }),
  );
  assert.equal(classifyRunStatus(mkRun(), steps, 120), "progressing");
});

/* ====================================================================
 * Section 3 — detectLoop (9 tests)
 * ==================================================================== */

test("detectLoop: fewer than `window` steps → undefined", () => {
  const steps = Array.from({ length: 3 }, (_, i) => mkStep({ sequence: i }));
  assert.equal(detectLoop(steps, 4), undefined);
});

test("detectLoop: exact-window of identical tool_call+input → loop detected", () => {
  const steps = Array.from({ length: 4 }, (_, i) =>
    mkStep({
      sequence: i,
      action: {
        kind: "tool_call",
        tool_name: "Read",
        tool_input: { path: "/loop.ts" },
      },
    }),
  );
  const loop = detectLoop(steps, 4);
  assert.ok(loop);
  assert.equal(loop.tool, "Read");
  assert.equal(loop.repeats, 4);
});

test("detectLoop: any single mismatched input in the window → undefined", () => {
  const steps = [
    mkStep({
      sequence: 0,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/a" } },
    }),
    mkStep({
      sequence: 1,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/a" } },
    }),
    mkStep({
      sequence: 2,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/different" } },
    }),
    mkStep({
      sequence: 3,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/a" } },
    }),
  ];
  assert.equal(detectLoop(steps, 4), undefined);
});

test("detectLoop: tool_name change inside the window → undefined", () => {
  const steps = Array.from({ length: 4 }, (_, i) =>
    mkStep({
      sequence: i,
      action: {
        kind: "tool_call",
        tool_name: i === 2 ? "Bash" : "Read",
        tool_input: { path: "/x" },
      },
    }),
  );
  assert.equal(detectLoop(steps, 4), undefined);
});

test("detectLoop: window kind change (tool_call → message) → undefined", () => {
  const steps: Step[] = [
    mkStep({
      sequence: 0,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/x" } },
    }),
    mkStep({
      sequence: 1,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/x" } },
    }),
    mkStep({
      sequence: 2,
      action: { kind: "message", text: "thinking..." },
    }),
    mkStep({
      sequence: 3,
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/x" } },
    }),
  ];
  assert.equal(detectLoop(steps, 4), undefined);
});

test("detectLoop: first step in window is not a tool_call → undefined", () => {
  const steps: Step[] = [
    mkStep({ sequence: 0, action: { kind: "message", text: "hi" } }),
    ...Array.from({ length: 3 }, (_, i) =>
      mkStep({
        sequence: i + 1,
        action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/x" } },
      }),
    ),
  ];
  assert.equal(detectLoop(steps, 4), undefined);
});

test("detectLoop: custom window=2 catches shorter loops", () => {
  const steps = Array.from({ length: 2 }, (_, i) =>
    mkStep({
      sequence: i,
      action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "ls" } },
    }),
  );
  const loop = detectLoop(steps, 2);
  assert.ok(loop);
  assert.equal(loop.tool, "Bash");
  assert.equal(loop.repeats, 2);
});

test("detectLoop: signature is truncated to 64 chars", () => {
  // Build a tool_input whose JSON serialization is much longer than 64 chars.
  const longPayload = { x: "a".repeat(200) };
  const steps = Array.from({ length: 4 }, (_, i) =>
    mkStep({
      sequence: i,
      action: { kind: "tool_call", tool_name: "Read", tool_input: longPayload },
    }),
  );
  const loop = detectLoop(steps, 4);
  assert.ok(loop);
  assert.equal(loop.signature.length, 64, "signature truncated to 64 chars");
});

test("detectLoop: tool_input null vs undefined treated as same canonical 'null'", () => {
  // tool_input: undefined and null should both serialize to "null" via the
  // `?? null` guard, so a window mixing them counts as identical.
  const steps: Step[] = [
    mkStep({
      sequence: 0,
      action: { kind: "tool_call", tool_name: "X", tool_input: null },
    }),
    mkStep({
      sequence: 1,
      action: { kind: "tool_call", tool_name: "X", tool_input: undefined as never },
    }),
    mkStep({
      sequence: 2,
      action: { kind: "tool_call", tool_name: "X", tool_input: null },
    }),
    mkStep({
      sequence: 3,
      action: { kind: "tool_call", tool_name: "X", tool_input: undefined as never },
    }),
  ];
  const loop = detectLoop(steps, 4);
  assert.ok(loop, "null and undefined both canonicalize to 'null'");
});

/* ====================================================================
 * Section 4 — Fast-check properties (3 tests)
 * ==================================================================== */

test("property P1: contextUtilization always returns a value in [0, 100]", () => {
  const tokensArb = fc.record({
    input: fc.integer({ min: 0, max: 5_000_000 }),
    output: fc.integer({ min: 0, max: 5_000_000 }),
    cached_read: fc.integer({ min: 0, max: 5_000_000 }),
    cache_creation: fc.integer({ min: 0, max: 5_000_000 }),
  });
  const modelArb = fc.constantFrom(
    "claude-opus-4-7",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-7[1m]",
    "claude-opus-4-7-1m",
    "made-up-model",
  );
  fc.assert(
    fc.property(modelArb, tokensArb, (model, tokens) => {
      const step = mkStep({ model, tokens });
      const u = contextUtilization(step);
      return u >= 0 && u <= 100;
    }),
    { numRuns: 100 },
  );
});

test("property P2: detectLoop returns undefined on any sequence shorter than window", () => {
  const stepArb = fc.record({
    tool: fc.constantFrom("Read", "Edit", "Bash", "Write"),
    input: fc.string({ maxLength: 20 }),
  });
  fc.assert(
    fc.property(
      fc.array(stepArb, { maxLength: 3 }), // ALWAYS shorter than window=4
      (records) => {
        const steps = records.map((r, i) =>
          mkStep({
            sequence: i,
            action: { kind: "tool_call", tool_name: r.tool, tool_input: { x: r.input } },
          }),
        );
        return detectLoop(steps, 4) === undefined;
      },
    ),
    { numRuns: 50 },
  );
});

test("property P3: classifyRunStatus is total — always returns a valid LiveStatus", () => {
  const VALID: LiveStatus[] = [
    "progressing",
    "stalled",
    "looping",
    "awaiting_input",
    "errored",
    "completed",
  ];
  const statusArb = fc.constantFrom(
    "ok",
    "error",
    "in_progress",
    "abandoned" as const,
  );
  const outcomeStatusArb = fc.constantFrom("ok", "error", "pending" as const);
  const ageSecArb = fc.integer({ min: 0, max: 600 });

  fc.assert(
    fc.property(
      statusArb,
      fc.array(outcomeStatusArb, { maxLength: 6 }),
      ageSecArb,
      fc.integer({ min: 1, max: 300 }),
      (runStatus, outcomes, ageSec, stallSec) => {
        const run = mkRun({ status: runStatus });
        const ts = new Date(Date.now() - ageSec * 1000).toISOString();
        const steps = outcomes.map((s, i) =>
          mkStep({ sequence: i, timestamp: ts, outcome: { status: s } }),
        );
        const out = classifyRunStatus(run, steps, stallSec);
        return VALID.includes(out);
      },
    ),
    { numRuns: 100 },
  );
});
