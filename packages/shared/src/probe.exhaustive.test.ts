import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  clearProbe,
  confirmPaused,
  consumeInject,
  normalize,
  probeFilePath,
  readState,
  requestPause,
  requestResume,
  setInject,
} from "./probe.ts";

/**
 * Exhaustive deterministic + property-based coverage of the probe FSM
 * (SPEC §4.5 + the source-level state machine documented in probe.ts).
 *
 * Companion to probe.test.ts: that file covers documented happy paths
 * with hand-picked examples; this file enumerates the full transition
 * table, idempotence + ordering invariants, I/O error paths,
 * `normalize()` coercion edges, atomic-rename contract (including a
 * real worker_threads stress test), `clearProbe` semantics, and four
 * fast-check properties.
 *
 * Test-context helper: every test uses `ctx()`, which mkdtemps a
 * SPOOL_HOME, mints a fresh run id, and hands back a deterministic
 * mock clock plus a cleanup callback. The mock clock matters — every
 * timestamp assertion in this file is exact (=== c.clock.now()),
 * never "approximately now". That makes the whole file
 * deterministic across machines and across runs.
 */

// ─── Test context helper ────────────────────────────────────────────

interface MockClock {
  /** Current wall-clock-shaped value. */
  now(): number;
  /** Advance the clock by `ms`. Returns the new value. */
  tick(ms: number): number;
  /** Pin the clock to an absolute value. */
  set(ms: number): number;
}

function mockClock(initial = 1_700_000_000_000): MockClock {
  let t = initial;
  return {
    now: () => t,
    tick: (ms: number) => (t += ms),
    set: (ms: number) => (t = ms),
  };
}

interface TestCtx {
  home: string;
  runId: string;
  clock: MockClock;
  cleanup(): void;
}

let _testCounter = 0;
function ctx(opts: { runId?: string; clockStart?: number } = {}): TestCtx {
  const home = mkdtempSync(join(tmpdir(), "spool-probe-exhaustive-"));
  process.env.SPOOL_HOME = home;
  const runId = opts.runId ?? `run-${++_testCounter}-${Date.now()}`;
  const clock = mockClock(opts.clockStart);
  return {
    home,
    runId,
    clock,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/* ====================================================================
 * Section 1 — State × state-mutating-op transition table (9 tests)
 *
 * Every (initial_state, op) cell of the 3×3 matrix is one explicit
 * test. The matrix is the canonical view; some cells overlap with
 * probe.test.ts but are kept here so the table is self-contained.
 * ==================================================================== */

test("cell: running × requestPause → pause_requested + requested_at_ms", () => {
  const c = ctx();
  try {
    const t0 = c.clock.now();
    const r = requestPause(c.runId, c.clock.now);
    assert.equal(r.state, "pause_requested");
    assert.equal(r.requested_at_ms, t0);
    assert.equal(r.paused_at_ms, null);
    assert.equal(r.resumed_at_ms, null);
  } finally {
    c.cleanup();
  }
});

test("cell: running × confirmPaused → no-op (state stays running, no paused_at_ms)", () => {
  const c = ctx();
  try {
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.paused_at_ms, null);
    assert.equal(r.requested_at_ms, null);
  } finally {
    c.cleanup();
  }
});

test("cell: running × requestResume → no-op (state stays running, no resumed_at_ms)", () => {
  const c = ctx();
  try {
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.resumed_at_ms, null);
  } finally {
    c.cleanup();
  }
});

test("cell: pause_requested × requestPause → no-op, requested_at_ms preserved", () => {
  const c = ctx();
  try {
    const t0 = c.clock.now();
    requestPause(c.runId, c.clock.now);
    c.clock.tick(1000);
    const r = requestPause(c.runId, c.clock.now);
    assert.equal(r.state, "pause_requested");
    assert.equal(r.requested_at_ms, t0, "original timestamp preserved");
  } finally {
    c.cleanup();
  }
});

test("cell: pause_requested × confirmPaused → paused + paused_at_ms", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    const t1 = c.clock.now();
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.state, "paused");
    assert.equal(r.paused_at_ms, t1);
  } finally {
    c.cleanup();
  }
});

