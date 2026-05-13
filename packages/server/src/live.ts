import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { claudeProjectsRoot } from "@spool/shared";
import { ingestSession, discoverSessions } from "@spool/claude-code-adapter";
import {
  getRun,
  listRuns,
  listSteps,
} from "@spool/collector";
import type { Store } from "@spool/collector";
import type { Run, Step } from "@spool/shared";
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
    };

export interface FleetEntry {
  run: Run;
  status: LiveStatus;
  context_pct: number;
  recent_tools: string[];
  last_step_at?: string;
  alerts: Array<{ kind: string; message: string }>;
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
    firedAlerts?: Map<string, Set<string>>;
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
      ? Array.from(firedAlerts.get(run.run_id) ?? new Set<string>()).map(
          (kind) => ({ kind, message: kind }),
        )
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

export class LiveInspector extends EventEmitter {
  private store: Store;
  private opts: Required<LiveOptions>;
  private knownPaths = new Set<string>();
  private firedAlerts = new Map<string, Set<string>>(); // run_id → alert keys
  private lastSizes = new Map<string, number>(); // path → size at last poll
  private lastStepCounts = new Map<string, number>(); // run_id → step count
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(store: Store, opts: LiveOptions = {}) {
    super();
    this.store = store;
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  async start(): Promise<void> {
    if (!existsSync(this.opts.projectsRoot)) {
      // Nothing to watch — emit empty fleet snapshot and bail; the loop
      // can still tick in case the directory appears later.
      this.emit("data", {
        type: "fleet:snapshot",
        entries: [],
      } satisfies LiveEvent);
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[spool/live] tick error:", err);
      });
    }, this.opts.scanIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One scan: discover sessions, re-ingest any whose file has grown,
   * compute the current fleet snapshot, fire alerts where appropriate.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;

    const sessions = await discoverSessions();
    const newPaths: string[] = [];
    const updatedPaths: string[] = [];
    for (const s of sessions) {
      if (!this.knownPaths.has(s.path)) {
        this.knownPaths.add(s.path);
        newPaths.push(s.path);
      }
      const lastSize = this.lastSizes.get(s.path) ?? 0;
      if (s.size_bytes > lastSize) {
        updatedPaths.push(s.path);
        this.lastSizes.set(s.path, s.size_bytes);
      }
    }

    for (const path of [...newPaths, ...updatedPaths]) {
      try {
        const result = await ingestSession(this.store, path);
        if (result.status === "empty") continue;
        const run = getRun(this.store, result.run_id);
        if (!run) continue;
        const newSteps = collectNewSteps(this.store, run, this.lastStepCounts);
        const wasKnown = this.lastStepCounts.has(run.run_id);
        this.lastStepCounts.set(run.run_id, run.step_count);
        if (!wasKnown) {
          this.emit("data", { type: "run:created", run } satisfies LiveEvent);
        } else {
          this.emit("data", {
            type: "run:updated",
            run,
            new_steps: newSteps,
          } satisfies LiveEvent);
        }
        await this.maybeAlert(run, newSteps);
        if (run.status === "ok" || run.status === "error") {
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

    // Fleet snapshot every tick, regardless of whether anything changed
    // — the UI uses it to compute "time since last activity" countdowns.
    this.emit("data", {
      type: "fleet:snapshot",
      entries: this.fleetEntries(),
    } satisfies LiveEvent);
  }

  /** Compute the current fleet view (active + recently-completed runs). */
  fleetEntries(): FleetEntry[] {
    return buildFleetEntries(this.store, {
      stallSeconds: this.opts.stallSeconds,
      firedAlerts: this.firedAlerts,
      limit: 50,
    });
  }

  private async maybeAlert(run: Run, newSteps: Step[]): Promise<void> {
    const fired = this.firedAlerts.get(run.run_id) ?? new Set<string>();

    // Tool-call alert.
    for (const s of newSteps) {
      if (
        s.action.kind === "tool_call" &&
        s.action.tool_name &&
        this.opts.watchTools.includes(s.action.tool_name)
      ) {
        const key = `tool:${s.action.tool_name}:${s.step_id}`;
        if (!fired.has(key)) {
          fired.add(key);
          this.emit("data", {
            type: "alert",
            run_id: run.run_id,
            kind: "tool_called",
            message: `agent called ${s.action.tool_name}`,
            meta: { step_id: s.step_id, sequence: s.sequence },
          } satisfies LiveEvent);
        }
      }
    }

    // Context threshold alert (per-step).
    for (const s of newSteps) {
      const pct = contextUtilization(s);
      for (const t of this.opts.contextThresholds) {
        if (pct >= t) {
          const key = `ctx:${t}`;
          if (!fired.has(key)) {
            fired.add(key);
            this.emit("data", {
              type: "alert",
              run_id: run.run_id,
              kind: "context_threshold",
              message: `context utilization ≥ ${t}%`,
              meta: { sequence: s.sequence, percent: pct },
            } satisfies LiveEvent);
          }
        }
      }
    }

    // Loop detection.
    const allSteps = listSteps(this.store, run.run_id);
    const loop = detectLoop(allSteps, this.opts.loopWindow);
    if (loop) {
      const key = `loop:${loop.tool}:${loop.signature}`;
      if (!fired.has(key)) {
        fired.add(key);
        this.emit("data", {
          type: "alert",
          run_id: run.run_id,
          kind: "loop",
          message: `${loop.repeats}× ${loop.tool} with same args`,
          meta: { window: this.opts.loopWindow },
        } satisfies LiveEvent);
      }
    }

    // Stall detection — only meaningful for in-progress runs.
    if (run.status === "in_progress" && allSteps.length > 0) {
      const lastTs = new Date(allSteps[allSteps.length - 1]!.timestamp).getTime();
      const ageS = (Date.now() - lastTs) / 1000;
      if (ageS > this.opts.stallSeconds) {
        const key = `stall:${Math.floor(ageS / 60)}`;
        if (!fired.has(key)) {
          fired.add(key);
          this.emit("data", {
            type: "alert",
            run_id: run.run_id,
            kind: "stall",
            message: `no activity for ${Math.round(ageS)}s`,
          } satisfies LiveEvent);
        }
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
