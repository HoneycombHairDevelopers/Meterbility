import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  LiveInspector,
  FileSentinel,
  type LiveEvent,
  type FileSentinelEvent,
} from "@meterbility/server";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listFileChanges,
  listRuns,
  listSteps,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import type { FileChange, Run, Step } from "@meterbility/shared";
import {
  RESERVED_SEQUENCE_BASE,
  claudeProjectsRoot,
  dbPath,
} from "@meterbility/shared";
import { openStore } from "../util.ts";
import { printPretty, printFileEvent, timeHead } from "../render_events.ts";

/**
 * `meter live` — the one-command front door for watching a session and
 * its file side effects (docs/designs/meter-live-front-door.md).
 *
 * Composes shipped parts: LiveInspector (incremental session ingest)
 * and FileSentinel (filesystem side-effect capture) in one process —
 * exactly what `meter watch --files` wires, packaged as the blessed
 * path with a self-explaining header, a capture-health line, and an
 * honest SYNCING state while historical backfill runs.
 *
 * Capture-health (design §4): "degraded" is a cross-check, never a
 * bare timer — file-touching steps were ingested for cwd-overlapping
 * runs (from the in-process ingest stream, NEVER from sentinel output
 * — the check must not depend on the plane it checks) AND no raw
 * filesystem event arrived within the threshold. An idle repo is
 * healthy. Thresholds from the 2026-08-19 starvation investigation:
 * >5s warn, >15s degraded; healthy hosts measure ≤0.7s.
 *
 * Concurrency (design §2): one sentinel per root, enforced without
 * locks. A fresh `live.heartbeat` (<2 min) means another instance
 * holds capture; this one attaches viewer-only. `--force-capture`
 * overrides. The holder's heartbeat self-expires if it crashes.
 */

const HEARTBEAT_FRESH_MS = 2 * 60_000;
const EVALUATOR_INTERVAL_MS = 5_000;
const HEALTH_WARN_MS = 5_000;
const HEALTH_DEGRADED_MS = 15_000;
const HEALTH_NUMERATOR_WINDOW_MS = 15_000;
const STARTUP_GRACE_MS = 20_000;
/** Repeat interval for a persisting degraded warning (pretty mode). */
const DEGRADED_REMIND_MS = 30_000;

/** Tool names whose steps count as potentially file-touching (eng
 *  review 1A). Shell tools count: a Bash step editing files is exactly
 *  what the sentinel exists to capture, and a `ls`-only Bash step can
 *  only ever produce a quiet warn, never a false degraded on its own
 *  (the threshold requires sustained raw-event silence). */
const FILE_TOUCHING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "Bash",
  "shell",
  "run_terminal_cmd",
  "str_replace_editor",
]);

type HealthVerdict = "healthy" | "warn" | "degraded";

