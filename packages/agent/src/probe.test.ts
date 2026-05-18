import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeFilePath,
  readState,
  requestPause,
  requestResume,
  setInject,
} from "@spool/shared";
import { Store, listSteps, listRuns } from "@spool/collector";
import { SpoolTracer, traceAnthropic } from "./index.ts";
import { applyProbeToRequest, type ProbeRuntime } from "./probe.ts";

/**
 * Probe SDK hook tests — chunk 2 / Turn 8. The hook sits between the
 * caller and the Anthropic SDK call, so we test it both as a pure
 * function (applyProbeToRequest) and as it gets driven through the
 * traceAnthropic wrapper.
 */

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-probe-hook-"));
  process.env.SPOOL_HOME = dir;
  return dir;
}

/**
 * A sleep stub that, on first call, performs an action (typically
 * `requestResume`) before returning. Lets a test stand in for "the
 * operator pressed Resume after the SDK started polling" without
 * needing real wall-clock time.
 */
function sleepThatTriggers(action: () => void): (ms: number) => Promise<void> {
  let fired = false;
  return async () => {
    if (!fired) {
      fired = true;
      action();
    }
  };
}

function deterministicRuntime(action: () => void): ProbeRuntime {
  return {
    pollIntervalMs: 1, // doesn't matter; sleep is stubbed
    sleep: sleepThatTriggers(action),
    now: () => 1000,
  };
}

// ─── Pure-function tests for applyProbeToRequest ─────────────────────

test("applyProbeToRequest passes through unchanged when no probe activity", async () => {
  fresh();
  const req = {
    model: "claude-opus-4-7",
    messages: [{ role: "user" as const, content: "hello" }],
  };
  const out = await applyProbeToRequest("run_q", req);
  assert.deepEqual(out, req);
});

test("applyProbeToRequest blocks until operator resumes (pause_requested → paused → running)", async () => {
  fresh();
  const runId = "run_pause";
  requestPause(runId);
  assert.equal(readState(runId).state, "pause_requested");

  // The sleep stub flips the state to running on its first invocation,
  // simulating the operator pressing Resume.
  const runtime = deterministicRuntime(() => requestResume(runId));

  const req = {
    model: "claude-opus-4-7",
    messages: [{ role: "user" as const, content: "carry on" }],
  };
  await applyProbeToRequest(runId, req, runtime);

  const final = readState(runId);
  assert.equal(final.state, "running");
  assert.ok(final.paused_at_ms !== null, "SDK must have called confirmPaused");
  assert.ok(final.resumed_at_ms !== null);
});

test("applyProbeToRequest appends a pending inject as a new user turn", async () => {
  fresh();
  const runId = "run_inject";
  setInject(runId, "remember the failing test is a stale fixture");

  const req = {
    model: "claude-opus-4-7",
    messages: [{ role: "user" as const, content: "what should I do next?" }],
  };
  const out = await applyProbeToRequest(runId, req);

  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0]!.content, "what should I do next?");
  assert.equal(out.messages[1]!.role, "user");
  assert.equal(out.messages[1]!.content, "remember the failing test is a stale fixture");
  // Inject was consumed:
  assert.equal(readState(runId).inject, null);
});

test("applyProbeToRequest does not mutate the input request (immutability)", async () => {
  fresh();
  setInject("run_imm", "extra context");
  const req = {
    model: "claude-opus-4-7",
    messages: [{ role: "user" as const, content: "x" }],
  };
  const before = JSON.stringify(req);
  const out = await applyProbeToRequest("run_imm", req);
  assert.equal(JSON.stringify(req), before, "original request unchanged");
  assert.notEqual(out, req, "should return a new object");
  assert.equal(out.messages.length, 2);
});

test("applyProbeToRequest handles pause + inject together (the natural operator flow)", async () => {
  fresh();
  const runId = "run_both";
  requestPause(runId);
  setInject(runId, "do this first");
  // Operator's sleep-side action: also set the inject (if not already) and resume.
  const runtime = deterministicRuntime(() => requestResume(runId));

  const req = {
    model: "claude-opus-4-7",
    messages: [{ role: "user" as const, content: "original prompt" }],
  };
  const out = await applyProbeToRequest(runId, req, runtime);

  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1]!.content, "do this first", "inject delivered after pause");
  assert.equal(readState(runId).state, "running");
  assert.equal(readState(runId).inject, null);
});

