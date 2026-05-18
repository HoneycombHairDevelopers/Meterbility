import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store, insertRun, upsertAgent, upsertProjectByCwd } from "@spool/collector";
import {
  probeFilePath,
  readState,
  requestPause,
  setInject,
} from "@spool/shared";
import type { Run } from "@spool/shared";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(TEST_DIR, "index.ts");
const REPO_ROOT = resolve(TEST_DIR, "../../..");

/**
 * `spool probe` CLI tests — Turn 8 chunk 4.
 *
 * Strategy mirrors `files.test.ts`: shell out to the actual CLI binary
 * via tsx so the test exercises Commander registration, subcommand
 * routing, argument parsing, and the probe protocol end-to-end. The
 * store + probe directory live under a per-test SPOOL_HOME so nothing
 * escapes.
 */

interface Fixture {
  home: string;
  runId: string;
}

/**
 * Set up: fresh $SPOOL_HOME, insert one Run row so getRun resolves,
 * return the resolved run id.
 */
function setupFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "spool-probe-cli-"));
  process.env.SPOOL_HOME = home;
  const store = Store.open({ path: join(home, "spool.db") });
  const project = upsertProjectByCwd(store, "/tmp/probe-cli", "probe-cli");
  const agent = upsertAgent(store, project.project_id, "tester");
  const runId = "run_11111111-2222-3333-4444-555555555555";
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "sdk-ts",
    status: "in_progress",
    started_at: new Date().toISOString(),
    cwd: "/tmp/probe-cli",
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  };
  insertRun(store, run);
  store.close();
  return { home, runId };
}

/** Invoke the actual CLI in a subprocess; returns {stdout, stderr, status}. */
function runCli(
  args: string[],
  fx: Fixture,
  stdinInput?: string,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", CLI_ENTRY, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...process.env, SPOOL_HOME: fx.home, NO_COLOR: "1" },
      input: stdinInput,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

test("`probe status` on a fresh run prints state=running and inject=none", () => {
  const fx = setupFixture();
  const r = runCli(["probe", "status", fx.runId], fx);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /state\s+running/);
  assert.match(r.stdout, /inject\s+none/);
});

test("`probe status --json` emits a parseable ProbeRecord", () => {
  const fx = setupFixture();
  const r = runCli(["probe", "status", fx.runId, "--json"], fx);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.run_id, fx.runId);
  assert.equal(parsed.state, "running");
  assert.equal(parsed.inject, null);
});

test("`probe pause` transitions state to pause_requested and writes the file", () => {
  const fx = setupFixture();
  const r = runCli(["probe", "pause", fx.runId], fx);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /pause requested/);
  const state = readState(fx.runId);
  assert.equal(state.state, "pause_requested");
  assert.ok(state.requested_at_ms !== null);
});

test("`probe pause` on an already-paused run reports without changing timestamps", () => {
  const fx = setupFixture();
  requestPause(fx.runId);
  const before = readState(fx.runId);
  const r = runCli(["probe", "pause", fx.runId], fx);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already pause_requested/);
  const after = readState(fx.runId);
  assert.equal(after.requested_at_ms, before.requested_at_ms);
});

test("`probe inject -m <msg>` queues the message", () => {
  const fx = setupFixture();
  const r = runCli(
    ["probe", "inject", fx.runId, "-m", "remember the stale fixture"],
    fx,
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /inject queued/);
  assert.equal(readState(fx.runId).inject, "remember the stale fixture");
});

test("`probe inject --stdin` reads multi-line message from stdin (trailing newline stripped)", () => {
  const fx = setupFixture();
  const msg = "line one\nline two\nline three\n";
  const r = runCli(["probe", "inject", fx.runId, "--stdin"], fx, msg);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // The one trailing newline gets stripped; intermediate newlines preserved.
  assert.equal(readState(fx.runId).inject, "line one\nline two\nline three");
});

test("`probe inject` refuses to clobber a pending inject without --force", () => {
  const fx = setupFixture();
  setInject(fx.runId, "earlier message");
  const r = runCli(["probe", "inject", fx.runId, "-m", "newer"], fx);
  assert.notEqual(r.status, 0, "should exit non-zero");
  assert.match(r.stderr, /already queued/);
  // Pre-existing inject is preserved:
  assert.equal(readState(fx.runId).inject, "earlier message");
});

test("`probe inject --force` overwrites a pending inject", () => {
  const fx = setupFixture();
  setInject(fx.runId, "earlier message");
  const r = runCli(
    ["probe", "inject", fx.runId, "-m", "newer", "--force"],
    fx,
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(readState(fx.runId).inject, "newer");
});

test("`probe inject` with neither -m nor --stdin errors", () => {
  const fx = setupFixture();
  const r = runCli(["probe", "inject", fx.runId], fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /-m <text> or --stdin/);
});

test("`probe resume` transitions paused → running and preserves pending inject", () => {
  const fx = setupFixture();
  requestPause(fx.runId);
  setInject(fx.runId, "carry forward");
  const r = runCli(["probe", "resume", fx.runId], fx);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /resumed/);
  assert.match(r.stdout, /carrying pending inject/);
  const state = readState(fx.runId);
  assert.equal(state.state, "running");
  assert.equal(state.inject, "carry forward", "inject must survive resume");
});

test("`probe resume` on an already-running run is a no-op", () => {
  const fx = setupFixture();
  const r = runCli(["probe", "resume", fx.runId], fx);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already running/);
});

test("`probe clear` removes the probe file even when no run row exists", () => {
  const fx = setupFixture();
  // Use a totally unknown run id — clear should still work since it's
  // pure file cleanup (intended for stale recovery).
  const orphan = "run_orphaned-id-not-in-store";
  setInject(orphan, "orphan inject");
  assert.ok(existsSync(probeFilePath(orphan)));
  const r = runCli(["probe", "clear", orphan], fx);
  assert.equal(r.status, 0);
  assert.equal(existsSync(probeFilePath(orphan)), false);
});

test("`probe status` resolves a 12-char prefix to the full run id", () => {
  const fx = setupFixture();
  const prefix = fx.runId.slice(0, 12);
  assert.notEqual(prefix, fx.runId);
  const r = runCli(["probe", "status", prefix], fx);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /state\s+running/);
});

test("`probe status` errors on an unknown run id", () => {
  const fx = setupFixture();
  const r = runCli(["probe", "status", "run_definitely-not-a-real-id"], fx);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /run not found/);
});

test("operator round-trip via CLI: pause → inject → resume → status", () => {
  const fx = setupFixture();
  // pause
  let r = runCli(["probe", "pause", fx.runId], fx);
  assert.equal(r.status, 0);
  // inject
  r = runCli(["probe", "inject", fx.runId, "-m", "do this"], fx);
  assert.equal(r.status, 0);
  // resume
  r = runCli(["probe", "resume", fx.runId], fx);
  assert.equal(r.status, 0);
  // status — should be running, inject still queued for next call
  r = runCli(["probe", "status", fx.runId, "--json"], fx);
  assert.equal(r.status, 0);
  const final = JSON.parse(r.stdout.trim());
  assert.equal(final.state, "running");
  assert.equal(final.inject, "do this", "inject queued through full operator cycle");
  // Cross-check by reading the file directly:
  assert.equal(readState(fx.runId).inject, "do this");
  // And the probe file lives in the right place:
  const path = probeFilePath(fx.runId);
  assert.ok(existsSync(path));
  const onDisk = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(onDisk.state, "running");
  assert.equal(onDisk.inject, "do this");
});
