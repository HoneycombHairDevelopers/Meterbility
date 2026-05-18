/**
 * Live Probe protocol — local file-based transport for pause / inject /
 * resume on a running agent session. Track B / Turn 8 foundation.
 *
 * ## Why file-based
 *
 * The Probe SDK has to work in the same scenarios capture does:
 * machine offline, no spool server running, multiple SDKs (TS + Python)
 * potentially talking to the same run. A file under `$SPOOL_HOME/probe/`
 * meets all three — every process can read/write it without a port,
 * without a daemon, without IPC bootstrap.
 *
 * Latency cost is the polling interval the SDK uses to check the file
 * (currently ~250ms in the agent helpers). That's acceptable for a
 * "graceful pause between model calls" UX; we are NOT trying to halt
 * mid-stream.
 *
 * ## File layout
 *
 *   $SPOOL_HOME/probe/<run_id>.json
 *
 * One file per active run. Absent file == "no probe activity" == the
 * SDK runs normally. The file is created when an operator requests a
 * pause or sets an inject, and removed by `clearProbe` when the run
 * ends.
 *
 * ## State machine
 *
 *   running
 *     │
 *     │ requestPause()             [operator]
 *     ▼
 *   pause_requested
 *     │
 *     │ confirmPaused()            [SDK, after finishing current call]
 *     ▼
 *   paused
 *     │
 *     │ requestResume()            [operator]
 *     ▼
 *   running
 *
 * `setInject(msg)` can be called in any state (operator). The SDK calls
 * `consumeInject` immediately before the next model call: returns the
 * pending inject and atomically clears it. An inject without a pause is
 * legal — the SDK simply prepends the message to the next user turn.
 *
 * ## Atomic writes
 *
 * Writes go to `<file>.tmp` then `rename()` over the canonical path.
 * POSIX rename is atomic on a single filesystem, so concurrent readers
 * always see either the old or the new file, never a half-written one.
 *
 * ## Concurrency note
 *
 * Multiple SDKs could in principle drive the same run_id (TS + Python
 * in a hybrid agent). Each `mutate` reads, transforms, writes — the
 * small race window between read and write is acceptable for the probe
 * UX (it's an operator-driven UI, not a high-throughput control plane).
 * A future revision can add advisory locking if multi-writer becomes a
 * real pattern.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spoolHome } from "./paths.ts";

/**
 * Runtime probe FSM state. Lives in the on-disk JSON record at
 * `~/.spool/probe/<run_id>.json` and drives the live pause/inject/
 * resume protocol between operator and SDK.
 *
 * Not to be confused with `ProbeState` on `Run` (see types.ts), which
 * is the persisted historical marker (`paused | resumed | null`) the
 * trace format carries forward. Different semantics: this is the
 * current FSM state; that is "did this run ever get probed."
 */
export type ProbeFsmState = "running" | "pause_requested" | "paused";

export interface ProbeRecord {
  run_id: string;
  state: ProbeFsmState;
  /** Pending inject message. Null when nothing is queued. */
  inject: string | null;
  /** Wall-clock ms when an operator requested the pause. */
  requested_at_ms: number | null;
  /** Wall-clock ms when the SDK acknowledged the pause. */
  paused_at_ms: number | null;
  /** Wall-clock ms when an operator requested resume. */
  resumed_at_ms: number | null;
  /** Wall-clock ms of the last mutation — useful for staleness checks. */
  updated_at_ms: number;
}

/** Default "no probe activity" record. Returned when the file is absent. */
function defaultRecord(runId: string, nowMs: number): ProbeRecord {
  return {
    run_id: runId,
    state: "running",
    inject: null,
    requested_at_ms: null,
    paused_at_ms: null,
    resumed_at_ms: null,
    updated_at_ms: nowMs,
  };
}

export function probeDir(): string {
  return join(spoolHome(), "probe");
}

export function probeFilePath(runId: string): string {
  return join(probeDir(), `${encodeURIComponent(runId)}.json`);
}

/**
 * Read the current probe record for a run. Returns the default
 * "running, no inject" record when no probe file exists — callers
 * never need to distinguish "file absent" from "state is running."
 */
export function readState(runId: string, now: () => number = Date.now): ProbeRecord {
  const path = probeFilePath(runId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    // ENOENT is the steady-state for a run that's not under operator
    // control. Any other error (EACCES, EIO) is a real problem; let it
    // bubble so the SDK or CLI surfaces a useful message.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultRecord(runId, now());
    }
    throw err;
  }
  try {
    return normalize(JSON.parse(raw), runId, now());
  } catch {
    // Corrupt or truncated file — treat as no probe activity rather
    // than crash the SDK loop. The next mutation will overwrite it.
    return defaultRecord(runId, now());
  }
}

/**
 * Coerce a parsed-JSON object back into a valid ProbeRecord. Unknown
 * fields are dropped; missing fields take safe defaults; bad state
 * strings collapse to "running" (the inert default).
 */
