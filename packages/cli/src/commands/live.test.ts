import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  Store,
  getSetting,
  setSetting,
  insertRun,
  insertStep,
  insertFileChange,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { LiveEvent, FileSentinelEvent } from "@meterbility/server";
import type { Step } from "@meterbility/shared";
import {
  evaluateHealth,
  isFileTouching,
  isWriteTool,
  printStepFileDelta,
  printHealthLine,
  rawEventAgeMs,
  type TouchEntry,
} from "./live.ts";
import { cwdOverlapsRoot } from "@meterbility/server";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(TEST_DIR, "../index.ts");

/**
 * `meter live` (docs/designs/meter-live-front-door.md). Unit tests
 * cover the health matrix (design §4, investigation-validated
 * thresholds) and the 3A delta re-emit display; subprocess tests cover
 * the command lifecycle — header, viewer-guard, SYNCING→SYNCED,
 * heartbeat release on SIGINT.
 */

// ─── evaluateHealth matrix (design §4) ───────────────────────────────

function h(over: Partial<Parameters<typeof evaluateHealth>[0]> = {}) {
  return {
    ready_at: Date.now() - 60_000,
    raw_event_count: 10,
    last_raw_event_at: Date.now() - 1_000,
    unattributed_no_recent_step: 0,
    ...over,
  };
}

const touch = (ageMs: number, write = true): TouchEntry => ({
  t: Date.now() - ageMs,
  write,
});

test("health: fresh raw events + recent file-touching steps → healthy", () => {
  assert.equal(evaluateHealth(h(), [touch(1_000)], Date.now() - 60_000), "healthy");
});

test("health: idle repo (no file-touching steps) is healthy even with stale events", () => {
  assert.equal(
    evaluateHealth(h({ last_raw_event_at: Date.now() - 120_000 }), [], Date.now() - 300_000),
    "healthy",
  );
});

test("health: raw events lagging >5s with recent file-touching steps → warn", () => {
  assert.equal(
    evaluateHealth(h({ last_raw_event_at: Date.now() - 8_000 }), [touch(1_000)], Date.now() - 60_000),
    "warn",
  );
});

test("health: raw events silent >15s with recent file-touching steps → degraded", () => {
  assert.equal(
    evaluateHealth(h({ last_raw_event_at: Date.now() - 20_000 }), [touch(1_000)], Date.now() - 60_000),
    "degraded",
  );
});

test("health: startup grace suppresses degraded until the stream proves itself", () => {
  // No raw event ever, ready 10s ago (inside the 20s grace): the 10s
  // silence reads warn, never degraded.
  const noEvents = h({ raw_event_count: 0, last_raw_event_at: undefined, ready_at: Date.now() - 10_000 });
  assert.equal(evaluateHealth(noEvents, [touch(1_000)], Date.now() - 10_000), "warn");
  // Grace elapsed (ready 30s ago, still zero events): now it's real.
  const graceOver = h({ raw_event_count: 0, last_raw_event_at: undefined, ready_at: Date.now() - 30_000 });
  assert.equal(evaluateHealth(graceOver, [touch(1_000)], Date.now() - 30_000), "degraded");
});

test("health: numerator only counts entries inside the 15s window", () => {
  // Only stale touch entries → numerator 0 → healthy despite silence.
  assert.equal(
    evaluateHealth(h({ last_raw_event_at: Date.now() - 60_000 }), [touch(60_000)], Date.now() - 120_000),
    "healthy",
  );
});

test("health: shell-only activity caps at warn — a read-only Bash loop is not capture loss", () => {
  // 20s of raw silence + recent Bash-only steps: degraded conditions
  // hold EXCEPT there is no definite write evidence (red-team finding).
  const silent = h({ last_raw_event_at: Date.now() - 20_000 });
  assert.equal(evaluateHealth(silent, [touch(1_000, false)], Date.now() - 60_000), "warn");
  // One definite write in the ring escalates.
  assert.equal(
    evaluateHealth(silent, [touch(1_000, false), touch(2_000, true)], Date.now() - 60_000),
    "degraded",
  );
});

// ─── 1A predicate ────────────────────────────────────────────────────