export function registerLiveCommand(program: Command): void {
  program
    .command("live [run-id-or-prefix]")
    .description(
      "Watch sessions live: ingest + file side-effect capture in one command (the front door)",
    )
    .option(
      "--files-dir <path>",
      "Watch this directory tree for file side effects instead of the current directory",
    )
    .option("--no-files", "Skip file side-effect capture (ingest + stream only)")
    .option(
      "--force-capture",
      "Start a FileSentinel even when another meter live instance holds capture",
    )
    .option("--json", "Emit NDJSON events (superset of `meter watch --json`)")
    .option(
      "--attribution-window <n>",
      "Max seconds between a step and a file event for attribution",
      (v) => parseInt(v, 10),
      120,
    )
    .action(
      async (
        runFilter: string | undefined,
        opts: {
          filesDir?: string;
          files: boolean;
          forceCapture?: boolean;
          json?: boolean;
          attributionWindow: number;
        },
      ) => {
        const store = openStore();
        const filesRoot = resolve(opts.filesDir ?? process.cwd());
        const matchesRun = (id: string): boolean =>
          !runFilter || id === runFilter || id.startsWith(runFilter);

        // ── Viewer-guard: one sentinel per root (design §2) ────────
        let viewerOnly = false;
        if (opts.files) {
          const hb = getSetting(store, "live.heartbeat");
          const hbAge = hb ? Date.now() - Date.parse(hb) : Infinity;
          if (Number.isFinite(hbAge) && hbAge < HEARTBEAT_FRESH_MS && !opts.forceCapture) {
            viewerOnly = true;
          }
        }
        const runsSentinel = opts.files && !viewerOnly;

        // ── Startup header (design §1) ─────────────────────────────
        const emitJson = (obj: unknown): void => {
          process.stdout.write(JSON.stringify(obj) + "\n");
        };
        const active = listRuns(store, { limit: 50 }).filter(
          (r) => r.status === "in_progress" && matchesRun(r.run_id),
        );
        if (!opts.json) {
          printHeader({
            store,
            active,
            filesRoot,
            runsSentinel,
            viewerOnly,
            runFilter,
          });
        }

        // ── SYNCING state (outside-voice T3) ───────────────────────
        // The inspector's first tick is a silent full backfill; until
        // its first fleet:snapshot, stream lines are historical
        // catch-up, not live activity — prefix them and suppress
        // health so no confident-but-wrong verdict ships on partial
        // data. Session count is a cheap approximation for the
        // progress line.
        let synced = false;
        if (!opts.json) {
          const n = countSessionFiles();
          console.log(
            pc.dim(
              `SYNCING · backfilling ${n > 0 ? `~${n} session${n === 1 ? "" : "s"}` : "session backlog"}…`,
            ),
          );
        }

        // ── Live stream (design §3) ────────────────────────────────
        // Delta re-emit handling (eng review 3A): LiveInspector
        // re-announces a step when its row count grows (late hook
        // drains). Track announced counts; print only NEW rows, tagged
        // `(update)` — late Bash evidence visibly arrives, no
        // duplicate full-step lines.
        const announced = new Map<string, number>(); // step_id → rows printed
        let printedAtHint = false;

        // 7A in-memory health numerator: arrival timestamps of
        // file-touching steps for cwd-overlapping runs, post-sync only
        // (backfill arrivals are historical, not activity).
        const touchRing: number[] = [];

        const live = new LiveInspector(store, {});

        // Signal handlers register BEFORE any await: a ctrl-c during
        // startup (backfill can take a while on a cold store) must
        // still exit cleanly and release the heartbeat, not die on the
        // default handler mid-initialization.
        let sentinel: FileSentinel | undefined;
        let evaluator: NodeJS.Timeout | undefined;
        const stop = (): void => {
          if (evaluator) clearInterval(evaluator);
          live.stop();
          sentinel?.stop();
          if (sentinel) {
            // Clean handoff: release the capture claim immediately so
            // the next instance doesn't wait out the staleness window.
            try {
              deleteSetting(store, "live.heartbeat");
            } catch {
              // best-effort — staleness self-expires anyway
            }
          }
          try {
            store.close();
          } catch {
            // already closed / mid-write — exiting regardless
          }
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);

        live.on("data", (e: LiveEvent) => {
          if (e.type === "fleet:snapshot" && !synced) {
            synced = true;
            if (!opts.json) console.log(pc.dim("SYNCED · streaming live"));
          }
          // Health numerator feed — before display filtering: capture
          // stays global, and so does the health view of activity.
          if (e.type === "run:updated" && synced && cwdOverlaps(e.run.cwd, filesRoot)) {
            const now = Date.now();
            for (const s of e.new_steps) {
              if (s.sequence >= RESERVED_SEQUENCE_BASE) continue;
              if (isFileTouching(s)) touchRing.push(now);
            }
            // Bounded: drop entries older than the window.
            while (touchRing.length > 0 && now - touchRing[0]! > HEALTH_NUMERATOR_WINDOW_MS) {
              touchRing.shift();
            }
          }

          // Display filter (design §3): the argument filters DISPLAY
          // only — ingest and capture remain global.
          if (
            runFilter &&
            (e.type === "run:created" || e.type === "run:updated" || e.type === "run:completed") &&
            !matchesRun(e.run.run_id)
          ) {
            return;
          }
          if (runFilter && (e.type === "alert" || e.type === "files:changed") && !matchesRun(e.run_id)) {
            return;
          }

          if (opts.json) {
            emitJson(e);
            return;
          }

          if (e.type === "files:changed") {
            printStepFileDelta(store, e, announced, synced);
            if (!printedAtHint && synced) {
              printedAtHint = true;
              console.log(
                pc.dim(
                  `  ↳ meter files ${e.run_id.slice(0, 12)} --at ${e.sequence} shows this step's changes · --from N for a range`,
                ),
              );
            }
            return;
          }
          if (e.type === "fleet:snapshot") return; // header noise in live mode
          const prefix = synced ? "" : pc.dim("[sync] ");
          if (prefix) process.stdout.write(prefix);
          printPretty(e);
        });

        await live.start();

        // ── File side-effect capture ───────────────────────────────
        if (runsSentinel) {
          if (!existsSync(filesRoot) || !statSync(filesRoot).isDirectory()) {
            console.error(
              pc.red(
                `meter live: --files-dir is not a directory: ${filesRoot} — continuing without file capture`,
              ),
            );
          } else {
            sentinel = new FileSentinel(store, {
              root: filesRoot,
              attributionWindowMs: opts.attributionWindow * 1000,
            });
            sentinel.on("data", (e: FileSentinelEvent) => {
              if (opts.json) {
                emitJson(e);
                return;
              }
              printFileEvent(e);
            });
            try {
              await sentinel.start();
            } catch (err) {
              console.error(
                pc.red(
                  `meter live: file capture failed to start (${String(err)}) — continuing without it`,
                ),
              );
              sentinel.stop();
              sentinel = undefined;
            }
          }
        }

        // ── Heartbeat + capture-health evaluator (design §4) ───────
        let lastVerdict: HealthVerdict = "healthy";
        let lastDegradedPrint = 0;
        let lastLossCount = 0;
        const startedAt = Date.now();
        evaluator = setInterval(() => {
          // Heartbeat: only the capture-holder writes it (viewer-only
          // instances must not extend the guard past the holder's
          // lifetime).
          if (sentinel) {
            try {
              setSetting(store, "live.heartbeat", new Date().toISOString());
            } catch {
              // Store contention is never worth killing the stream.
            }
          }
          if (!synced) return; // no verdicts on partial data (T3)
          const h = sentinel?.health();
          if (opts.json) {
            const rawAge =
              h === undefined
                ? undefined
                : Date.now() - (h.last_raw_event_at ?? h.ready_at ?? startedAt);
            emitJson({
              type: "capture:health",
              mode: sentinel ? "capturing" : viewerOnly ? "viewer-only" : "no-files",
              fs_event_age_ms: rawAge,
              file_touching_steps_recent: touchRing.length,
              unattributed_lost: h?.unattributed_no_recent_step ?? 0,
              degraded: sentinel ? evaluateHealth(h!, touchRing, startedAt) === "degraded" : false,
            });
            return;
          }
          if (!sentinel) return;
          const verdict = evaluateHealth(h!, touchRing, startedAt);
          const lost = h!.unattributed_no_recent_step;
          const now = Date.now();
          const lossGrew = lost > lastLossCount;
          if (
            verdict !== lastVerdict ||
            lossGrew ||
            (verdict === "degraded" && now - lastDegradedPrint > DEGRADED_REMIND_MS)
          ) {
            printHealthLine(verdict, h!, touchRing.length, lost, lossGrew);
            if (verdict === "degraded") lastDegradedPrint = now;
          }
          lastVerdict = verdict;
          lastLossCount = lost;
        }, EVALUATOR_INTERVAL_MS);
        // Don't let the evaluator keep the process alive on its own.
        evaluator.unref?.();
      },
    );
}

