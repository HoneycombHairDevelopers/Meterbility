import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  claudeProjectsRoot,
  probeFilePath,
  readState as readProbeState,
} from "@spool-ai/shared";
import type { ProbeFsmState } from "@spool-ai/shared";
import {
  ingestSession,
  discoverSessions,
  readSession,
  probeRecords,
  formatWarning,
  type ShapeWarning,
} from "@spool-ai/claude-code-adapter";
import {
  getRun,
  listFileChanges,
  listRuns,
  listSteps,
} from "@spool-ai/collector";
import type { Store } from "@spool-ai/collector";
import type { Run, Step } from "@spool-ai/shared";
import {
  classifyRunStatus,
  contextUtilization,
  detectLoop,
  type LiveStatus,
} from "./live-heuristics.ts";

/**
 * Live inspector — watches the Claude Code projects directory for new
 * sessions and growing session files, runs incremental ingest, and
 * emits structured events that the web UI subscribes to via SSE.
 *
 * v0.1 only watches Claude Code; the abstraction is generic enough that
 * Codex (and others) will plug in by passing alternative discovery /
 * ingest functions.
 */

export type LiveEvent =
  | { type: "run:created"; run: Run }
  | { type: "run:updated"; run: Run; new_steps: Step[] }
  | { type: "run:completed"; run: Run }
  | { type: "fleet:snapshot"; entries: FleetEntry[] }
  | {
      type: "alert";
      run_id: string;
      kind: "loop" | "stall" | "context_threshold" | "tool_called";
      message: string;
      meta?: Record<string, unknown>;
    }
  /**
   * v0.3 §8.5 — fired once per step whose ingest produced one or more
   * file_change rows. `paths` is the unique path set (deduped across
   * old/new for renames); `partial` is true iff any row in the batch
   * has `partial_diff = true` (e.g. Bash stubs).
   */
  | {
      type: "files:changed";
      run_id: string;
      step_id: string;
      paths: string[];
      partial: boolean;
    }
  /**
   * v0.3 §4.9 — fired on the `pause_requested → paused` transition,
   * i.e. the moment the SDK actually blocked. `step_id` is the last
   * step the inspector observed before the pause acknowledgment, the
   * closest signal we have for "the step that would have started next."
   */
  | {
      type: "run:paused";
      run_id: string;
      step_id: string | null;
      paused_at: string;
    }
  /**
   * v0.3 §4.9 — fired on the `paused | pause_requested → running`
   * transition. `edits` counts distinct non-null inject values the
   * inspector observed during the paused window. Best-effort: an
   * inject queued and consumed entirely between two ticks won't be
   * counted. Document, don't gold-plate.
   */
  | {
      type: "run:resumed";
      run_id: string;
      edits: number;
      resumed_at: string;
    };

export interface FleetEntry {
  run: Run;
  status: LiveStatus;
  context_pct: number;
  recent_tools: string[];
  last_step_at?: string;
  alerts: Array<{ kind: string; message: string }>;
}

/** What the fleet view renders for a fired alert. */
interface FiredAlert {
  kind: string;
  message: string;
}

export interface LiveOptions {
  projectsRoot?: string;
  /** Polling interval (ms) for the projects-root scan. Defaults to 1500. */
  scanIntervalMs?: number;
  /** Stall threshold in seconds. Step inactivity beyond this triggers an alert. */
  stallSeconds?: number;
  /** Context-threshold percentages that fire alerts (in %). */
  contextThresholds?: number[];
  /** Tools that, when called, fire a `tool_called` alert. */
  watchTools?: string[];
  /** Loop detection — N repeated identical tool calls. */
  loopWindow?: number;
}

const DEFAULT_OPTS: Required<LiveOptions> = {
  projectsRoot: claudeProjectsRoot(),
  scanIntervalMs: 1500,
  stallSeconds: 120,
  contextThresholds: [50, 70, 90],
  watchTools: [],
  loopWindow: 4,
};

/**
 * Build the fleet snapshot from the store. Pulled out of `LiveInspector`
 * so the web UI can render the same view as a one-shot, even when
 * `spool web` was launched without `--live`. Live mode passes its
 * `firedAlerts` map; static mode passes nothing and just gets empty
 * alert lists.
 */