function step(action: Step["action"]): Step {
  return {
    step_id: "s",
    run_id: "r",
    sequence: 1,
    timestamp: new Date().toISOString(),
    model: "m",
    context_snapshot_id: "c",
    decision_ref: "d",
    action,
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
  };
}

test("1A predicate: file-mutating and shell tools count; messages and read-only tools don't", () => {
  assert.equal(isFileTouching(step({ kind: "tool_call", tool_name: "Edit" })), true);
  assert.equal(isFileTouching(step({ kind: "tool_call", tool_name: "Bash" })), true);
  assert.equal(isFileTouching(step({ kind: "tool_call", tool_name: "apply_patch" })), true);
  assert.equal(isFileTouching(step({ kind: "tool_call", tool_name: "Read" })), false);
  assert.equal(isFileTouching(step({ kind: "message", text: "hi" })), false);
  // Write/shell tiering (degraded escalation evidence):
  assert.equal(isWriteTool(step({ kind: "tool_call", tool_name: "Edit" })), true);
  assert.equal(isWriteTool(step({ kind: "tool_call", tool_name: "Bash" })), false);
});

// ─── 3A delta display ────────────────────────────────────────────────

function captureStdout(fn: () => void): string {
  const orig = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

test("3A: re-emitted files:changed prints only the NEW rows, tagged (update)", async () => {
  const home = mkdtempSync(join(tmpdir(), "meter-live-delta-"));
  const store = Store.open({ path: join(home, "meterbility.db") });
  const cwd = mkdtempSync(join(tmpdir(), "meter-live-delta-cwd-"));
  const project = upsertProjectByCwd(store, cwd, "delta-test");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  insertRun(store, {
    run_id: runId, agent_id: agent.agent_id, project_id: project.project_id,
    source_runtime: "claude-code", status: "in_progress",
    started_at: new Date().toISOString(), cwd,
    tokens_total_input: 0, tokens_total_output: 0, tokens_total_cached: 0,
    cost_cents: 0, step_count: 1, tags: [],
  });
  const stepId = `stp_${randomUUID()}`;
  insertStep(store, {
    step_id: stepId, run_id: runId, sequence: 3,
    timestamp: new Date().toISOString(), model: "m",
    context_snapshot_id: "c", decision_ref: "d",
    action: { kind: "tool_call", tool_name: "Edit" },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0, cost_cents: 0, tags: [], status: "ok",
  });
  const mkRow = (path: string, seq: number): void => {
    insertFileChange(store, {
      run_id: runId, step_id: stepId, sequence: seq,
      derived_from: seq >= 1000 ? "filesystem_watch" : "tool_call",
      path, op: "create", after_blob_ref: undefined,
      partial_diff: true, gitignored: false, bom: false,
      lines_added: 0, lines_removed: 0, redacted: false,
      source_tool_name: seq >= 1000 ? undefined : "Edit",
    });
  };
  const ev = {
    type: "files:changed" as const,
    run_id: runId,
    step_id: stepId,
    sequence: 3,
    paths: ["a.ts"],
    partial: true,
  } satisfies Extract<LiveEvent, { type: "files:changed" }>;

  const announced = new Map<string, number>();
  mkRow("a.ts", 0);
  const first = captureStdout(() => printStepFileDelta(store, ev, announced, true));
  assert.match(first, /step 3/);
  assert.match(first, /a\.ts/);
  assert.doesNotMatch(first, /\(update\)/);

  // Late hook drain adds a second row for the same step → re-emit.
  mkRow("b.sh", 1000);
  const second = captureStdout(() => printStepFileDelta(store, ev, announced, true));
  assert.match(second, /\(update\)/);
  assert.match(second, /b\.sh/);
  assert.doesNotMatch(second, /a\.ts/, "already-announced rows never reprint");

  // No growth → nothing printed at all.
  const third = captureStdout(() => printStepFileDelta(store, ev, announced, true));
  assert.equal(third, "");
  store.close();
});

// ─── Subprocess lifecycle ────────────────────────────────────────────

interface LiveProc {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<number | null>;
}

function spawnLive(args: string[], env: Record<string, string>): LiveProc {
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", CLI_ENTRY, "live", ...args],
    { env: { ...process.env, ...env, NO_COLOR: "1" } },
  );
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  // Generous default: each spawned CLI pays a full tsx/esm cold start
  // (~10s on this repo) before printing anything.
  const waitFor = (pattern: RegExp, timeoutMs = 45_000): Promise<void> =>
    new Promise((resolvePromise, reject) => {
      const t0 = Date.now();
      const tick = (): void => {
        if (pattern.test(out) || pattern.test(err)) return resolvePromise();
        if (Date.now() - t0 > timeoutMs) {
          return reject(
            new Error(`timeout waiting for ${pattern}\nstdout:\n${out}\nstderr:\n${err}`),
          );
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  const stop = (): Promise<number | null> =>
    new Promise((resolvePromise) => {
      // A child that already died (startup crash) has no future 'exit'
      // event — resolve immediately or the suite hangs with no
      // diagnostic (ship review, testing specialist).
      if (child.exitCode !== null || child.signalCode !== null) {
        resolvePromise(child.exitCode);
        return;
      }
      child.once("exit", (code) => resolvePromise(code));
      child.kill("SIGINT");
      // Belt and braces: SIGKILL if SIGINT hangs — and resolve either
      // way so a SIGINT-ignoring child can't wedge the test.
      setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise(null);
      }, 10_000).unref();
    });
  return { child, stdout: () => out, stderr: () => err, waitFor, stop };
}

function freshEnv(): { home: string; claudeHome: string; filesRoot: string } {
  const home = mkdtempSync(join(tmpdir(), "meter-live-e2e-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "meter-live-e2e-claude-"));
  const filesRoot = mkdtempSync(join(tmpdir(), "meter-live-e2e-root-"));
  return { home, claudeHome, filesRoot };
}

test("live: header warns loudly with no active session, then SYNCING → SYNCED", async () => {
  const fx = freshEnv();
  const proc = spawnLive(["--no-files"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
  });
  let code: number | null = null;
  try {
    await proc.waitFor(/no active session — start your agent/);
    await proc.waitFor(/SYNCING/);
    await proc.waitFor(/SYNCED · streaming live/);
  } finally {
    // Stop only — asserting in finally would mask the waitFor
    // diagnostic when the try body threw (ship review).
    code = await proc.stop();
  }
  assert.equal(code, 0);
  assert.match(proc.stdout(), /meter live/);
  assert.match(proc.stdout(), /db: /);
});

test("live: viewer-guard — a fresh heartbeat makes the second instance attach viewer-only", async () => {
  const fx = freshEnv();
  const store = Store.open({ path: join(fx.home, "meterbility.db") });
  setSetting(store, "live.heartbeat", new Date().toISOString());
  store.close();
  const proc = spawnLive(["--files-dir", fx.filesRoot], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
  });
  let code: number | null = null;
  try {
    await proc.waitFor(/capture already active — attaching as viewer/);
    await proc.waitFor(/viewer-only — another meter live holds file capture/);
  } finally {
    code = await proc.stop();
  }
  assert.equal(code, 0);
});

test("live: invalid --files-dir warns and continues without file capture", async () => {
  const fx = freshEnv();
  const proc = spawnLive(["--files-dir", join(fx.filesRoot, "does-not-exist")], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
  });
  let code: number | null = null;
  try {
    await proc.waitFor(/--files-dir is not a directory/);
    await proc.waitFor(/SYNCED/);
  } finally {
    code = await proc.stop();
  }
  assert.equal(code, 0);
});

test("live: --json streams sentinel:ready as NDJSON; SIGINT releases the heartbeat", async () => {
  const fx = freshEnv();
  const proc = spawnLive(["--files-dir", fx.filesRoot, "--json"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
  });
  let code: number | null = null;
  try {
    await proc.waitFor(/"type":"sentinel:ready"/);
    // Heartbeat lands on the first 5s evaluator tick — wait for it to
    // exist so the release-on-SIGINT assertion is meaningful.
    const hbSeen = await (async () => {
      const t0 = Date.now();
      for (;;) {
        const store = Store.open({ path: join(fx.home, "meterbility.db") });
        const hb = getSetting(store, "live.heartbeat");
        store.close();
        if (hb !== undefined) return true;
        if (Date.now() - t0 > 15_000) return false;
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    assert.equal(hbSeen, true, "capture-holder writes the heartbeat");
    // The evaluator has ticked at least once (heartbeat exists), so a
    // typed capture:health event must be in the NDJSON stream shortly.
    await proc.waitFor(/"type":"capture:health"/);
  } finally {
    code = await proc.stop();
  }
  assert.equal(code, 0);
  const store = Store.open({ path: join(fx.home, "meterbility.db") });
  const hb = getSetting(store, "live.heartbeat");
  store.close();
  assert.equal(hb, undefined, "clean shutdown releases the capture claim");
  // Every stdout line parses as JSON (NDJSON contract).
  const parsed = proc
    .stdout()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const health = parsed.find((o) => o.type === "capture:health");
  assert.ok(health, "typed capture:health event present in the stream");
  assert.equal(health!.mode, "capturing");
  assert.equal(typeof health!.fs_event_age_ms, "number");
  assert.equal(health!.degraded, false, "idle temp repo must not read degraded");
});

// ─── printHealthLine + rawEventAgeMs (ship review: loss surfacing) ───

test("printHealthLine: verdict lines and the capture:lost data-loss warning", () => {
  const snap = h();
  const healthy = captureStdout(() => printHealthLine("healthy", snap, 0, 0, false));
  assert.match(healthy, /capture:healthy/);
  const warn = captureStdout(() => printHealthLine("warn", snap, 2, 0, false));
  assert.match(warn, /capture:warn/);
  assert.match(warn, /2 file-touching steps/);
  const degraded = captureStdout(() => printHealthLine("degraded", snap, 1, 0, false));
  assert.match(degraded, /capture:degraded/);
  assert.match(degraded, /hook-based capture unaffected/);
  const lost = captureStdout(() => printHealthLine("healthy", snap, 0, 3, true));
  assert.match(lost, /capture:lost/);
  assert.match(lost, /3 changes arrived too late/);
  assert.match(lost, /data loss, not lag/);
  const notGrown = captureStdout(() => printHealthLine("healthy", snap, 0, 3, false));
  assert.doesNotMatch(notGrown, /capture:lost/, "loss line only fires on growth");
});

test("rawEventAgeMs anchors: last event, then ready, then start", () => {
  const now = Date.now();
  const viaEvent = rawEventAgeMs(h({ last_raw_event_at: now - 3_000 }), now - 60_000);
  assert.ok(viaEvent >= 3_000 && viaEvent < 4_000);
  const viaReady = rawEventAgeMs(
    h({ last_raw_event_at: undefined, ready_at: now - 7_000 }),
    now - 60_000,
  );
  assert.ok(viaReady >= 7_000 && viaReady < 8_000);
  const viaStart = rawEventAgeMs(
    h({ last_raw_event_at: undefined, ready_at: undefined }),
    now - 11_000,
  );
  assert.ok(viaStart >= 11_000 && viaStart < 12_000);
});

// ─── cwdOverlapsRoot (shared with sentinel attribution) ──────────────

test("cwdOverlapsRoot: prefix overlap is path-segment aware, not string-prefix", () => {
  assert.equal(cwdOverlapsRoot("/repo/foo", "/repo/foo"), true);
  assert.equal(cwdOverlapsRoot("/repo/foo", "/repo/foo/sub"), true);
  assert.equal(cwdOverlapsRoot("/repo/foo/sub", "/repo/foo"), true);
  assert.equal(cwdOverlapsRoot("/repo/foo", "/repo/foobar"), false);
  assert.equal(cwdOverlapsRoot("/repo/foobar", "/repo/foo"), false);
  assert.equal(cwdOverlapsRoot(undefined, "/repo"), false);
});

// ─── --force-capture takeover (ship review + coverage audit) ─────────

test("live: --force-capture overrides a fresh heartbeat and takes capture", async () => {
  const fx = freshEnv();
  const store = Store.open({ path: join(fx.home, "meterbility.db") });
  setSetting(store, "live.heartbeat", new Date().toISOString());
  store.close();
  const proc = spawnLive(["--files-dir", fx.filesRoot, "--force-capture"], {
    METERBILITY_HOME: fx.home,
    CLAUDE_HOME: fx.claudeHome,
  });
  let code: number | null = null;
  try {
    await proc.waitFor(/hooks \(exact, where installed\)/);
  } finally {
    code = await proc.stop();
  }
  assert.equal(code, 0);
  assert.doesNotMatch(proc.stdout(), /attaching as viewer/);
});
