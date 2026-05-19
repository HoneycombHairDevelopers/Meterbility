import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { Store, getStep, listSteps, listRuns } from "@spool/collector";
import { SpoolTracer } from "./tracer.ts";

/**
 * Tier 9 — exhaustive coverage of SpoolStep (packages/agent/src/step.ts).
 *
 * SpoolStep is the TS SDK's step builder: every traced agent funnels
 * through `tracer.startStep() → step.record*() → step.end()`. Before
 * this tier the file had zero direct tests; coverage rode on the four
 * happy-path tests in tracer.test.ts.
 *
 * This file pins every builder method, the status-derivation table,
 * latency rules (explicit vs wall-clock), context-snapshot composition
 * for each StartStepOptions field, the idempotency contract on end(),
 * the cost:approx tag injection, and the run-row total refresh.
 */

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-step-exh-"));
  process.env.SPOOL_HOME = dir;
  return dir;
}

function mkTracer(opts: { runTitle?: string } = {}): SpoolTracer {
  freshHome();
  return new SpoolTracer({
    project: "/tmp/step-exh",
    agent: "tester",
    runTitle: opts.runTitle ?? "step-exh-fixture",
  });
}

function zeroTokens() {
  return { input: 0, output: 0, cached_read: 0, cache_creation: 0 };
}

/* ====================================================================
 * Section 1 — Builder method shape contracts (12 tests)
 * ==================================================================== */

test("construct: step_id has `stp_` prefix and a UUID body", () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  assert.match(
    step.step_id,
    /^stp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
});

test("construct: sequence comes from the tracer's running counter", async () => {
  const tracer = mkTracer();
  const s0 = tracer.startStep({ model: "claude-opus-4-7" });
  assert.equal(s0.sequence, 0);
  await s0.recordTokens({ tokens: zeroTokens() }).end();
  const s1 = tracer.startStep({ model: "claude-opus-4-7" });
  assert.equal(s1.sequence, 1, "second step gets sequence 1");
  await s1.recordTokens({ tokens: zeroTokens() }).end();
  await tracer.end();
});

test("construct: StartStepOptions.tags carry through to the step's final tags", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    tags: ["benchmark", "fast"],
  });
  await step.recordTokens({ tokens: zeroTokens() }).end();
  await tracer.end();
  const inspect = Store.open();
  const steps = listSteps(inspect, listRuns(inspect)[0]!.run_id);
  assert.deepEqual(
    steps[0]!.tags.filter((t) => t !== "cost:approx").sort(),
    ["benchmark", "fast"],
  );
  inspect.close();
});

test("recordDecision: stores both decision content + action", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordDecision({
      decision: { thinking: "I should call Read", choice: "Read" },
      action: { kind: "tool_call", tool_name: "Read", tool_input: { path: "/x" } },
    })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.action.kind, "tool_call");
  if (persisted.action.kind === "tool_call") {
    assert.equal(persisted.action.tool_name, "Read");
  }
  assert.ok(persisted.decision_ref);
  await tracer.end();
});

test("recordAction: overwrites the action shape", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordToolCall("Read", { path: "/a" })
    .recordAction({ kind: "message", text: "actually never mind" })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.action.kind, "message");
  await tracer.end();
});

test("recordToolCall: produces a tool_call action with name/input/id", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordToolCall("Bash", { command: "ls" }, "tu_abc")
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.action.kind, "tool_call");
  if (persisted.action.kind === "tool_call") {
    assert.equal(persisted.action.tool_name, "Bash");
    assert.equal(persisted.action.tool_use_id, "tu_abc");
    assert.deepEqual(persisted.action.tool_input, { command: "ls" });
  }
  await tracer.end();
});

test("recordToolCall: id is optional", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordToolCall("Read", { path: "/x" }).recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  if (persisted.action.kind === "tool_call") {
    assert.equal(persisted.action.tool_use_id, undefined);
  }
  await tracer.end();
});

test("recordMessage: produces a message action with the text", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordMessage("hello, world").recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.action.kind, "message");
  if (persisted.action.kind === "message") {
    assert.equal(persisted.action.text, "hello, world");
  }
  await tracer.end();
});

test("recordOutcome: stores a structured Outcome verbatim", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordOutcome({ outcome: { status: "ok", summary: "did it" } })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.outcome.status, "ok");
  assert.equal(persisted.outcome.summary, "did it");
  await tracer.end();
});