export function buildFleetEntries(
  store: Store,
  opts: {
    limit?: number;
    stallSeconds?: number;
    firedAlerts?: Map<string, Map<string, { kind: string; message: string }>>;
  } = {},
): FleetEntry[] {
  const limit = opts.limit ?? 50;
  const stallSeconds = opts.stallSeconds ?? 120;
  const firedAlerts = opts.firedAlerts;
  const runs = listRuns(store, { limit });
  return runs.map((run) => {
    const steps = listSteps(store, run.run_id);
    const lastStep = steps[steps.length - 1];
    const status = classifyRunStatus(run, steps, stallSeconds);
    const ctxPct = contextUtilization(lastStep);
    const recentTools = steps
      .slice(-5)
      .map((s) => s.action.tool_name)
      .filter((x): x is string => !!x);
    const alerts = firedAlerts
      ? Array.from(
          firedAlerts.get(run.run_id)?.values() ??
            ([] as Array<{ kind: string; message: string }>),
        ).map((a) => ({ kind: a.kind, message: a.message }))
      : [];
    return {
      run,
      status,
      context_pct: ctxPct,
      recent_tools: recentTools,
      last_step_at: lastStep?.timestamp,
      alerts,
    };
  });
}

/**
 * Per-run probe bookkeeping for `run:paused` / `run:resumed` emission.
 * We poll the probe file once per tick. Detection is timestamp-based
 * rather than state-edge-based, because a full pause→ack→resume cycle
 * can complete within a single 1500ms tick — observing only
 * `state → state` would silently drop those cycles. Comparing the
 * record's `paused_at_ms` / `resumed_at_ms` against what we saw last
 * tick lets us still emit both events even when the state column
 * lands back at `running`.
 */
interface ProbeTrack {
  state: ProbeFsmState;
  /** Distinct non-null inject values observed during the current paused
   *  window. Reset on window entry (running → pause_requested or
   *  pause_requested → paused for the first time) and on `run:resumed`
   *  emission. */
  edits: number;
  /** The last inject value we saw, used to dedupe sticky values across
   *  ticks (a queued inject that hasn't been consumed yet shouldn't
   *  count twice just because we re-read it). */
  lastInject: string | null;
  /** The most recent `paused_at_ms` we've already emitted on. A new
   *  pause is detected by `record.paused_at_ms !== lastPausedAtMs`. */
  lastPausedAtMs: number | null;
  /** Same idea for resume — separate field because resume's timestamp
   *  advances independently. */
  lastResumedAtMs: number | null;
  /** True when the current FSM state is `pause_requested | paused`.
   *  Inject counting only accrues while this is true. */
  inPauseWindow: boolean;
}

export class LiveInspector extends EventEmitter {
  private store: Store;
  private opts: Required<LiveOptions>;
  private knownPaths = new Set<string>();
  // run_id → (dedup key → display info). The key prevents re-fires; the
  // value is what fleet entries render, so it must be human-readable.
  private firedAlerts = new Map<string, Map<string, FiredAlert>>();
  private lastSizes = new Map<string, number>(); // path → size at last poll
  private lastStepCounts = new Map<string, number>(); // run_id → step count
  private lastStatus = new Map<string, Run["status"]>(); // run_id → last seen status
  private probeTracks = new Map<string, ProbeTrack>(); // run_id → probe poll state
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** Set on the first scan so we can backfill state silently — historical
   *  sessions on disk are not "new runs" the user just kicked off. */
  private booted = false;