function normalize(parsed: unknown, runId: string, nowMs: number): ProbeRecord {
  const o = (parsed ?? {}) as Partial<ProbeRecord>;
  const validStates: ProbeFsmState[] = ["running", "pause_requested", "paused"];
  const state = (validStates as string[]).includes(o.state as string)
    ? (o.state as ProbeFsmState)
    : "running";
  return {
    run_id: typeof o.run_id === "string" ? o.run_id : runId,
    state,
    inject: typeof o.inject === "string" ? o.inject : null,
    requested_at_ms: typeof o.requested_at_ms === "number" ? o.requested_at_ms : null,
    paused_at_ms: typeof o.paused_at_ms === "number" ? o.paused_at_ms : null,
    resumed_at_ms: typeof o.resumed_at_ms === "number" ? o.resumed_at_ms : null,
    updated_at_ms: typeof o.updated_at_ms === "number" ? o.updated_at_ms : nowMs,
  };
}

/**
 * Read-modify-write helper. Loads the current record (or default),
 * passes it to `transform`, writes the result atomically via
 * `<file>.tmp` + rename. Returns the written record.
 *
 * If `transform` returns the input record unchanged (by reference or
 * value-equal), the write is still performed — callers that want
 * "mutate iff changed" should compare in `transform` and return the
 * original to express no-op, since we have no cheap way to detect that
 * from outside. The cost is one extra rename per no-op operator call;
 * the probe surface is not hot.
 */
function mutate(
  runId: string,
  transform: (current: ProbeRecord, nowMs: number) => ProbeRecord,
  now: () => number = Date.now,
): ProbeRecord {
  // Sample the clock ONCE per mutation so every timestamp in the
  // resulting record agrees with itself. `readState` is allowed to
  // observe an older value (it's a read-only fallback for the absent
  // file); only the new record's timestamps matter for assertions.
  const nowMs = now();
  const current = readState(runId, () => nowMs);
  const next: ProbeRecord = { ...transform(current, nowMs), updated_at_ms: nowMs };
  const path = probeFilePath(runId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
  return next;
}

/**
 * Operator side: request a graceful pause. Idempotent — if the run is
 * already `pause_requested` or `paused`, the timestamps are preserved.
 */
export function requestPause(runId: string, now: () => number = Date.now): ProbeRecord {
  return mutate(
    runId,
    (cur, nowMs) => {
      if (cur.state === "pause_requested" || cur.state === "paused") return cur;
      return { ...cur, state: "pause_requested", requested_at_ms: nowMs };
    },
    now,
  );
}

/**
 * SDK side: acknowledge that the current model call has completed and
 * the agent is now actually paused. No-op when the operator already
 * resumed (race window between `pause_requested` and SDK polling).
 */
export function confirmPaused(runId: string, now: () => number = Date.now): ProbeRecord {
  return mutate(
    runId,
    (cur, nowMs) => {
      if (cur.state !== "pause_requested") return cur;
      return { ...cur, state: "paused", paused_at_ms: nowMs };
    },
    now,
  );
}

/**
 * Operator side: queue a message to be prepended to the next user turn.
 * Allowed in any state — most natural flow is "pause, inject, resume"
 * but plain inject (no pause) is supported for one-shot nudges.
 *
 * Calling `setInject` again before the SDK consumes the previous one
 * overwrites the queued message. The operator UI should warn before
 * stomping a pending inject.
 */
export function setInject(
  runId: string,
  message: string,
  now: () => number = Date.now,
): ProbeRecord {
  return mutate(runId, (cur) => ({ ...cur, inject: message }), now);
}

/**
 * SDK side: read and atomically clear the pending inject. Returns null
 * if nothing is queued.
 */
export function consumeInject(
  runId: string,
  now: () => number = Date.now,
): string | null {
  let taken: string | null = null;
  mutate(
    runId,
    (cur) => {
      taken = cur.inject;
      if (taken === null) return cur;
      return { ...cur, inject: null };
    },
    now,
  );
  return taken;
}

/**
 * Operator side: resume the run. Transitions any state back to
 * `running` and stamps `resumed_at_ms`. Inject is NOT cleared here —
 * resuming with a pending inject is a valid pattern (operator wants
 * the message delivered on the next turn).
 */
export function requestResume(runId: string, now: () => number = Date.now): ProbeRecord {
  return mutate(
    runId,
    (cur, nowMs) => {
      if (cur.state === "running") return cur;
      return { ...cur, state: "running", resumed_at_ms: nowMs };
    },
    now,
  );
}

/**
 * Terminal cleanup — remove the probe file. Called when the run ends
 * so a stale `paused` state doesn't linger in `$SPOOL_HOME/probe/`.
 * Safe to call when the file doesn't exist.
 */
export function clearProbe(runId: string): void {
  const path = probeFilePath(runId);
  try {
    rmSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