test("recordToolResult: ok path → outcome.status ok, is_error false, blob ref present", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordToolResult({ output: "file contents" }, { summary: "read ok" })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.outcome.status, "ok");
  assert.equal(persisted.outcome.is_error, false);
  assert.equal(persisted.outcome.summary, "read ok");
  assert.ok(persisted.outcome.tool_result_ref, "tool_result_ref persisted");
  await tracer.end();
});

test("recordToolResult: error path → outcome.status error, is_error true", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordToolResult("EACCES", { isError: true, summary: "permission denied" })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.outcome.status, "error");
  assert.equal(persisted.outcome.is_error, true);
  await tracer.end();
});

test("recordTokens: stores tokens exactly + explicit latency_ms is preserved", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({
    tokens: {
      input: 1234,
      output: 56,
      cached_read: 78,
      cache_creation: 9,
      cache_creation_1h: 1,
    },
    latency_ms: 999,
  });
  const persisted = await step.end();
  assert.equal(persisted.tokens.input, 1234);
  assert.equal(persisted.tokens.output, 56);
  assert.equal(persisted.tokens.cached_read, 78);
  assert.equal(persisted.tokens.cache_creation, 9);
  assert.equal(persisted.tokens.cache_creation_1h, 1);
  assert.equal(persisted.latency_ms, 999, "explicit latency wins");
  await tracer.end();
});

/* ====================================================================
 * Section 2 — Tag management (3 tests)
 * ==================================================================== */

test("tag: adds new tag to the step's tag list", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.tag("manual").recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.ok(persisted.tags.includes("manual"));
  await tracer.end();
});

test("tag: is idempotent — adding the same tag twice doesn't duplicate", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.tag("retry").tag("retry").tag("retry").recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const retryCount = persisted.tags.filter((t) => t === "retry").length;
  assert.equal(retryCount, 1, "tag deduplicated");
  await tracer.end();
});

test("tag: chains with construction tags from StartStepOptions", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    tags: ["benchmark"],
  });
  step.tag("manual-add").recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const userTags = persisted.tags.filter((t) => t !== "cost:approx").sort();
  assert.deepEqual(userTags, ["benchmark", "manual-add"]);
  await tracer.end();
});

/* ====================================================================
 * Section 3 — end() persistence (7 tests)
 * ==================================================================== */

test("end: persists the step row reachable via getStep(store, step_id)", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({ tokens: zeroTokens() });
  const stepId = step.step_id;
  await step.end();
  const inspect = Store.open();
  const fetched = getStep(inspect, stepId);
  assert.ok(fetched, "row persisted");
  assert.equal(fetched.step_id, stepId);
  inspect.close();
  await tracer.end();
});

test("end: persists a context snapshot blob (decision_ref + snapshot_id populated)", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    systemPrompt: "you are a tester",
  });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.ok(persisted.context_snapshot_id, "snapshot id set");
  assert.ok(persisted.decision_ref, "decision ref set");
  // Verify the snapshot blob is actually retrievable from the store.
  const inspect = Store.open();
  const { resolveSnapshotBlobRef } = await import("@spool/collector");
  const ref = resolveSnapshotBlobRef(inspect, persisted.context_snapshot_id);
  const text = await inspect.blobs.tryGetString(ref);
  assert.ok(text, "snapshot blob fetched back");
  inspect.close();
  await tracer.end();
});

test("end: persists tool_result blob ONLY when recordToolResult was called", async () => {
  const tracer = mkTracer();
  // Step A — never called recordToolResult
  const stepA = tracer.startStep({ model: "claude-opus-4-7" });
  stepA.recordToolCall("Read", { path: "/x" }).recordTokens({ tokens: zeroTokens() });
  const a = await stepA.end();
  assert.equal(
    a.outcome.tool_result_ref,
    undefined,
    "no tool_result_ref when recordToolResult skipped",
  );
  // Step B — called recordToolResult
  const stepB = tracer.startStep({ model: "claude-opus-4-7" });
  stepB
    .recordToolCall("Read", { path: "/y" })
    .recordToolResult("contents")
    .recordTokens({ tokens: zeroTokens() });
  const b = await stepB.end();
  assert.ok(
    b.outcome.tool_result_ref,
    "tool_result_ref present when recordToolResult fired",
  );
  await tracer.end();
});