  constructor(store: Store, opts: LiveOptions = {}) {
    super();
    this.store = store;
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  async start(): Promise<void> {
    // Seed run bookkeeping from the store BEFORE the backfill tick. The
    // backfill alone can't do this: sessions whose ingest offset is
    // already at EOF return status "empty", and the tick `continue`s
    // before recording lastStepCounts/lastStatus. Post-boot, the first
    // growth of such a run would then emit run:created instead of
    // run:updated — and the run detail page only appends on
    // run:updated, so live append silently never started for any run
    // ingested before `spool web` launched.
    for (const run of listRuns(this.store, { limit: 100_000 })) {
      this.lastStepCounts.set(run.run_id, run.step_count);
      this.lastStatus.set(run.run_id, run.status);
    }
    // First tick = silent backfill. Populate every internal map (knownPaths,
    // lastSizes, lastStepCounts, lastStatus, firedAlerts) without firing
    // run:created / run:completed / alert events. Otherwise startup floods
    // the operator with notifications for sessions that ended weeks ago.
    await this.tick({ silent: true });
    this.booted = true;
    // Fire-and-forget shape probe against a sample of recent sessions —
    // surfaces CC JSONL drift on day one instead of waiting for the
    // parser to silently return wrong data. See shape_probe.ts.
    void this.runShapeProbe().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[spool/shape-probe] probe failed (non-fatal):", err);
    });
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[spool/live] tick error:", err);
      });
    }, this.opts.scanIntervalMs);
  }

  /**
   * Sample the newest few sessions and validate their records against
   * the shapes `types.ts` claims. One warning per unique drift hash
   * (so a single schema change doesn't spam thousands of lines).
   * Disabled when `SPOOL_DISABLE_SHAPE_PROBE` is set — useful for
   * tests with intentionally minimal fixtures.
   */
  private async runShapeProbe(): Promise<void> {
    if (process.env.SPOOL_DISABLE_SHAPE_PROBE) return;
    const sessions = await discoverSessions();
    // newest-first; cap so we don't read the whole history on boot.
    const sample = sessions
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, 5);
    if (sample.length === 0) return;
    const allRecords: unknown[] = [];
    for (const s of sample) {
      try {
        const parsed = await readSession(s.path);
        for (const p of parsed) allRecords.push(p.record);
      } catch {
        // A single unreadable session shouldn't break the probe; skip it.
      }
    }
    const warnings: ShapeWarning[] = probeRecords(allRecords);
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(formatWarning(w));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One scan: discover sessions, re-ingest any whose file has grown,
   * compute the current fleet snapshot, fire alerts where appropriate.
   *
   * `silent: true` runs the same ingest pipeline but suppresses event
   * emission — used for the first-tick backfill at startup so historical
   * runs don't masquerade as freshly-created ones.
   */
  async tick(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    const silent = opts.silent === true;

    const sessions = await discoverSessions();
    // De-dupe paths into a single set so a brand-new file (which qualifies
    // as both "new" AND "size grew from 0") doesn't get processed twice.
    const toProcess = new Set<string>();
    for (const s of sessions) {
      if (!this.knownPaths.has(s.path)) {
        this.knownPaths.add(s.path);
        toProcess.add(s.path);
      }
      const lastSize = this.lastSizes.get(s.path) ?? 0;
      if (s.size_bytes > lastSize) {
        toProcess.add(s.path);
        this.lastSizes.set(s.path, s.size_bytes);
      }
    }

    for (const path of toProcess) {
      try {
        const result = await ingestSession(this.store, path);
        if (result.status === "empty") continue;
        const run = getRun(this.store, result.run_id);
        if (!run) continue;
        const newSteps = collectNewSteps(this.store, run, this.lastStepCounts);
        const wasKnown = this.lastStepCounts.has(run.run_id);
        const prevStatus = this.lastStatus.get(run.run_id);
        this.lastStepCounts.set(run.run_id, run.step_count);
        this.lastStatus.set(run.run_id, run.status);

        if (!silent) {
          if (!wasKnown) {
            this.emit("data", { type: "run:created", run } satisfies LiveEvent);
          } else if (newSteps.length > 0) {
            this.emit("data", {
              type: "run:updated",
              run,
              new_steps: newSteps,
            } satisfies LiveEvent);
          }
          // v0.3 §8.5 — emit `files:changed` for every freshly-ingested
          // step that produced file_change rows. One event per step
          // (rather than one per row) matches the UI consumer: the
          // step card refreshes once with the full row set.
          for (const s of newSteps) {
            this.emitFilesChangedIfAny(run, s);
          }
        }

        // Maybe-alert always runs so firedAlerts gets seeded; pass `silent`
        // so it suppresses emits during the boot backfill but still records
        // which alert keys were "already seen" pre-boot.
        await this.maybeAlert(run, newSteps, silent);

        // Fire run:completed only on the in_progress → ok/error transition,
        // not every tick a completed run gets re-ingested. During the
        // silent backfill we never emit; we just record final status.
        const isTerminal = run.status === "ok" || run.status === "error";
        const wasTerminal = prevStatus === "ok" || prevStatus === "error";
        if (!silent && isTerminal && !wasTerminal) {
          this.emit("data", {
            type: "run:completed",
            run,
          } satisfies LiveEvent);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[spool/live] ingest failed for ${path}:`, err);
      }
    }

    // v0.3 §4.9 — probe state transitions. Polled once per tick across
    // every in_progress run we know about; cheap (single JSON file read
    // per run, ENOENT is the steady state). Catches both web- and
    // CLI-driven pause/resume since both mutate the same on-disk file.
    if (!silent) this.pollProbeStates();

    // Fleet snapshot every tick, regardless of whether anything changed
    // — the UI uses it to compute "time since last activity" countdowns.
    // We DO emit this during silent boot so SSE subscribers connecting
    // immediately after start() get a populated grid right away.
    this.emit("data", {
      type: "fleet:snapshot",
      entries: this.fleetEntries(),
    } satisfies LiveEvent);
  }

  /**
   * Emit `files:changed` if the given step has any file_change rows.
   * Pulled into its own method so tests can exercise the dedup-paths
   * shape without going through a full tick.
   */
  private emitFilesChangedIfAny(run: Run, step: Step): void {
    const fcs = listFileChanges(this.store, { stepId: step.step_id });
    if (fcs.length === 0) return;
    const paths = new Set<string>();
    let partial = false;
    for (const fc of fcs) {
      paths.add(fc.path);
      if (fc.old_path) paths.add(fc.old_path);
      if (fc.partial_diff) partial = true;
    }
    this.emit("data", {
      type: "files:changed",
      run_id: run.run_id,
      step_id: step.step_id,
      paths: Array.from(paths),
      partial,
    } satisfies LiveEvent);
  }

  /**
   * Poll probe state for every run with an active probe file. Two-axis
   * detection: the FSM `state` drives inject-window accounting; the
   * `paused_at_ms` / `resumed_at_ms` timestamps drive `run:paused` /
   * `run:resumed` emission. The timestamp axis matters because a full
   * pause→ack→resume cycle can complete inside one 1500ms tick — a
   * pure `state → state` comparison would silently swallow those
   * events (the bug Codex flagged at this site).
   *
   * Runs without a probe file are skipped entirely: probe files only
   * exist while a run is under operator control (created lazily by
   * `requestPause` / `setInject`, removed by `clearProbe` on terminal
   * cleanup), so the file's presence is the cleanest natural gate.
   * Per-run reads are guarded — a single EACCES or corrupt file on
   * one probe shouldn't degrade `/api/live` for every other run.
   */
  private pollProbeStates(): void {
    for (const runId of this.lastStepCounts.keys()) {
      // Probe file absent → run isn't being probed (or operator cleaned
      // up). Drop any prior tracking so we don't carry stale state for
      // a run that may re-enter the probe protocol later.
      if (!existsSync(probeFilePath(runId))) {
        this.probeTracks.delete(runId);
        continue;
      }

      let record;
      try {
        record = readProbeState(runId);
      } catch (err) {
        // readState re-throws non-ENOENT filesystem errors (EACCES, EIO,
        // corrupt JSON it couldn't auto-recover). Log and skip this one
        // run — never let one bad probe file abort polling for every
        // other in-flight probe.
        // eslint-disable-next-line no-console
        console.error(`[spool/live] probe read failed for ${runId}:`, err);
        continue;
      }

      // Plant a baseline on first sighting with null sentinels, then
      // fall through to the uniform transition logic — that way any
      // timestamps already set on the probe file get emitted exactly
      // once (covers the "operator did everything before we polled" /
      // "server restart mid-pause" cases the SSE clients need to
      // resync on).
      let tracked = this.probeTracks.get(runId);
      if (!tracked) {
        tracked = {
          state: record.state,
          edits: 0,
          lastInject: null,
          lastPausedAtMs: null,
          lastResumedAtMs: null,
          inPauseWindow: false,
        };
        this.probeTracks.set(runId, tracked);
      }

      // Window-entry detection — inject counting accrues only inside
      // `pause_requested | paused`. Entering the window resets the
      // counter; we set it from the current inject (1 if pending, 0
      // otherwise) so a pre-pause inject still counts toward the
      // window it was visible during.
      const nowInWindow =
        record.state === "pause_requested" || record.state === "paused";
      if (nowInWindow && !tracked.inPauseWindow) {
        tracked.edits =
          record.inject !== null && record.inject !== "" ? 1 : 0;
      } else if (
        nowInWindow &&
        record.inject !== null &&
        record.inject !== "" &&
        record.inject !== tracked.lastInject
      ) {
        tracked.edits += 1;
      }
      tracked.lastInject = record.inject;
      tracked.inPauseWindow = nowInWindow;

      // Emit on timestamp advancement, not on state-edge. Pause first
      // (logically precedes resume in any cycle). A fast cycle with
      // both timestamps freshly set fires both events in this tick.
      const newPause =
        record.paused_at_ms !== null &&
        record.paused_at_ms !== tracked.lastPausedAtMs;
      if (newPause) {
        const steps = listSteps(this.store, runId);
        const lastStep = steps[steps.length - 1];
        this.emit("data", {
          type: "run:paused",
          run_id: runId,
          step_id: lastStep?.step_id ?? null,
          paused_at: new Date(record.paused_at_ms!).toISOString(),
        } satisfies LiveEvent);
        tracked.lastPausedAtMs = record.paused_at_ms;
      }

      const newResume =
        record.resumed_at_ms !== null &&
        record.resumed_at_ms !== tracked.lastResumedAtMs;
      if (newResume) {
        this.emit("data", {
          type: "run:resumed",
          run_id: runId,
          edits: tracked.edits,
          resumed_at: new Date(record.resumed_at_ms!).toISOString(),
        } satisfies LiveEvent);
        tracked.edits = 0;
        tracked.lastResumedAtMs = record.resumed_at_ms;
      }

      tracked.state = record.state;
    }
  }

  /** Compute the current fleet view (active + recently-completed runs). */
  fleetEntries(): FleetEntry[] {
    return buildFleetEntries(this.store, {
      stallSeconds: this.opts.stallSeconds,
      firedAlerts: this.firedAlerts,
      limit: 50,
    });
  }

  private async maybeAlert(
    run: Run,
    newSteps: Step[],
    silent = false,
  ): Promise<void> {
    const fired = this.firedAlerts.get(run.run_id) ?? new Map<string, FiredAlert>();
    const fireOrSeed = (key: string, event: LiveEvent & { type: "alert" }) => {
      if (fired.has(key)) return;
      fired.set(key, { kind: event.kind, message: event.message });
      if (!silent) this.emit("data", event);
    };

    // Tool-call alert.
    for (const s of newSteps) {
      if (
        s.action.kind === "tool_call" &&
        s.action.tool_name &&
        this.opts.watchTools.includes(s.action.tool_name)
      ) {
        fireOrSeed(`tool:${s.action.tool_name}:${s.step_id}`, {
          type: "alert",
          run_id: run.run_id,
          kind: "tool_called",
          message: `watched tool ${s.action.tool_name} called at step #${s.sequence}${describeToolInput(s.action.tool_input)}`,
          meta: { step_id: s.step_id, sequence: s.sequence },
        });
      }
    }

    // Context threshold alert (per-step).
    for (const s of newSteps) {
      const pct = contextUtilization(s);
      for (const t of this.opts.contextThresholds) {
        if (pct >= t) {
          fireOrSeed(`ctx:${t}`, {
            type: "alert",
            run_id: run.run_id,
            kind: "context_threshold",
            message: `context window ${pct}% full — crossed the ${t}% threshold at step #${s.sequence}`,
            meta: { sequence: s.sequence, percent: pct },
          });
        }
      }
    }

    // Loop detection.
    const allSteps = listSteps(this.store, run.run_id);
    const loop = detectLoop(allSteps, this.opts.loopWindow);
    if (loop) {
      fireOrSeed(`loop:${loop.tool}:${loop.signature}`, {
        type: "alert",
        run_id: run.run_id,
        kind: "loop",
        message: `possible loop: last ${loop.repeats} steps all called ${loop.tool} with identical input (${loop.signature.slice(0, 48)}…)`,
        meta: { window: this.opts.loopWindow },
      });
    }

    // Stall detection — only meaningful for runs we'd plausibly intervene
    // on. Skip:
    //   - non-in_progress runs (terminal already)
    //   - runs that haven't been touched in > 1 hour (operator presumably
    //     abandoned the session; alerting "no activity for 48h" on a
    //     historical session is noise, not signal).
    if (run.status === "in_progress" && allSteps.length > 0) {
      const lastTs = new Date(allSteps[allSteps.length - 1]!.timestamp).getTime();
      const ageS = (Date.now() - lastTs) / 1000;
      const HOUR = 3600;
      if (ageS > this.opts.stallSeconds && ageS < HOUR) {
        // One stall line per card: the dedup key advances every minute
        // (so SSE re-alerts as the stall deepens), but stale minute-keys
        // are dropped so the fleet entry shows only the current figure.
        for (const k of fired.keys()) {
          if (k.startsWith("stall:")) fired.delete(k);
        }
        const lastStep = allSteps[allSteps.length - 1]!;
        const doing =
          lastStep.action.kind === "tool_call" && lastStep.action.tool_name
            ? `after calling ${lastStep.action.tool_name}`
            : `after a ${lastStep.action.kind} step`;
        fireOrSeed(`stall:${Math.floor(ageS / 60)}`, {
          type: "alert",
          run_id: run.run_id,
          kind: "stall",
          message: `stalled at step #${lastStep.sequence} ${doing} — no activity for ${formatDuration(ageS)}`,
        });
      }
    }

    if (fired.size > 0) this.firedAlerts.set(run.run_id, fired);
  }
}