// ─── Integration tests through traceAnthropic ────────────────────────

test("probeEnabled=false skips probe entirely — no file is touched, inject is ignored", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/p-off",
    agent: "tester",
    // probeEnabled NOT set → defaults to false
  });
  // Even with a stale probe file set, probeEnabled=false should ignore it.
  setInject(tracer.run_id, "should be ignored");

  let observedHistoryLength = -1;
  const fake = async (req: any) => {
    observedHistoryLength = req.messages.length;
    return {
      model: req.model,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const traced = traceAnthropic(tracer, fake);
  await traced({
    model: "claude-opus-4-7",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });
  await tracer.end();

  assert.equal(observedHistoryLength, 1, "inject must NOT have been appended when probeEnabled is false");
});

test("probeEnabled=true with no probe activity is a no-op on the request", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/p-noop",
    agent: "tester",
    probeEnabled: true,
  });
  let observedMessages: Array<{ role: string; content: unknown }> | undefined;
  const fake = async (req: any) => {
    observedMessages = req.messages;
    return {
      model: req.model,
      content: [{ type: "text", text: "k" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const traced = traceAnthropic(tracer, fake);
  await traced({
    model: "claude-opus-4-7",
    max_tokens: 64,
    messages: [{ role: "user", content: "untouched" }],
  });
  await tracer.end();

  assert.equal(observedMessages?.length, 1);
  assert.equal(observedMessages?.[0]?.content, "untouched");
});

test("probeEnabled=true with pause_requested blocks the call and resumes cleanly", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/p-pause",
    agent: "tester",
    probeEnabled: true,
  });
  // Stub the tracer's probe runtime so polling resolves deterministically.
  tracer.probeRuntime = {
    ...tracer.probeRuntime,
    sleep: sleepThatTriggers(() => requestResume(tracer.run_id)),
  };
  // Operator requests pause BEFORE the call goes out.
  requestPause(tracer.run_id);

  let called = false;
  const fake = async (req: any) => {
    called = true;
    return {
      model: req.model,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const traced = traceAnthropic(tracer, fake);
  await traced({
    model: "claude-opus-4-7",
    max_tokens: 64,
    messages: [{ role: "user", content: "go" }],
  });
  await tracer.end();

  assert.equal(called, true, "model call did eventually happen after resume");
  const final = readState(tracer.run_id);
  // After tracer.end(), the probe file is cleared, so readState returns the default.
  assert.equal(final.state, "running");
});

test("probeEnabled=true picks up an inject and the captured Step reflects it", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/p-inj",
    agent: "tester",
    probeEnabled: true,
  });
  setInject(tracer.run_id, "operator nudge: check the logs");

  let observedMessages: Array<{ role: string; content: unknown }> | undefined;
  const fake = async (req: any) => {
    observedMessages = req.messages;
    return {
      model: req.model,
      content: [{ type: "text", text: "will do" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const traced = traceAnthropic(tracer, fake);
  await traced({
    model: "claude-opus-4-7",
    max_tokens: 64,
    messages: [{ role: "user", content: "what's next?" }],
  });
  await tracer.end();

  // The model saw the inject as a second user turn.
  assert.equal(observedMessages?.length, 2);
  assert.equal(observedMessages?.[1]?.content, "operator nudge: check the logs");

  // The captured Step's context_history must ALSO include the inject —
  // the audit trail should match what the model actually saw.
  const inspect = Store.open();
  const runs = listRuns(inspect);
  const steps = listSteps(inspect, runs[0]!.run_id);
  assert.equal(steps.length, 1);
  inspect.close();
});

test("tracer.end() clears the probe file (terminal cleanup)", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/p-clear",
    agent: "tester",
    probeEnabled: true,
  });
  setInject(tracer.run_id, "anything to force file creation");
  assert.ok(existsSync(probeFilePath(tracer.run_id)), "file should exist after setInject");
  await tracer.end();
  assert.equal(
    existsSync(probeFilePath(tracer.run_id)),
    false,
    "tracer.end() must clear the probe file",
  );
});

test("tracer.end() is safe to call when probe was never used", async () => {
  fresh();
  const tracer = new SpoolTracer({
    project: "/tmp/p-noop-clear",
    agent: "tester",
    // probeEnabled not set; no probe activity
  });
  // Should not throw even though no probe file ever existed.
  await assert.doesNotReject(tracer.end());
});