test("end: returns the full Step shape", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordToolCall("Read", { path: "/x" }).recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  // Spot-check every documented field is present.
  assert.ok(persisted.step_id);
  assert.ok(persisted.run_id);
  assert.equal(typeof persisted.sequence, "number");
  assert.ok(persisted.timestamp);
  assert.equal(persisted.model, "claude-opus-4-7");
  assert.ok(persisted.context_snapshot_id);
  assert.ok(persisted.decision_ref);
  assert.ok(persisted.action);
  assert.ok(persisted.outcome);
  assert.ok(persisted.tokens);
  assert.equal(typeof persisted.latency_ms, "number");
  assert.equal(typeof persisted.cost_cents, "number");
  assert.ok(Array.isArray(persisted.tags));
  assert.ok(persisted.status);
  await tracer.end();
});

test("end: called twice throws (idempotency contract)", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({ tokens: zeroTokens() });
  await step.end();
  await assert.rejects(() => step.end(), /twice|already ended/i);
  await tracer.end();
});

test("end: applies 'cost:approx' tag when costCents returns approx=true (unknown model)", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "model-that-pricing-doesnt-know-about" });
  step.recordTokens({
    tokens: { input: 100, output: 50, cached_read: 0, cache_creation: 0 },
  });
  const persisted = await step.end();
  assert.ok(
    persisted.tags.includes("cost:approx"),
    "approx tag added for unknown model",
  );
  await tracer.end();
});

test("end: does NOT apply 'cost:approx' when pricing is known (exact)", async () => {
  const tracer = mkTracer();
  // claude-opus-4-7 is a known model with exact pricing tables
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({
    tokens: { input: 100, output: 50, cached_read: 0, cache_creation: 0 },
  });
  const persisted = await step.end();
  assert.ok(
    !persisted.tags.includes("cost:approx"),
    "approx tag NOT added for known-pricing model",
  );
  await tracer.end();
});

/* ====================================================================
 * Section 4 — Status derivation (4 tests)
 *
 * outcome.status → step.status mapping:
 *   "ok"      → "ok"
 *   "error"   → "error"
 *   "pending" → "in_progress"  (never recordOutcome'd)
 * ==================================================================== */

test("status: outcome.status 'ok' (via recordToolResult) → step.status 'ok'", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordToolCall("Read", { path: "/x" })
    .recordToolResult("contents", { isError: false })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.status, "ok");
  await tracer.end();
});

test("status: outcome.status 'error' (via recordToolResult isError:true) → step.status 'error'", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordToolCall("Read", { path: "/x" })
    .recordToolResult("EACCES", { isError: true })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.status, "error");
  await tracer.end();
});

test("status: outcome.status 'pending' (never set) → step.status 'in_progress'", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  // No recordOutcome, no recordToolResult — outcome stays at construct-time default
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.status, "in_progress", "pending outcome maps to in_progress");
  await tracer.end();
});

test("status: explicit recordOutcome with status='error' → step.status 'error'", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step
    .recordOutcome({ outcome: { status: "error", is_error: true } })
    .recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  assert.equal(persisted.status, "error");
  await tracer.end();
});

/* ====================================================================
 * Section 5 — Latency (3 tests)
 * ==================================================================== */

test("latency: explicit latency_ms via recordTokens is preserved verbatim", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({ tokens: zeroTokens(), latency_ms: 12345 });
  const persisted = await step.end();
  assert.equal(persisted.latency_ms, 12345);
  await tracer.end();
});

test("latency: explicit 0 is honored (no truthy-fallback)", async () => {
  // Bug-likely: a `latency_ms || Date.now() - startedAtMs` pattern would
  // treat 0 as falsy and use wall-clock. Tests against that mistake.
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({ tokens: zeroTokens(), latency_ms: 0 });
  const persisted = await step.end();
  assert.equal(persisted.latency_ms, 0, "explicit 0 must not fall back");
  await tracer.end();
});

test("latency: no explicit latency → wall-clock computed (>= 0)", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({ tokens: zeroTokens() });
  // Brief async pause so wall-clock !== 0.
  await new Promise((r) => setTimeout(r, 5));
  const persisted = await step.end();
  assert.ok(persisted.latency_ms >= 0, "wall-clock latency is non-negative");
  await tracer.end();
});