test("cell: pause_requested × requestResume → running + resumed_at_ms", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    const t1 = c.clock.now();
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.resumed_at_ms, t1);
    // paused_at_ms was never stamped — must remain null
    assert.equal(r.paused_at_ms, null);
  } finally {
    c.cleanup();
  }
});

test("cell: paused × requestPause → no-op, no new requested_at_ms", () => {
  const c = ctx();
  try {
    const t0 = c.clock.now();
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(50);
    const r = requestPause(c.runId, c.clock.now);
    assert.equal(r.state, "paused");
    assert.equal(r.requested_at_ms, t0, "no new requested_at_ms on already-paused");
  } finally {
    c.cleanup();
  }
});

test("cell: paused × confirmPaused → no-op, paused_at_ms preserved", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    const t1 = c.clock.now();
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(1000);
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.state, "paused");
    assert.equal(r.paused_at_ms, t1, "paused_at_ms unchanged on second confirm");
  } finally {
    c.cleanup();
  }
});

test("cell: paused × requestResume → running + resumed_at_ms (paused_at_ms preserved)", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    const tPause = c.clock.now();
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(50);
    const tResume = c.clock.now();
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.resumed_at_ms, tResume);
    assert.equal(r.paused_at_ms, tPause, "paused_at_ms preserved as history");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 2 — State × inject-op interaction (6 tests)
 *
 * setInject and consumeInject are state-agnostic. Verify they NEVER
 * mutate state in any cell. Tests #14 and #15 are user-flagged
 * bug-likely (consumeInject during pause_requested / paused).
 * ==================================================================== */

test("cell: running × setInject → inject queued, state running", () => {
  const c = ctx();
  try {
    const r = setInject(c.runId, "hello", c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.inject, "hello");
  } finally {
    c.cleanup();
  }
});

test("cell: pause_requested × setInject → inject queued, state pause_requested", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    const r = setInject(c.runId, "queued", c.clock.now);
    assert.equal(r.state, "pause_requested");
    assert.equal(r.inject, "queued");
  } finally {
    c.cleanup();
  }
});

test("cell: paused × setInject → inject queued, state paused", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    confirmPaused(c.runId, c.clock.now);
    const r = setInject(c.runId, "while-paused", c.clock.now);
    assert.equal(r.state, "paused");
    assert.equal(r.inject, "while-paused");
  } finally {
    c.cleanup();
  }
});

test("cell: running × consumeInject(no pending) → null, state running", () => {
  const c = ctx();
  try {
    const taken = consumeInject(c.runId, c.clock.now);
    assert.equal(taken, null);
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.inject, null);
  } finally {
    c.cleanup();
  }
});

test("cell: paused × consumeInject(no pending) → null, state stays paused (bug-likely)", () => {
  // If consumeInject ever accidentally fell through to a state mutation
  // when the inject was empty, this would catch it.
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    confirmPaused(c.runId, c.clock.now);
    const taken = consumeInject(c.runId, c.clock.now);
    assert.equal(taken, null);
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "paused", "consume-of-nothing must not change state");
    assert.equal(r.inject, null);
  } finally {
    c.cleanup();
  }
});

test("cell: pause_requested × consumeInject(pending) → returns msg, state preserved (user-flagged bug-likely)", () => {
  // The flow operators care about: queue an inject during pause_requested,
  // SDK consumes it before acking the pause. State must stay pause_requested
  // so the SDK can still ack.
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    setInject(c.runId, "early-edit", c.clock.now);
    const taken = consumeInject(c.runId, c.clock.now);
    assert.equal(taken, "early-edit");
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "pause_requested", "consume must not promote pause_requested");
    assert.equal(r.inject, null, "inject cleared");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 3 — State × clearProbe (3 tests)
 * ==================================================================== */

test("cell: running × clearProbe(no file) → no-op (file still absent)", () => {
  const c = ctx();
  try {
    // No probe file has been created yet.
    assert.equal(existsSync(probeFilePath(c.runId)), false);
    clearProbe(c.runId);
    assert.equal(existsSync(probeFilePath(c.runId)), false);
    // readState still returns default
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running");
  } finally {
    c.cleanup();
  }
});

test("cell: pause_requested × clearProbe → file removed; readState returns default", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    assert.equal(existsSync(probeFilePath(c.runId)), true);
    clearProbe(c.runId);
    assert.equal(existsSync(probeFilePath(c.runId)), false);
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.requested_at_ms, null);
  } finally {
    c.cleanup();
  }
});

