import { readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  LiveInspector,
  FileSentinel,
  cwdOverlapsRoot,
  type LiveEvent,
  type FileSentinelEvent,
  type SentinelHealth,
} from "@meterbility/server";
import {
  listFileChanges,
  listRuns,
  maxMainBandSequence,
  liveCaptureHeldFor,
  liveClaimOwner,
  writeLiveHeartbeat,
  clearLiveHeartbeat,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import type { FileChange, Run, Step } from "@meterbility/shared";
import {
  RESERVED_SEQUENCE_BASE,
  claudeProjectsRoot,
  dbPath,
} from "@meterbility/shared";
import { openStore } from "../util.ts";
import {
  printPretty,
  printFileEvent,
  timeHead,
  opBadge,
  lineStat,
  sanitizeTerminal,
} from "../render_events.ts";

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

const EVALUATOR_INTERVAL_MS = 5_000;
/** Recency page size for the header's active-session scan. An
 *  in-progress run older than this many rows is omitted from the
 *  HEADER only (the stream still shows it) — bounded startup cost
 *  beats an unbounded scan of a large store. */
const HEADER_RUN_SCAN_LIMIT = 50;
const HEALTH_WARN_MS = 5_000;
const HEALTH_DEGRADED_MS = 15_000;
const HEALTH_NUMERATOR_WINDOW_MS = 15_000;
const STARTUP_GRACE_MS = 20_000;
/** Repeat interval for a persisting degraded warning (pretty mode). */
const DEGRADED_REMIND_MS = 30_000;

/** Tools whose steps DEFINITELY write files — these escalate the
 *  health verdict all the way to degraded when the raw event stream
 *  goes silent (eng review 1A). */
const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "str_replace_editor",
  // Cursor main-band tool names (adapters/cursor — native tf.name):
  "edit_file_v2",
  "search_replace",
  "delete_file",
]);

/** Tools that only MIGHT write (shell commands). They feed the warn
 *  tier but never escalate to degraded on their own — a sustained
 *  read-only Bash loop (grep/test/lint) over an idle tree is normal,
 *  not capture loss (red-team finding against the original 1A set). */
const SHELL_TOOLS = new Set(["Bash", "shell", "run_terminal_cmd"]);

type HealthVerdict = "healthy" | "warn" | "degraded";

/** Health-ring entry: arrival time + whether the step's tool
 *  definitely writes files (vs shell "might"). */