function collectNewSteps(
  store: Store,
  run: Run,
  lastCounts: Map<string, number>,
): Step[] {
  const last = lastCounts.get(run.run_id) ?? 0;
  const all = listSteps(store, run.run_id);
  return all.slice(last);
}

/** "312s" reads worse than "5m 12s" on a fleet card. */
function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * One-line summary of a watched tool's input for the alert message,
 * e.g. ` — command: "rm -rf node_modules"`. Picks the single most
 * identifying field; falls back to nothing rather than dumping JSON.
 */
function describeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const field of ["command", "file_path", "path", "url", "pattern", "query"]) {
    const v = obj[field];
    if (typeof v === "string" && v.length > 0) {
      const preview = v.length > 60 ? `${v.slice(0, 60)}…` : v;
      return ` — ${field}: "${preview}"`;
    }
  }
  return "";
}

/**
 * Runtime-toggleable owner of a LiveInspector. Existed implicitly in
 * v0.2 (each `spool web --live` invocation built an inspector at
 * startup and discarded it on close). v0.3 needs runtime toggling
 * because the web UI's "Live" button starts/stops without restarting
 * the server.
 *
 * The class is a thin shell — it forwards `on`/`off`/`fleetEntries`
 * to whichever inspector instance is currently active, and a
 * stopped-state stub for the off case so the routes always have
 * something safe to call.
 *
 * Listener routing: the controller stores subscribers itself and
 * re-binds them to any new inspector it spawns. That means an SSE
 * client opened *before* live mode is enabled will start receiving
 * events as soon as the operator hits the toggle, with no reconnect.
 */