test("cell: paused × clearProbe → file removed; inject + state both discarded", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    confirmPaused(c.runId, c.clock.now);
    setInject(c.runId, "in-flight", c.clock.now);
    clearProbe(c.runId);
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.inject, null);
    assert.equal(r.paused_at_ms, null);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 4 — Idempotence and ordering invariants (6 tests)
 * ==================================================================== */

test("idempotent: requestPause × 3 on running → single requested_at_ms", () => {
  const c = ctx();
  try {
    const t0 = c.clock.now();
    requestPause(c.runId, c.clock.now);
    c.clock.tick(100);
    requestPause(c.runId, c.clock.now);
    c.clock.tick(100);
    const r = requestPause(c.runId, c.clock.now);
    assert.equal(r.requested_at_ms, t0);
  } finally {
    c.cleanup();
  }
});

test("idempotent: confirmPaused × 3 → single paused_at_ms", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(10);
    const tFirstConfirm = c.clock.now();
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(100);
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(100);
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.paused_at_ms, tFirstConfirm);
  } finally {
    c.cleanup();
  }
});

test("idempotent: requestResume × 3 → single resumed_at_ms", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(10);
    const tFirstResume = c.clock.now();
    requestResume(c.runId, c.clock.now);
    c.clock.tick(100);
    requestResume(c.runId, c.clock.now);
    c.clock.tick(100);
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.resumed_at_ms, tFirstResume);
  } finally {
    c.cleanup();
  }
});

test("idempotent: clearProbe × 3 → no error, file remains absent", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    clearProbe(c.runId);
    clearProbe(c.runId);
    clearProbe(c.runId);
    assert.equal(existsSync(probeFilePath(c.runId)), false);
  } finally {
    c.cleanup();
  }
});

test("ordering: pause → confirm → resume preserves all three timestamps as history", () => {
  const c = ctx();
  try {
    const t0 = c.clock.now();
    requestPause(c.runId, c.clock.now);
    c.clock.tick(100);
    const t1 = c.clock.now();
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(100);
    const t2 = c.clock.now();
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.requested_at_ms, t0);
    assert.equal(r.paused_at_ms, t1);
    assert.equal(r.resumed_at_ms, t2);
    assert.equal(r.state, "running");
  } finally {
    c.cleanup();
  }
});

test("ordering: pause → resume → confirm: confirm is no-op (operator-resumed race)", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(10);
    requestResume(c.runId, c.clock.now);
    c.clock.tick(10);
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.state, "running", "late confirm cannot un-resume");
    assert.equal(r.paused_at_ms, null);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 5 — Timestamp integrity (5 tests)
 * ==================================================================== */

test("timestamp: requested_at_ms ≤ paused_at_ms ≤ resumed_at_ms across a full cycle", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(50);
    const r = requestResume(c.runId, c.clock.now);
    assert.ok(r.requested_at_ms! <= r.paused_at_ms!);
    assert.ok(r.paused_at_ms! <= r.resumed_at_ms!);
  } finally {
    c.cleanup();
  }
});

test("timestamp: updated_at_ms equals the freshest mutation's nowMs", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(100);
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(100);
    const tLast = c.clock.now();
    const r = setInject(c.runId, "x", c.clock.now);
    assert.equal(r.updated_at_ms, tLast);
  } finally {
    c.cleanup();
  }
});

test("timestamp: paused_at_ms preserved through requestResume", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    const tPause = c.clock.now();
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(50);
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.paused_at_ms, tPause, "resume must not clobber paused history");
  } finally {
    c.cleanup();
  }
});

test("timestamp: requested_at_ms preserved through confirmPaused", () => {
  const c = ctx();
  try {
    const tReq = c.clock.now();
    requestPause(c.runId, c.clock.now);
    c.clock.tick(50);
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.requested_at_ms, tReq);
  } finally {
    c.cleanup();
  }
});