/* ====================================================================
 * Section 6 — Context snapshot composition (6 tests)
 *
 * Each StartStepOptions field maps to a specific ContextComponent shape.
 * Pin each mapping independently so a refactor of buildContextComponents
 * can't silently drop a field.
 * ==================================================================== */

async function readContext(stepId: string): Promise<unknown[]> {
  const inspect = Store.open();
  try {
    const step = getStep(inspect, stepId)!;
    const { resolveSnapshotBlobRef } = await import("@spool/collector");
    const ref = resolveSnapshotBlobRef(inspect, step.context_snapshot_id);
    const text = await inspect.blobs.getString(ref);
    const snapshot = JSON.parse(text) as { components: unknown[] };
    return snapshot.components;
  } finally {
    inspect.close();
  }
}

test("context: empty StartStepOptions → empty components array", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({ model: "claude-opus-4-7" });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const components = await readContext(persisted.step_id);
  assert.deepEqual(components, [], "no components when no context fields");
  await tracer.end();
});

test("context: systemPrompt → one system_prompt component", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    systemPrompt: "you are a tester",
  });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const components = await readContext(persisted.step_id);
  assert.equal(components.length, 1);
  assert.equal((components[0] as { type: string }).type, "system_prompt");
  assert.ok((components[0] as { content_ref: string }).content_ref);
  await tracer.end();
});

test("context: toolDefinitions → one tool_definitions component", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    toolDefinitions: [{ name: "Read", description: "reads files" }],
  });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const components = await readContext(persisted.step_id);
  assert.equal(components.length, 1);
  assert.equal((components[0] as { type: string }).type, "tool_definitions");
  await tracer.end();
});

test("context: history → one conversation_history component with N message refs", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    history: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "second" },
    ],
  });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const components = await readContext(persisted.step_id);
  assert.equal(components.length, 1);
  const hist = components[0] as {
    type: string;
    messages: Array<{ role: string; content_ref: string }>;
  };
  assert.equal(hist.type, "conversation_history");
  assert.equal(hist.messages.length, 3);
  assert.equal(hist.messages[0]!.role, "user");
  assert.ok(hist.messages[0]!.content_ref);
  await tracer.end();
});

test("context: retrievedDocs → one retrieved_documents component with N refs", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    retrievedDocs: [
      { source: "docs.md", content: "doc one" },
      { source: "guide.md", content: "doc two" },
    ],
  });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const components = await readContext(persisted.step_id);
  assert.equal(components.length, 1);
  const docs = components[0] as {
    type: string;
    docs: Array<{ source: string; content_ref: string }>;
  };
  assert.equal(docs.type, "retrieved_documents");
  assert.equal(docs.docs.length, 2);
  assert.equal(docs.docs[0]!.source, "docs.md");
  await tracer.end();
});

test("context: all four fields together produce all four components", async () => {
  const tracer = mkTracer();
  const step = tracer.startStep({
    model: "claude-opus-4-7",
    systemPrompt: "system",
    toolDefinitions: [{ name: "Read" }],
    history: [{ role: "user", content: "hi" }],
    retrievedDocs: [{ source: "x.md", content: "y" }],
  });
  step.recordTokens({ tokens: zeroTokens() });
  const persisted = await step.end();
  const components = await readContext(persisted.step_id);
  const types = components.map((c) => (c as { type: string }).type);
  assert.deepEqual(types, [
    "system_prompt",
    "tool_definitions",
    "conversation_history",
    "retrieved_documents",
  ]);
  await tracer.end();
});

/* ====================================================================
 * Section 7 — Collector integration (4 tests)
 *
 * Verifies SpoolStep wires correctly into the surrounding tracer: run
 * row totals get refreshed, multiple steps share the run_id, status
 * counters increment, and step ordering is preserved.
 * ==================================================================== */

test("integration: multiple steps share the same run_id", async () => {
  const tracer = mkTracer();
  const s0 = tracer.startStep({ model: "claude-opus-4-7" });
  await s0.recordTokens({ tokens: zeroTokens() }).end();
  const s1 = tracer.startStep({ model: "claude-opus-4-7" });
  await s1.recordTokens({ tokens: zeroTokens() }).end();
  await tracer.end();

  const inspect = Store.open();
  const steps = listSteps(inspect, listRuns(inspect)[0]!.run_id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.run_id, steps[1]!.run_id, "shared run_id");
  inspect.close();
});