export class LiveController {
  private store: Store;
  private inspector?: LiveInspector;
  private subscribers = new Set<(e: LiveEvent) => void>();
  private storeOpts: LiveOptions = {};

  constructor(store: Store) {
    this.store = store;
  }

  /** Spin up an inspector if one isn't already running. Idempotent. */
  async start(opts?: LiveOptions): Promise<void> {
    if (this.inspector) return;
    if (opts) this.storeOpts = opts;
    const inspector = new LiveInspector(this.store, this.storeOpts);
    // Re-bind every subscriber to the new inspector so SSE clients
    // opened pre-start receive events seamlessly post-start.
    for (const fn of this.subscribers) inspector.on("data", fn);
    this.inspector = inspector;
    await inspector.start();
  }

  /** Stop the running inspector if any. Idempotent. */
  stop(): void {
    if (!this.inspector) return;
    for (const fn of this.subscribers) this.inspector.off("data", fn);
    this.inspector.stop();
    this.inspector = undefined;
  }

  isLive(): boolean {
    return this.inspector !== undefined;
  }

  on(event: "data", fn: (e: LiveEvent) => void): void {
    this.subscribers.add(fn);
    this.inspector?.on(event, fn);
  }

  off(event: "data", fn: (e: LiveEvent) => void): void {
    this.subscribers.delete(fn);
    this.inspector?.off(event, fn);
  }

  /** Latest fleet snapshot — empty when not running. */
  fleetEntries(): FleetEntry[] {
    if (!this.inspector) return [];
    return this.inspector.fleetEntries();
  }
}