test("timestamp: one mutation samples the clock exactly once (all stamped timestamps equal)", () => {
  // The mutate() helper documents that it captures nowMs ONCE and reuses
  // it for every stamp. If two `now()` calls were made within one mutate,
  // the timestamps could diverge by sub-millisecond — bad for invariants
  // like "updated_at_ms === requested_at_ms" on the first pause.
  const c = ctx();
  try {
    let callCount = 0;
    const counted = () => {
      callCount++;
      return c.clock.now();
    };
    const t0 = c.clock.now();
    const r = requestPause(c.runId, counted);
    assert.equal(callCount, 1, "mutate must sample `now()` exactly once");
    assert.equal(r.requested_at_ms, t0);
    assert.equal(r.updated_at_ms, t0);
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 6 — Inject lifecycle (6 tests)
 * ==================================================================== */

test("inject: setInject('') preserves empty string as a non-null inject", () => {
  const c = ctx();
  try {
    const r = setInject(c.runId, "", c.clock.now);
    assert.equal(r.inject, "", "empty string is a valid inject, not null");
  } finally {
    c.cleanup();
  }
});

test("inject: setInject(A) → setInject(B) → consumeInject returns B (last-write wins)", () => {
  const c = ctx();
  try {
    setInject(c.runId, "A", c.clock.now);
    setInject(c.runId, "B", c.clock.now);
    const taken = consumeInject(c.runId, c.clock.now);
    assert.equal(taken, "B");
  } finally {
    c.cleanup();
  }
});

test("inject: setInject during pause_requested survives confirmPaused", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    setInject(c.runId, "queued-pre-ack", c.clock.now);
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.state, "paused");
    assert.equal(r.inject, "queued-pre-ack");
  } finally {
    c.cleanup();
  }
});

test("inject: consumeInject during pause_requested clears inject only (state preserved)", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    setInject(c.runId, "to-consume", c.clock.now);
    consumeInject(c.runId, c.clock.now);
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "pause_requested");
    assert.equal(r.inject, null);
  } finally {
    c.cleanup();
  }
});

test("inject: requestResume preserves a pending inject (resume-with-message flow)", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    confirmPaused(c.runId, c.clock.now);
    setInject(c.runId, "deliver-on-next-turn", c.clock.now);
    const r = requestResume(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.inject, "deliver-on-next-turn", "inject survives resume");
    // SDK then consumes on its next turn:
    const taken = consumeInject(c.runId, c.clock.now);
    assert.equal(taken, "deliver-on-next-turn");
  } finally {
    c.cleanup();
  }
});

test("inject: setInject after clearProbe re-creates file with inject + default state", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    setInject(c.runId, "first", c.clock.now);
    clearProbe(c.runId);
    // file is gone; setInject re-creates from default
    const r = setInject(c.runId, "second", c.clock.now);
    assert.equal(r.state, "running", "default state after cleanup");
    assert.equal(r.inject, "second");
    assert.equal(r.requested_at_ms, null, "no historical pause");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 7 — I/O error paths (6 tests)
 *
 * Uses directory-at-path (EISDIR) instead of chmod 0 (EACCES) to stay
 * uid-independent.
 * ==================================================================== */

test("io: readState on directory at probe file path throws non-ENOENT (EISDIR)", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path); // a directory where a file should be
    assert.throws(
      () => readState(c.runId, c.clock.now),
      (err: NodeJS.ErrnoException) =>
        err.code === "EISDIR" || err.code === "EACCES",
      "non-ENOENT errors must propagate",
    );
  } finally {
    c.cleanup();
  }
});

test("io: readState on corrupt JSON returns default running record", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not valid json at all");
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    assert.equal(r.inject, null);
  } finally {
    c.cleanup();
  }
});

test("io: readState on valid JSON with garbage state field normalizes to running", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        run_id: c.runId,
        state: "OBLITERATED",
        inject: null,
        requested_at_ms: null,
        paused_at_ms: null,
        resumed_at_ms: null,
        updated_at_ms: 1,
      }),
    );
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running", "unknown state collapses to running");
  } finally {
    c.cleanup();
  }
});

test("io: readState on JSON missing all fields → every field gets a safe default", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.run_id, c.runId, "run_id falls back to argument");
    assert.equal(r.state, "running");
    assert.equal(r.inject, null);
    assert.equal(r.requested_at_ms, null);
    assert.equal(r.paused_at_ms, null);
    assert.equal(r.resumed_at_ms, null);
    assert.equal(typeof r.updated_at_ms, "number");
  } finally {
    c.cleanup();
  }
});

