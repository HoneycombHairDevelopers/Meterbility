import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertRun,
  insertStep,
  insertFileChange,
  setSetting,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import { dbPath } from "@meterbility/shared";
import { maybePrintAttachNudge } from "./nudge.ts";

/**
 * The "capture active — meter live to attach" nudge
 * (docs/designs/meter-live-front-door.md §6) and its 4A safety
 * contract: guard (never create the store), swallow (never fail the
 * command), and the exclusion list.
 *
 * Direct-call tests: the nudge is a pure side-effect function keyed on
 * METERBILITY_HOME, so calling it in-process with a captured
 * console.error is both faster and stricter than subprocess scraping.
 */

function captureStderr(fn: () => void): string {
  const orig = console.error;
  let out = "";
  console.error = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return out;
}

/** Store with one in-progress run + step + a fresh filesystem_watch row. */
function seedCaptureActivity(home: string, opts: { rowAgeMs?: number } = {}): void {
  const store = Store.open({ path: join(home, "meterbility.db") });
  const cwd = mkdtempSync(join(tmpdir(), "meter-nudge-cwd-"));
  const project = upsertProjectByCwd(store, cwd, "nudge-test");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  insertRun(store, {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    status: "in_progress",
    started_at: new Date().toISOString(),
    cwd,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 1,
    tags: [],
  });
  const stepId = `stp_${randomUUID()}`;
  insertStep(store, {
    step_id: stepId,
    run_id: runId,
    sequence: 0,
    timestamp: new Date().toISOString(),
    model: "m",
    context_snapshot_id: "snap",
    decision_ref: "dec",
    action: { kind: "tool_call", tool_name: "Bash" },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
  });
  insertFileChange(store, {
    run_id: runId,
    step_id: stepId,
    sequence: 1000,
    derived_from: "filesystem_watch",
    path: "x.ts",
    op: "create",
    after_blob_ref: undefined,
    partial_diff: true,
    gitignored: false,
    bom: false,
    lines_added: 0,
    lines_removed: 0,
    redacted: false,
    created_at: new Date(Date.now() - (opts.rowAgeMs ?? 1_000)).toISOString(),
  });
  store.close();
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "meter-nudge-"));
  process.env.METERBILITY_HOME = home;
  return home;
}

test("nudge fires when capture rows are recent and no heartbeat exists", () => {
  const home = freshHome();
  seedCaptureActivity(home);
  const out = captureStderr(() => maybePrintAttachNudge("list", {}));
  assert.match(out, /capture active on/);
  assert.match(out, /meter live/);
});

test("nudge is silent when the heartbeat is fresh (a viewer is attached)", () => {
  const home = freshHome();
  seedCaptureActivity(home);
  const store = Store.open({ path: join(home, "meterbility.db") });
  setSetting(store, "live.heartbeat", new Date().toISOString());
  store.close();
  const out = captureStderr(() => maybePrintAttachNudge("list", {}));
  assert.equal(out, "");
});

test("nudge is silent when capture rows are older than the 10-minute window", () => {
  const home = freshHome();
  seedCaptureActivity(home, { rowAgeMs: 11 * 60_000 });
  const out = captureStderr(() => maybePrintAttachNudge("list", {}));
  assert.equal(out, "");
});

test("nudge is silent for excluded commands and --json invocations", () => {
  const home = freshHome();
  seedCaptureActivity(home);
  for (const cmd of ["capture", "cursor-hook", "run", "live", "watch"]) {
    const out = captureStderr(() => maybePrintAttachNudge(cmd, {}));
    assert.equal(out, "", `excluded command leaked a nudge: ${cmd}`);
  }
  const out = captureStderr(() => maybePrintAttachNudge("list", { json: true }));
  assert.equal(out, "", "--json invocation leaked a nudge");
});

test("4A guard: no store file → silent, and the store is NOT created as a side effect", () => {
  const home = freshHome();
  const out = captureStderr(() => maybePrintAttachNudge("list", {}));
  assert.equal(out, "");
  assert.equal(existsSync(dbPath()), false, "nudge check must never create the store");
  assert.deepEqual(readdirSync(home), [], "home directory stays untouched");
});

test("4A swallow: a corrupt store never fails the command", () => {
  const home = freshHome();
  writeFileSync(join(home, "meterbility.db"), "this is not a sqlite database");
  // Must neither throw nor print.
  const out = captureStderr(() => maybePrintAttachNudge("list", {}));
  assert.equal(out, "");
});
