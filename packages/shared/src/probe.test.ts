import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProbe,
  confirmPaused,
  consumeInject,
  probeFilePath,
  readState,
  requestPause,
  requestResume,
  setInject,
} from "./probe.ts";

/**
 * Probe protocol tests — chunk 1 / Turn 8. The protocol is the
 * foundation every other Probe surface (TS SDK, Python SDK, CLI, web
 * panel) talks to, so the contract has to be airtight before we layer
 * anything on top.
 */

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-probe-"));
  process.env.METERBILITY_HOME = dir;
  return dir;
}

// Deterministic clock: tests want to assert on specific timestamps.
function clockFrom(start: number) {
  let n = start;
  return () => {
    const v = n;
    n += 1;
    return v;
  };
}

test("readState on a run with no probe file returns the default running record", () => {
  freshHome();
  const r = readState("run_abc");
  assert.equal(r.state, "running");
  assert.equal(r.inject, null);
  assert.equal(r.run_id, "run_abc");
  assert.equal(r.requested_at_ms, null);
  assert.equal(r.paused_at_ms, null);
  assert.equal(r.resumed_at_ms, null);
});

test("requestPause transitions running → pause_requested and stamps requested_at_ms", () => {
  freshHome();
  const clock = clockFrom(1000);
  const r = requestPause("run_p", clock);
  assert.equal(r.state, "pause_requested");
  assert.equal(r.requested_at_ms, 1000);
  // Persisted to disk:
  const r2 = readState("run_p");
  assert.equal(r2.state, "pause_requested");
  assert.equal(r2.requested_at_ms, 1000);
});

test("requestPause is idempotent — repeated calls preserve requested_at_ms", () => {
  freshHome();
  const clock = clockFrom(1000);
  requestPause("run_p", clock);
  const r2 = requestPause("run_p", clock);
  assert.equal(r2.state, "pause_requested");
  assert.equal(r2.requested_at_ms, 1000, "second pause should not bump the stamp");
});

test("confirmPaused transitions pause_requested → paused and stamps paused_at_ms", () => {
  freshHome();
  const clock = clockFrom(1000);
  requestPause("run_p", clock); // 1000
  const r = confirmPaused("run_p", clock); // 1001
  assert.equal(r.state, "paused");
  assert.equal(r.paused_at_ms, 1001);
  assert.equal(r.requested_at_ms, 1000, "earlier stamp preserved across confirm");
});

test("confirmPaused is a no-op when not in pause_requested (handles operator-resumed race)", () => {
  freshHome();
  // Operator never paused; SDK shouldn't be able to flip to paused.
  const r = confirmPaused("run_p");
  assert.equal(r.state, "running");
  assert.equal(r.paused_at_ms, null);
});

test("confirmPaused is idempotent — second call after already paused doesn't change paused_at_ms", () => {
  freshHome();
  const clock = clockFrom(1000);
  requestPause("run_p", clock);
  confirmPaused("run_p", clock);
  const r = confirmPaused("run_p", clock);
  assert.equal(r.state, "paused");
  assert.equal(r.paused_at_ms, 1001, "second confirm should not re-stamp");
});

test("setInject queues a message in any state and persists across reads", () => {
  freshHome();
  setInject("run_i", "hey, you forgot to check the failing test");
  const r = readState("run_i");
  assert.equal(r.inject, "hey, you forgot to check the failing test");
  assert.equal(r.state, "running", "inject without pause leaves state untouched");
});

test("setInject works while paused (the natural pause→inject→resume flow)", () => {
  freshHome();
  requestPause("run_i");
  confirmPaused("run_i");
  setInject("run_i", "reset fixtures first");
  const r = readState("run_i");
  assert.equal(r.state, "paused", "pause state must survive inject");
  assert.equal(r.inject, "reset fixtures first");
});

test("setInject overwrites a pending inject (operator UI is responsible for warning)", () => {
  freshHome();
  setInject("run_i", "first message");
  setInject("run_i", "second message");
  assert.equal(readState("run_i").inject, "second message");
});