test("io: readState on JSON with extra unknown fields → extras silently dropped", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        run_id: c.runId,
        state: "paused",
        inject: "x",
        requested_at_ms: 1,
        paused_at_ms: 2,
        resumed_at_ms: null,
        updated_at_ms: 2,
        secret_admin_flag: true, // not part of the contract
        nested: { evil: "payload" },
      }),
    );
    const r = readState(c.runId, c.clock.now) as unknown as Record<
      string,
      unknown
    >;
    const expectedKeys = new Set([
      "run_id",
      "state",
      "inject",
      "requested_at_ms",
      "paused_at_ms",
      "resumed_at_ms",
      "updated_at_ms",
    ]);
    for (const k of Object.keys(r)) {
      assert.ok(expectedKeys.has(k), `unexpected key in result: ${k}`);
    }
    assert.equal(r["state"], "paused");
  } finally {
    c.cleanup();
  }
});

test("io: readState on truncated JSON (mid-write) returns default running", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"state":"pau'); // truncated mid-value
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running", "partial-write recovery");
  } finally {
    c.cleanup();
  }
});

/* ====================================================================
 * Section 8 — normalize() coercion paths (9 tests)
 *
 * Direct unit tests against the @internal export. Catches the
 * coercion edges the user flagged as bug-likely.
 * ==================================================================== */

const _NOW = 1_700_000_000_000;
const _RID = "test-runid";

test("normalize: parsed === null → default record", () => {
  const r = normalize(null, _RID, _NOW);
  assert.equal(r.state, "running");
  assert.equal(r.run_id, _RID);
  assert.equal(r.updated_at_ms, _NOW);
});

test("normalize: parsed === undefined → default record", () => {
  const r = normalize(undefined, _RID, _NOW);
  assert.equal(r.state, "running");
  assert.equal(r.inject, null);
});

test("normalize: parsed === 'string' (not object) → default record (no crash)", () => {
  const r = normalize("hello", _RID, _NOW);
  assert.equal(r.state, "running");
  assert.equal(r.run_id, _RID);
});

test("normalize: parsed === [] (array) → default record (array not treated as object)", () => {
  const r = normalize([], _RID, _NOW);
  assert.equal(r.state, "running");
  // arrays have no `.run_id` so we fall through to the runId argument
  assert.equal(r.run_id, _RID);
});

test("normalize: parsed === {} → all fields take safe defaults", () => {
  const r = normalize({}, _RID, _NOW);
  assert.equal(r.run_id, _RID);
  assert.equal(r.state, "running");
  assert.equal(r.inject, null);
  assert.equal(r.requested_at_ms, null);
  assert.equal(r.paused_at_ms, null);
  assert.equal(r.resumed_at_ms, null);
  assert.equal(r.updated_at_ms, _NOW);
});

test("normalize: state field with garbage value coerced to 'running'", () => {
  const r = normalize({ state: "🔥obliterated🔥" }, _RID, _NOW);
  assert.equal(r.state, "running");
});

test("normalize: inject field as non-string (number, bool) coerced to null", () => {
  assert.equal(normalize({ inject: 42 }, _RID, _NOW).inject, null);
  assert.equal(normalize({ inject: false }, _RID, _NOW).inject, null);
  assert.equal(normalize({ inject: true }, _RID, _NOW).inject, null);
  assert.equal(normalize({ inject: null }, _RID, _NOW).inject, null);
  assert.equal(normalize({ inject: { msg: "x" } }, _RID, _NOW).inject, null);
});

test("normalize: timestamp fields as non-number coerced to null", () => {
  const r = normalize(
    {
      requested_at_ms: "1000",
      paused_at_ms: true,
      resumed_at_ms: { ts: 1 },
    },
    _RID,
    _NOW,
  );
  assert.equal(r.requested_at_ms, null);
  assert.equal(r.paused_at_ms, null);
  assert.equal(r.resumed_at_ms, null);
});