// ─── Header ──────────────────────────────────────────────────────────

function printHeader(args: {
  store: Store;
  active: Run[];
  filesRoot: string;
  runsSentinel: boolean;
  viewerOnly: boolean;
  runFilter?: string;
}): void {
  const { store, active, filesRoot, runsSentinel, viewerOnly, runFilter } = args;
  console.log(
    pc.bold("meter live") +
      pc.dim(
        ` · sessions from ${claudeProjectsRoot()}` + (runFilter ? ` · filter=${runFilter}` : ""),
      ),
  );
  const captureLine = runsSentinel
    ? `hooks (exact, where installed) + sentinel fallback on ${filesRoot}`
    : viewerOnly
      ? `viewer-only — another meter live holds file capture (--force-capture to override)`
      : `ingest only (--no-files)`;
  console.log(pc.dim(`  capture: ${captureLine}`));
  console.log(pc.dim(`  db: ${dbPath()}`));
  if (viewerOnly) {
    console.log(pc.yellow("  capture already active — attaching as viewer"));
  }
  if (active.length === 0) {
    console.log(
      pc.yellow(
        "\n  no active session — start your agent (claude, cursor, codex, or `meter run -- <cmd>`);\n  I'll attach the moment one appears. press ctrl-c to stop\n",
      ),
    );
    return;
  }
  console.log("");
  for (const r of active) {
    const steps = listSteps(store, r.run_id).filter(
      (s) => s.sequence < RESERVED_SEQUENCE_BASE,
    );
    const current = steps.length > 0 ? steps[steps.length - 1]!.sequence : 0;
    // v0.6 provider identity (schema v6): proxy-captured runs speak
    // their provider, never a generic "proxy".
    const providerTag = r.provider
      ? pc.magenta(`[${r.provider}${r.upstream_host ? ` ${r.upstream_host}` : ""}] `)
      : "";
    console.log(
      "  " +
        pc.cyan(r.run_id.slice(0, 12)) +
        `  ${providerTag}` +
        pc.dim(`${r.source_runtime} · step ${current}`) +
        (r.title ? `  ${r.title}` : ""),
    );
  }
  console.log(pc.dim("\n  press ctrl-c to stop\n"));
}

// ─── Stream: per-step file-change deltas (eng review 3A) ─────────────