export interface TouchEntry {
  t: number;
  write: boolean;
}

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
        if (opts.files && !opts.forceCapture && liveCaptureHeldFor(store, filesRoot)) {
          viewerOnly = true;
        }
        // Validate the files root BEFORE the header prints so the
        // header's capture line reflects what will actually run
        // (review finding: never claim an action that is then skipped).
        let filesRootValid = true;
        if (opts.files) {
          try {
            if (!statSync(filesRoot).isDirectory()) filesRootValid = false;
          } catch {
            filesRootValid = false; // missing or vanished — same answer
          }
          if (!filesRootValid) {
            console.error(
              pc.red(
                `meter live: --files-dir is not a directory: ${filesRoot} — continuing without file capture`,
              ),
            );
          }
        }
        const runsSentinel = opts.files && !viewerOnly && filesRootValid;
        // Holder identity: lets this instance detect losing a
        // simultaneous-start race (both passed the guard in the same
        // check-to-write window) and downgrade, instead of two
        // sentinels refreshing each other forever (adversarial 4).
        const ownerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
        let claimRefresher: NodeJS.Timeout | undefined;
        if (runsSentinel) {
          // Claim capture IMMEDIATELY (red-team TOCTOU finding) and
          // keep refreshing from the start — the evaluator only exists
          // after the backfill, and a cold backfill can outlive the
          // 2-minute freshness window (adversarial 3).
          try {
            writeLiveHeartbeat(store, filesRoot, ownerId);
          } catch {
            // Claim is best-effort; the refresher re-writes each tick.
          }
          claimRefresher = setInterval(() => {
            try {
              writeLiveHeartbeat(store, filesRoot, ownerId);
            } catch {
              // staleness self-expires
            }
          }, EVALUATOR_INTERVAL_MS);
          claimRefresher.unref?.();
        }

        // ── Startup header (design §1) ─────────────────────────────
        const emitJson = (obj: unknown): void => {
          process.stdout.write(JSON.stringify(obj) + "\n");
        };
        const active = listRuns(store, { limit: HEADER_RUN_SCAN_LIMIT }).filter(
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
        const announced = new Map<string, number>(); // run:step → rows printed
        // file_change_ids already printed as file:captured sentinel
        // events in THIS process — the files:changed delta printer
        // skips them so one physical change never prints twice
        // (adversarial 16). Size-capped; hook-drain rows from other
        // processes are never in here and still print as step rows.
        const sentinelPrinted = new Set<string>();
        let printedAtHint = false;

        // 7A in-memory health numerator: arrival timestamps of
        // file-touching steps for cwd-overlapping runs, post-sync only
        // (backfill arrivals are historical, not activity). Entries
        // remember whether the tool DEFINITELY writes files (Edit/
        // Write/apply_patch) or only MIGHT (Bash/shell) — shell-only
        // activity caps at warn, never degraded (red-team finding: a
        // sustained read-only Bash loop is not capture loss).
        const touchRing: TouchEntry[] = [];

        const live = new LiveInspector(store, {});
        // run_id → provider label for stream-line tags (schema v6).
        // Seeded from the header scan; refreshed from run events.
        const providerByRun = new Map<string, string>();
        for (const r of active) if (r.provider) providerByRun.set(r.run_id, r.provider);
        // Last ingest activity — feeds capture:health's ingest_lag_ms.
        let lastIngestAt: number | undefined;

        // Signal handlers register BEFORE any await: a ctrl-c during
        // startup (backfill can take a while on a cold store) must
        // still exit cleanly and release the heartbeat, not die on the
        // default handler mid-initialization.
        let sentinel: FileSentinel | undefined;
        let evaluator: NodeJS.Timeout | undefined;
        const stop = (): void => {
          if (claimRefresher) clearInterval(claimRefresher);
          if (evaluator) clearInterval(evaluator);
          live.stop();
          sentinel?.stop();
          if (sentinel || runsSentinel) {
            // Clean handoff: release THIS ROOT's claim immediately so
            // the next instance doesn't wait out the staleness window.
            // runsSentinel too: the startup claim exists even if the
            // sentinel later failed to start.
            try {
              clearLiveHeartbeat(store, filesRoot);
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
          if (e.type === "run:created" || e.type === "run:updated") {
            if (e.run.provider) providerByRun.set(e.run.run_id, e.run.provider);
            if (e.type === "run:updated" && e.new_steps.length > 0) lastIngestAt = Date.now();
          }
          if (e.type === "run:completed") {
            // Evict per-run stream state — a days-long live session must
            // not accumulate step bookkeeping for finished runs.
            providerByRun.delete(e.run.run_id);
            for (const key of announced.keys()) {
              if (key.startsWith(e.run.run_id + ":")) announced.delete(key);
            }
          }
          // Health numerator feed — before display filtering: capture
          // stays global, and so does the health view of activity.
          if (e.type === "run:updated" && synced && cwdOverlapsRoot(e.run.cwd, filesRoot)) {
            const now = Date.now();
            for (const s of e.new_steps) {
              if (s.sequence >= RESERVED_SEQUENCE_BASE) continue;
              if (isFileTouching(s)) touchRing.push({ t: now, write: isWriteTool(s) });
            }
            // Bounded: drop entries older than the window.
            while (touchRing.length > 0 && now - touchRing[0]!.t > HEALTH_NUMERATOR_WINDOW_MS) {
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
            printStepFileDelta(store, e, announced, synced, providerByRun.get(e.run_id), sentinelPrinted);
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

        // ── File side-effect capture (root pre-validated above) ────
        // Starts BEFORE the ingest backfill (red-team finding): the
        // sentinel needs only the store, and starting it after a
        // minutes-long cold backfill left every side effect in that
        // window silently uncaptured while the header claimed capture.
        if (runsSentinel) {
          sentinel = new FileSentinel(store, {
            root: filesRoot,
            attributionWindowMs: opts.attributionWindow * 1000,
          });
          sentinel.on("data", (e: FileSentinelEvent) => {
            if (e.type === "file:captured") {
              sentinelPrinted.add(e.change.file_change_id);
              if (sentinelPrinted.size > 10_000) sentinelPrinted.clear();
            }
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
            if (claimRefresher) clearInterval(claimRefresher);
            claimRefresher = undefined;
            // Release the startup claim (codex adversarial P1): a
            // fresh heartbeat with no sentinel behind it would block
            // other instances from capturing for up to 2 minutes.
            try {
              clearLiveHeartbeat(store, filesRoot);
            } catch {
              // staleness self-expires
            }
          }
        }

        await live.start();

        // ── Heartbeat + capture-health evaluator (design §4) ───────
        let lastVerdict: HealthVerdict = "healthy";
        let lastDegradedPrint = 0;
        let lastLossCount = 0;
        let orphanWarned = false;
        const startedAt = Date.now();
        evaluator = setInterval(() => {
          // Ownership re-check (adversarial 4): if a simultaneous
          // start won the last write, exactly one of the racers sees a
          // foreign owner here and downgrades to viewer — ending the
          // duplicate-capture overlap within one tick.
          if (sentinel) {
            try {
              const owner = liveClaimOwner(store, filesRoot);
              if (owner !== undefined && owner !== ownerId) {
                sentinel.stop();
                sentinel = undefined;
                if (claimRefresher) clearInterval(claimRefresher);
                claimRefresher = undefined;
                viewerOnly = true;
                if (!opts.json) {
                  console.log(
                    pc.yellow(
                      timeHead() +
                        "another meter live instance took capture on this root — downgrading to viewer",
                    ),
                  );
                }
              }
            } catch {
              // unreadable store — re-check next tick
            }
          }
          // Viewer orphan detection (red-team finding): viewerOnly was
          // decided once at startup — if the capture holder exits or
          // crashes, the surviving viewer would otherwise sit sentinel-
          // less forever with zero signal while NOTHING captures.
          if (viewerOnly && !sentinel) {
            let holderGone = false;
            try {
              holderGone = !liveCaptureHeldFor(store, filesRoot);
            } catch {
              // unreadable store — leave state as-is this tick
            }
            if (!holderGone) orphanWarned = false; // new holder → re-arm
            if (holderGone && !orphanWarned) {
              orphanWarned = true;
              if (!opts.json) {
                console.log(
                  pc.yellow(
                    timeHead() +
                      "capture holder gone — NO file capture on this root; restart meter live (or --force-capture) to take over",
                  ),
                );
              }
            }
            if (opts.json) {
              emitJson({
                type: "capture:health",
                mode: holderGone ? "viewer-orphaned" : "viewer-only",
                file_touching_steps_recent: touchRing.length,
                degraded: holderGone,
              });
              return;
            }
            return;
          }
          if (!synced) return; // no verdicts on partial data (T3)
          // Prune here too: the ring is otherwise only trimmed on
          // run:updated, so reported counts went stale after activity
          // stopped (adversarial 7).
          const nowTick = Date.now();
          while (touchRing.length > 0 && nowTick - touchRing[0]!.t > HEALTH_NUMERATOR_WINDOW_MS) {
            touchRing.shift();
          }
          const h = sentinel?.health();
          if (opts.json) {
            emitJson({
              type: "capture:health",
              mode: sentinel ? "capturing" : viewerOnly ? "viewer-only" : "no-files",
              fs_event_age_ms: h === undefined ? undefined : rawEventAgeMs(h, startedAt),
              ingest_lag_ms:
                lastIngestAt === undefined ? undefined : Date.now() - lastIngestAt,
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
    ? `starting — hooks (exact, where installed) + sentinel fallback on ${filesRoot} (live once 'watching files under …' prints; minus .meterbilityignore/.gitignore + defaults)`
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
    // MAX(sequence) query, not a full listSteps materialization — a
    // thousand-step run costs one indexed aggregate here, not a scan.
    const current = maxMainBandSequence(store, r.run_id);
    // v0.6 provider identity (schema v6): proxy-captured runs speak
    // their provider, never a generic "proxy".
    const providerTag = r.provider
      ? pc.magenta(
          `[${sanitizeTerminal(r.provider)}${r.upstream_host ? ` ${sanitizeTerminal(r.upstream_host)}` : ""}] `,
        )
      : "";
    console.log(
      "  " +
        pc.cyan(r.run_id.slice(0, 12)) +
        `  ${providerTag}` +
        pc.dim(`${r.source_runtime} · step ${current}`) +
        (r.title ? `  ${sanitizeTerminal(r.title)}` : ""),
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
  providerTag?: string,
  alreadyPrinted?: Set<string>,
): void {
  const rows = listFileChanges(store, { stepId: e.step_id });
  // Keys are run-scoped so run:completed can evict a finished run's
  // bookkeeping without a second index.
  const key = `${e.run_id}:${e.step_id}`;
  const seen = announced.get(key) ?? 0;
  const fresh = rows.slice(seen);
  announced.set(key, rows.length);
  if (fresh.length === 0) return;
  const update = seen > 0;
  const syncPrefix = synced ? "" : pc.dim("[sync] ");
  for (const fc of fresh) {
    // Rows this process already printed live as file:captured sentinel
    // events would otherwise print a second time here (adversarial 16).
    if (alreadyPrinted?.has(fc.file_change_id)) continue;
    console.log(syncPrefix + formatFileRow(e, fc, update, providerTag));
  }
}

function formatFileRow(
  e: Extract<LiveEvent, { type: "files:changed" }>,
  fc: FileChange,
  update: boolean,
  providerTag?: string,
): string {
  const tool = fc.source_tool_name ?? (fc.derived_from === "filesystem_watch" ? "fs" : "tool");
  const stat = fc.partial_diff
    ? pc.yellow("(partial)")
    : pc.dim(lineStat(fc));
  const coalesced = (fc.normalizer_notes as { coalesced_events?: number } | undefined)
    ?.coalesced_events;
  return (
    timeHead() +
    pc.bold(`step ${e.sequence}`) +
    (update ? pc.dim(" (update)") : "") +
    ` · ${pc.cyan(e.run_id.slice(0, 12))} · ` +
    (providerTag ? pc.magenta(`[${sanitizeTerminal(providerTag)}] `) : "") +
    `${sanitizeTerminal(tool)} ${opBadge(fc.op)} ${sanitizeTerminal(fc.path)} ` +
    stat +
    (coalesced ? pc.dim(` · net of ${coalesced} events`) : "")
  );
}

// ─── Capture health (design §4, investigation-validated) ─────────────

/** Age of the newest raw filesystem event, anchored to ready/start
 *  when no event has arrived yet — the ONE anchoring rule shared by
 *  the pretty verdict and the JSON event (review: no dual anchors). */
export function rawEventAgeMs(h: SentinelHealth, startedAt: number): number {
  return Date.now() - (h.last_raw_event_at ?? h.ready_at ?? startedAt);
}

export function evaluateHealth(
  h: SentinelHealth,
  touchRing: TouchEntry[],
  startedAt: number,
): HealthVerdict {
  const now = Date.now();
  const recent = touchRing.filter((e) => now - e.t <= HEALTH_NUMERATOR_WINDOW_MS);
  if (recent.length === 0) return "healthy"; // idle repo is healthy, not degraded
  const definiteWrites = recent.some((e) => e.write);
  const rawAge = rawEventAgeMs(h, startedAt);
  // Startup grace: FSEvents streams come live asynchronously (2s–15s+
  // under load). No degraded verdict until the stream has proven
  // itself once, or the grace period after ready has elapsed.
  const graceElapsed =
    h.raw_event_count > 0 || now - (h.ready_at ?? startedAt) > STARTUP_GRACE_MS;
  // Degraded needs DEFINITE write evidence; shell-only activity caps
  // at warn (see WRITE_TOOLS/SHELL_TOOLS).
  if (rawAge > HEALTH_DEGRADED_MS && graceElapsed && definiteWrites) return "degraded";
  if (rawAge > HEALTH_WARN_MS) return "warn";
  return "healthy";
}

export function printHealthLine(
  verdict: HealthVerdict,
  h: SentinelHealth,
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

/** Eng review 1A: sourced from step ACTIONS (always present in ingest)
 *  — never from filesystem_watch rows, which come from the plane this
 *  check exists to verify. */
export function isFileTouching(s: Step): boolean {
  return (
    s.action.kind === "tool_call" &&
    s.action.tool_name !== undefined &&
    (WRITE_TOOLS.has(s.action.tool_name) || SHELL_TOOLS.has(s.action.tool_name))
  );
}

/** True when the step's tool DEFINITELY writes files. */
export function isWriteTool(s: Step): boolean {
  return (
    s.action.kind === "tool_call" &&
    s.action.tool_name !== undefined &&
    WRITE_TOOLS.has(s.action.tool_name)
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