test("normalize: Date object in a timestamp field is rejected (not implicitly unwrapped)", () => {
  // Catches the "I JSON.serialized a Date" mistake — the type guard
  // checks `typeof === "number"`, so a Date instance is rejected.
  const r = normalize(
    {
      requested_at_ms: new Date(1_500_000_000_000),
      updated_at_ms: new Date(1_500_000_000_000),
    },
    _RID,
    _NOW,
  );
  assert.equal(r.requested_at_ms, null);
  // updated_at_ms falls back to nowMs since the Date isn't a number
  assert.equal(r.updated_at_ms, _NOW);
});

test("normalize: run_id field as non-string falls back to runId argument", () => {
  const r = normalize({ run_id: 12345 }, _RID, _NOW);
  assert.equal(r.run_id, _RID);
});

/* ====================================================================
 * Section 9 — Concurrent-writer / atomic-rename contract (5 tests)
 * ==================================================================== */

test("atomicity: successful mutation leaves no .tmp file behind (any suffix)", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    const path = probeFilePath(c.runId);
    assert.equal(existsSync(path), true);
    // Each write uses a uniquely-suffixed .tmp; we scan the probe dir
    // for ANY .tmp leftover, not just the legacy fixed name. This
    // catches both the fixed-name (legacy) and the random-suffix
    // (current) implementations.
    const dir = dirname(path);
    const tmps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(tmps, [], "no leftover .tmp files in probe dir");
  } finally {
    c.cleanup();
  }
});

test("atomicity: two sequential mutations on different runs don't collide (independent files)", () => {
  const c1 = ctx({ runId: "run-A" });
  // Reuse c1.home for c2 so they share SPOOL_HOME (real-world layout)
  const home = c1.home;
  process.env.SPOOL_HOME = home;
  try {
    const clockA = mockClock(1000);
    const clockB = mockClock(2000);
    requestPause("run-A", clockA.now);
    requestPause("run-B", clockB.now);
    confirmPaused("run-A", clockA.now);
    // run-B should still be in pause_requested
    const rB = readState("run-B", clockB.now);
    assert.equal(rB.state, "pause_requested");
    // run-A independent
    const rA = readState("run-A", clockA.now);
    assert.equal(rA.state, "paused");
  } finally {
    c1.cleanup();
  }
});

test("atomicity: read-modify-write is observable (second mutate sees first's write)", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    setInject(c.runId, "between", c.clock.now);
    const r = confirmPaused(c.runId, c.clock.now);
    assert.equal(r.state, "paused");
    assert.equal(r.inject, "between", "second mutate sees first's inject");
  } finally {
    c.cleanup();
  }
});

test("atomicity: a stale .tmp file from a prior crash does not break readers", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    // Simulate a crashed prior process: half-written .tmp, no canonical file.
    writeFileSync(`${path}.tmp`, '{"state":"corrupt}');
    // readState only looks at the canonical path; .tmp is ignored.
    const r = readState(c.runId, c.clock.now);
    assert.equal(r.state, "running");
    // And a new mutation overwrites cleanly:
    requestPause(c.runId, c.clock.now);
    const r2 = readState(c.runId, c.clock.now);
    assert.equal(r2.state, "pause_requested");
  } finally {
    c.cleanup();
  }
});

const __dirname = dirname(fileURLToPath(import.meta.url));
// .mjs (not .ts): node loads the worker entry before any tsx hook is
// active, so a .ts entry fails with ERR_UNKNOWN_FILE_EXTENSION even
// when we pass --import via execArgv. The .mjs file registers tsx
// itself and then dynamic-imports probe.ts.
const STRESS_WORKER_PATH = join(__dirname, "probe-stress-worker.mjs");