test("integration: end() triggers _refreshTotals on the run row", async () => {
  const tracer = mkTracer();
  for (let i = 0; i < 3; i++) {
    const step = tracer.startStep({ model: "claude-opus-4-7" });
    step.recordTokens({
      tokens: { input: 100, output: 50, cached_read: 0, cache_creation: 0 },
    });
    await step.end();
  }
  await tracer.end();

  const inspect = Store.open();
  const run = listRuns(inspect)[0]!;
  assert.equal(run.step_count, 3, "step_count reflects three end() calls");
  assert.equal(run.tokens_total_input, 300, "input tokens summed");
  assert.equal(run.tokens_total_output, 150, "output tokens summed");
  inspect.close();
});

test("integration: context_snapshot_id is the hash of the components array (deterministic)", async () => {
  // Two steps with identical context options should produce the same
  // snapshot id — that's what powers blob-store dedup.
  const tracer = mkTracer();
  const opts = {
    model: "claude-opus-4-7" as const,
    systemPrompt: "same prompt",
  };
  const s0 = tracer.startStep(opts);
  s0.recordTokens({ tokens: zeroTokens() });
  const p0 = await s0.end();

  const s1 = tracer.startStep(opts);
  s1.recordTokens({ tokens: zeroTokens() });
  const p1 = await s1.end();

  assert.equal(
    p0.context_snapshot_id,
    p1.context_snapshot_id,
    "identical context options produce identical snapshot ids",
  );
  await tracer.end();
});

test("integration: distinct context options produce distinct snapshot ids", async () => {
  const tracer = mkTracer();
  const s0 = tracer.startStep({
    model: "claude-opus-4-7",
    systemPrompt: "first prompt",
  });
  s0.recordTokens({ tokens: zeroTokens() });
  const p0 = await s0.end();

  const s1 = tracer.startStep({
    model: "claude-opus-4-7",
    systemPrompt: "different prompt",
  });
  s1.recordTokens({ tokens: zeroTokens() });
  const p1 = await s1.end();

  assert.notEqual(p0.context_snapshot_id, p1.context_snapshot_id);
  await tracer.end();
});

/* ====================================================================
 * Section 8 — Fast-check properties (3 tests)
 * ==================================================================== */

const TAG_CHAR = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789-_".split(""),
);
const tagArb = fc.string({ unit: TAG_CHAR, minLength: 1, maxLength: 12 });

test("property P1: step_id always matches the documented `stp_<UUID>` shape", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 5 }), (_seed) => {
      const tracer = mkTracer();
      try {
        const step = tracer.startStep({ model: "claude-opus-4-7" });
        return /^stp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          step.step_id,
        );
      } finally {
        // No end() needed — the step is never persisted, just constructed.
      }
    }),
    { numRuns: 20 },
  );
});

test("property P2: tag() deduplicates — N applications of the same tag count as 1", async () => {
  await fc.assert(
    fc.asyncProperty(
      tagArb,
      fc.integer({ min: 1, max: 10 }),
      async (tag, n) => {
        const tracer = mkTracer();
        const step = tracer.startStep({ model: "claude-opus-4-7" });
        for (let i = 0; i < n; i++) step.tag(tag);
        step.recordTokens({ tokens: zeroTokens() });
        const persisted = await step.end();
        await tracer.end();
        return persisted.tags.filter((t) => t === tag).length === 1;
      },
    ),
    { numRuns: 15 },
  );
});

test("property P3: recordTokens stores token values exactly (no coercion)", async () => {
  const tokenArb = fc.record({
    input: fc.integer({ min: 0, max: 100_000 }),
    output: fc.integer({ min: 0, max: 100_000 }),
    cached_read: fc.integer({ min: 0, max: 100_000 }),
    cache_creation: fc.integer({ min: 0, max: 100_000 }),
  });
  await fc.assert(
    fc.asyncProperty(tokenArb, async (tokens) => {
      const tracer = mkTracer();
      const step = tracer.startStep({ model: "claude-opus-4-7" });
      step.recordTokens({ tokens });
      const persisted = await step.end();
      await tracer.end();
      return (
        persisted.tokens.input === tokens.input &&
        persisted.tokens.output === tokens.output &&
        persisted.tokens.cached_read === tokens.cached_read &&
        persisted.tokens.cache_creation === tokens.cache_creation
      );
    }),
    { numRuns: 15 },
  );
});