test("consumeInject returns the pending message and clears it", () => {
  freshHome();
  setInject("run_c", "delivered nudge");
  const taken = consumeInject("run_c");
  assert.equal(taken, "delivered nudge");
  assert.equal(readState("run_c").inject, null, "inject cleared after consume");
});

test("consumeInject returns null when nothing is queued", () => {
  freshHome();
  assert.equal(consumeInject("run_c"), null);
  // And on a never-touched run:
  assert.equal(consumeInject("run_never"), null);
});

test("consumeInject preserves state — clearing an inject does not unpause", () => {
  freshHome();
  requestPause("run_c");
  confirmPaused("run_c");
  setInject("run_c", "while paused");
  consumeInject("run_c");
  const r = readState("run_c");
  assert.equal(r.state, "paused", "draining inject must not change pause state");
  assert.equal(r.inject, null);
});

test("requestResume transitions paused → running and stamps resumed_at_ms", () => {
  freshHome();
  const clock = clockFrom(1000);
  requestPause("run_r", clock); // 1000
  confirmPaused("run_r", clock); // 1001
  const r = requestResume("run_r", clock); // 1002
  assert.equal(r.state, "running");
  assert.equal(r.resumed_at_ms, 1002);
});

test("requestResume from pause_requested also resolves (operator changes mind before SDK polls)", () => {
  freshHome();
  requestPause("run_r");
  const r = requestResume("run_r");
  assert.equal(r.state, "running", "cancelling a pause request is legal");
});

test("requestResume preserves a pending inject — operator can resume-with-message", () => {
  freshHome();
  requestPause("run_r");
  confirmPaused("run_r");
  setInject("run_r", "carry this forward");
  requestResume("run_r");
  const r = readState("run_r");
  assert.equal(r.state, "running");
  assert.equal(r.inject, "carry this forward", "inject survives resume");
});

test("clearProbe removes the file; subsequent readState returns the default", () => {
  freshHome();
  requestPause("run_clear");
  assert.ok(existsSync(probeFilePath("run_clear")));
  clearProbe("run_clear");
  assert.equal(existsSync(probeFilePath("run_clear")), false);
  // Default record after clear:
  const r = readState("run_clear");
  assert.equal(r.state, "running");
});

test("clearProbe is safe when no file exists (idempotent terminal cleanup)", () => {
  freshHome();
  assert.doesNotThrow(() => clearProbe("run_never"));
});

test("readState gracefully degrades when the file is corrupt", () => {
  freshHome();
  // Force a probe file to exist so we hit the parse path, then clobber it.
  requestPause("run_corrupt");
  const path = probeFilePath("run_corrupt");
  // Simulate a half-written file (rare with atomic rename, but possible
  // if a user edits the file by hand).
  writeFileSync(path, "{not json", "utf-8");
  const r = readState("run_corrupt");
  assert.equal(r.state, "running", "corrupt file collapses to safe default");
});

test("readState normalizes unknown state strings to running (defense-in-depth)", () => {
  freshHome();
  requestPause("run_n");
  // Hand-edit the file to a state value not in the enum:
  const path = probeFilePath("run_n");
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  raw.state = "marquee-mode-engaged";
  writeFileSync(path, JSON.stringify(raw), "utf-8");
  const r = readState("run_n");
  assert.equal(r.state, "running", "unknown state must collapse to running");
});

test("probeFilePath URL-encodes the run id so weird characters don't escape the dir", () => {
  freshHome();
  // Defensive: a malicious or malformed run_id with path traversal in
  // it shouldn't be able to write outside $METERBILITY_HOME/probe/.
  const evil = "../../escape";
  const path = probeFilePath(evil);
  assert.ok(
    path.endsWith("%2F..%2Fescape.json") || path.endsWith("..%2F..%2Fescape.json"),
    `expected URL-encoded path, got ${path}`,
  );
});

test("two consecutive mutations on different runs don't collide", () => {
  // Different run ids get different files, so operations are isolated.
  freshHome();
  requestPause("run_a");
  setInject("run_b", "for b");
  const a = readState("run_a");
  const b = readState("run_b");
  assert.equal(a.state, "pause_requested");
  assert.equal(a.inject, null);
  assert.equal(b.state, "running");
  assert.equal(b.inject, "for b");
});