test(
  "atomicity stress: 4 workers × 50 setInject iterations on the same run never corrupt the file",
  { timeout: 30_000 },
  async () => {
    const c = ctx();
    try {
      const N_WORKERS = 4;
      const ITERATIONS = 50;
      const workers: Promise<{ id: number; lastInject: string }>[] = [];
      for (let id = 0; id < N_WORKERS; id++) {
        workers.push(
          new Promise((resolve, reject) => {
            const w = new Worker(STRESS_WORKER_PATH, {
              workerData: {
                id,
                home: c.home,
                runId: c.runId,
                iterations: ITERATIONS,
              },
            });
            w.on("message", resolve);
            w.on("error", reject);
            w.on("exit", (code) => {
              if (code !== 0) reject(new Error(`worker ${id} exit ${code}`));
            });
          }),
        );
      }
      const results = await Promise.all(workers);

      // Final state must be VALID — not corrupt, not torn.
      const final = readState(c.runId, c.clock.now);
      assert.ok(
        ["running", "pause_requested", "paused"].includes(final.state),
        `final state is valid: ${final.state}`,
      );
      // The inject must match one of the last writes from some worker.
      const validLastWrites = results.map((r) => r.lastInject);
      assert.ok(
        final.inject !== null && validLastWrites.includes(final.inject),
        `final inject "${final.inject}" must be one of: ${validLastWrites.join(", ")}`,
      );
      // No leftover .tmp file (any suffix). Indicates every rename
      // completed cleanly across all four workers.
      const stressDir = dirname(probeFilePath(c.runId));
      const stressTmps = readdirSync(stressDir).filter((f) =>
        f.endsWith(".tmp"),
      );
      assert.deepEqual(stressTmps, [], "no leftover .tmp after stress");
    } finally {
      c.cleanup();
    }
  },
);

/* ====================================================================
 * Section 10 — clearProbe edge cases (3 tests)
 * ==================================================================== */

test("clearProbe: removes a file containing all timestamps + inject", () => {
  const c = ctx();
  try {
    requestPause(c.runId, c.clock.now);
    c.clock.tick(10);
    confirmPaused(c.runId, c.clock.now);
    c.clock.tick(10);
    setInject(c.runId, "in-flight", c.clock.now);
    assert.equal(existsSync(probeFilePath(c.runId)), true);
    clearProbe(c.runId);
    assert.equal(existsSync(probeFilePath(c.runId)), false);
  } finally {
    c.cleanup();
  }
});

test("clearProbe: on missing file is silent (no throw)", () => {
  const c = ctx();
  try {
    // No probe file exists.
    assert.doesNotThrow(() => clearProbe(c.runId));
  } finally {
    c.cleanup();
  }
});

test("clearProbe: on a directory at the path propagates non-ENOENT", () => {
  const c = ctx();
  try {
    const path = probeFilePath(c.runId);
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path); // directory in place of file
    assert.throws(
      () => clearProbe(c.runId),
      (err: NodeJS.ErrnoException) => err.code !== "ENOENT",
      "only ENOENT is swallowed",
    );
  } finally {
    // best-effort: remove the directory we made
    try {
      rmSync(probeFilePath(c.runId), { recursive: true, force: true });
    } catch {
      // ignore
    }
    c.cleanup();
  }
});

/* ====================================================================
 * Section 11 — fast-check property tests (4 properties)
 *
 * Uses a shared SPOOL_HOME with unique runIds per property iteration to
 * avoid the mkdtempSync-per-run overhead (100 runs × mkdtemp would
 * dominate test time without changing signal).
 * ==================================================================== */

const OP_ARB = fc.constantFrom(
  "requestPause",
  "confirmPaused",
  "requestResume",
  "setInject",
  "consumeInject",
);

// Bounded-alphabet inject payload so we never produce a value that's
// awkwardly long or contains control characters.
const INJECT_PAYLOAD_ARB = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  minLength: 1,
  maxLength: 10,
});