export function printStepFileDelta(
  store: Store,
  e: Extract<LiveEvent, { type: "files:changed" }>,
  announced: Map<string, number>,
  synced: boolean,
): void {
  const rows = listFileChanges(store, { stepId: e.step_id });
  const seen = announced.get(e.step_id) ?? 0;
  const fresh = rows.slice(seen);
  announced.set(e.step_id, rows.length);
  if (fresh.length === 0) return;
  const update = seen > 0;
  const syncPrefix = synced ? "" : pc.dim("[sync] ");
  for (const fc of fresh) {
    console.log(syncPrefix + formatFileRow(e, fc, update));
  }
}

function formatFileRow(
  e: Extract<LiveEvent, { type: "files:changed" }>,
  fc: FileChange,
  update: boolean,
): string {
  const opBadge = fc.op === "create" ? "A" : fc.op === "delete" ? "D" : "M";
  const tool = fc.source_tool_name ?? (fc.derived_from === "filesystem_watch" ? "fs" : "tool");
  const stat = fc.partial_diff
    ? pc.yellow("(partial)")
    : pc.dim(`+${fc.lines_added} −${fc.lines_removed}`);
  const coalesced = (fc.normalizer_notes as { coalesced_events?: number } | undefined)
    ?.coalesced_events;
  return (
    timeHead() +
    pc.bold(`step ${e.sequence}`) +
    (update ? pc.dim(" (update)") : "") +
    ` · ${pc.cyan(e.run_id.slice(0, 12))} · ${tool} ${opBadge} ${fc.path} ` +
    stat +
    (coalesced ? pc.dim(` · net of ${coalesced} events`) : "")
  );
}

// ─── Capture health (design §4, investigation-validated) ─────────────

export function evaluateHealth(
  h: {
    ready_at?: number;
    raw_event_count: number;
    last_raw_event_at?: number;
    unattributed_no_recent_step: number;
  },
  touchRing: number[],
  startedAt: number,
): HealthVerdict {
  const now = Date.now();
  const numerator = touchRing.filter((t) => now - t <= HEALTH_NUMERATOR_WINDOW_MS).length;
  if (numerator === 0) return "healthy"; // idle repo is healthy, not degraded
  const anchor = h.last_raw_event_at ?? h.ready_at ?? startedAt;
  const rawAge = now - anchor;
  // Startup grace: FSEvents streams come live asynchronously (2s–15s+
  // under load). No degraded verdict until the stream has proven
  // itself once, or the grace period after ready has elapsed.
  const graceElapsed =
    h.raw_event_count > 0 || now - (h.ready_at ?? startedAt) > STARTUP_GRACE_MS;
  if (rawAge > HEALTH_DEGRADED_MS && graceElapsed) return "degraded";
  if (rawAge > HEALTH_WARN_MS) return "warn";
  return "healthy";
}

function printHealthLine(
  verdict: HealthVerdict,
  h: {
    ready_at?: number;
    raw_event_count: number;
    last_raw_event_at?: number;
    unattributed_no_recent_step: number;
  },
  numerator: number,
  lost: number,
  lossGrew: boolean,
): void {
  const head = timeHead();
  if (verdict === "degraded") {
    console.log(
      head +
        pc.red("capture:degraded") +
        "  steps are editing files but no filesystem events for ≥15s — " +
        "file capture degraded (host fseventsd?) — hook-based capture unaffected",
    );
  } else if (verdict === "warn") {
    console.log(
      head +
        pc.yellow("capture:warn") +
        `  file events lagging >5s with ${numerator} file-touching step${numerator === 1 ? "" : "s"} recently ingested`,
    );
  } else {
    console.log(head + pc.green("capture:healthy") + pc.dim("  file events flowing"));
  }
  if (lossGrew) {
    console.log(
      head +
        pc.red("capture:lost") +
        `  ${lost} change${lost === 1 ? "" : "s"} arrived too late to attribute (outside the attribution window) — data loss, not lag`,
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Same overlap predicate FileSentinel uses for attribution — a
 *  session editing a different repo can't move this root's health. */
function cwdOverlaps(cwd: string | undefined, root: string): boolean {
  if (!cwd) return false;
  const norm = resolve(cwd);
  return norm === root || root.startsWith(norm + "/") || norm.startsWith(root + "/");
}

/** Eng review 1A: sourced from step ACTIONS (always present in ingest)
 *  — never from filesystem_watch rows, which come from the plane this
 *  check exists to verify. */
export function isFileTouching(s: Step): boolean {
  return (
    s.action.kind === "tool_call" &&
    s.action.tool_name !== undefined &&
    FILE_TOUCHING_TOOLS.has(s.action.tool_name)
  );
}

/** Cheap SYNCING progress approximation: count session transcripts on
 *  disk. Best-effort — an unreadable root just means no count. */
function countSessionFiles(): number {
  try {
    const entries = readdirSync(claudeProjectsRoot(), {
      recursive: true,
      encoding: "utf-8",
    });
    return entries.filter((p) => p.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}