test("property P1: FSM is closed under all ops — final state is always valid", () => {
  const home = mkdtempSync(join(tmpdir(), "spool-prop-p1-"));
  process.env.SPOOL_HOME = home;
  let runCounter = 0;
  try {
    fc.assert(
      fc.property(
        fc.array(OP_ARB, { minLength: 0, maxLength: 30 }),
        INJECT_PAYLOAD_ARB,
        (ops, payload) => {
          const runId = `prop-p1-${++runCounter}`;
          const clock = mockClock();
          for (const op of ops) {
            if (op === "requestPause") requestPause(runId, clock.now);
            else if (op === "confirmPaused") confirmPaused(runId, clock.now);
            else if (op === "requestResume") requestResume(runId, clock.now);
            else if (op === "setInject") setInject(runId, payload, clock.now);
            else if (op === "consumeInject") consumeInject(runId, clock.now);
            clock.tick(1);
          }
          const final = readState(runId, clock.now);
          return ["running", "pause_requested", "paused"].includes(
            final.state,
          );
        },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("property P2: setInject(msg); consumeInject() === msg AND state unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "spool-prop-p2-"));
  process.env.SPOOL_HOME = home;
  let runCounter = 0;
  try {
    fc.assert(
      fc.property(
        INJECT_PAYLOAD_ARB,
        fc.constantFrom("running", "pause_requested", "paused" as const),
        (msg, targetState) => {
          const runId = `prop-p2-${++runCounter}`;
          const clock = mockClock();
          // Drive to the target state.
          if (targetState === "pause_requested" || targetState === "paused") {
            requestPause(runId, clock.now);
          }
          if (targetState === "paused") {
            confirmPaused(runId, clock.now);
          }
          const before = readState(runId, clock.now);
          setInject(runId, msg, clock.now);
          const taken = consumeInject(runId, clock.now);
          const after = readState(runId, clock.now);
          return taken === msg && after.state === before.state;
        },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("property P3: state-mutating ops reach a fixed point after one call (idempotence)", () => {
  const home = mkdtempSync(join(tmpdir(), "spool-prop-p3-"));
  process.env.SPOOL_HOME = home;
  let runCounter = 0;
  try {
    fc.assert(
      fc.property(
        fc.array(OP_ARB, { minLength: 0, maxLength: 10 }),
        fc.constantFrom(
          "requestPause",
          "confirmPaused",
          "requestResume" as const,
        ),
        (priorOps, finalOp) => {
          const runId = `prop-p3-${++runCounter}`;
          const clock = mockClock();
          for (const op of priorOps) {
            if (op === "requestPause") requestPause(runId, clock.now);
            else if (op === "confirmPaused") confirmPaused(runId, clock.now);
            else if (op === "requestResume") requestResume(runId, clock.now);
            else if (op === "setInject")
              setInject(runId, "x", clock.now);
            else if (op === "consumeInject") consumeInject(runId, clock.now);
            clock.tick(1);
          }
          // First call to finalOp settles whatever change is going to happen.
          // Capture state + the relevant historical timestamp.
          if (finalOp === "requestPause") requestPause(runId, clock.now);
          else if (finalOp === "confirmPaused") confirmPaused(runId, clock.now);
          else if (finalOp === "requestResume") requestResume(runId, clock.now);
          const r1 = readState(runId, clock.now);
          // Second call must not change the historical timestamp for finalOp.
          clock.tick(100);
          if (finalOp === "requestPause") requestPause(runId, clock.now);
          else if (finalOp === "confirmPaused") confirmPaused(runId, clock.now);
          else if (finalOp === "requestResume") requestResume(runId, clock.now);
          const r2 = readState(runId, clock.now);
          if (finalOp === "requestPause") {
            return r1.requested_at_ms === r2.requested_at_ms;
          }
          if (finalOp === "confirmPaused") {
            return r1.paused_at_ms === r2.paused_at_ms;
          }
          return r1.resumed_at_ms === r2.resumed_at_ms;
        },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("property P4: clearProbe wipes all state — readState after returns the default record", () => {
  const home = mkdtempSync(join(tmpdir(), "spool-prop-p4-"));
  process.env.SPOOL_HOME = home;
  let runCounter = 0;
  try {
    fc.assert(
      fc.property(
        fc.array(OP_ARB, { minLength: 0, maxLength: 15 }),
        INJECT_PAYLOAD_ARB,
        (ops, payload) => {
          const runId = `prop-p4-${++runCounter}`;
          const clock = mockClock();
          for (const op of ops) {
            if (op === "requestPause") requestPause(runId, clock.now);
            else if (op === "confirmPaused") confirmPaused(runId, clock.now);
            else if (op === "requestResume") requestResume(runId, clock.now);
            else if (op === "setInject") setInject(runId, payload, clock.now);
            else if (op === "consumeInject") consumeInject(runId, clock.now);
            clock.tick(1);
          }
          clearProbe(runId);
          const r = readState(runId, clock.now);
          return (
            r.state === "running" &&
            r.inject === null &&
            r.requested_at_ms === null &&
            r.paused_at_ms === null &&
            r.resumed_at_ms === null
          );
        },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
