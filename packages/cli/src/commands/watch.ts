import { statSync } from "node:fs";
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
  liveCaptureHeldFor,
  writeLiveHeartbeat,
  clearLiveHeartbeat,
} from "@meterbility/collector";
import { openStore } from "../util.ts";
import { printPretty, printFileEvent } from "../render_events.ts";

/**
 * `meter watch` — terminal counterpart to the web UI's live SSE stream.
 *
 * The web UI lets you keep a browser tab open on the fleet view and watch
 * runs scroll past with alerts highlighted. `watch` does the same for
 * terminal users: tails ~/.claude/projects, prints a one-line entry per
 * event (or full JSON with --json), and stays alive until ctrl-c.
 *
 * Filters mirror the same flags `meter web --live` accepts (--watch-tool,
 * --stall-seconds), and like web, missing flags fall back to the
 * `live.watch_tools` / `live.stall_seconds` settings table values.
 *
 * v0.4 — `--files` additionally starts the FileSentinel (SPEC §3.1.3
 * fallback capture): OS-level filesystem events from the watched
 * directory become `derived_from='filesystem_watch'` FileChange rows,
 * attributed by temporal proximity to the freshest in-progress run.
 * This is what captures Bash side effects (`sed`, `mv`, `npm install`)
 * that tool-call inspection can't see for runs Meterbility only observes
 * from the outside (Codex, Cursor, proxy). Claude Code runs get exact
 * hook-based capture instead (`meter capture`, installed by
 * `meter init --hooks`); the sentinel is the cross-vendor fallback.
 * Opt-in by design.
 */
export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description(
      "Raw live event stream from ~/.claude/projects (scripting/JSON). Humans: `meter live` is the friendlier front door",
    )
    .option(
      "--watch-tool <name>",
      "Fire an alert when this tool is invoked (repeatable)",
      (val: string, prev: string[] = []) => [...prev, val],
      [] as string[],
    )
    .option(
      "--stall-seconds <n>",
      "Stall alert threshold in seconds",
      (v) => parseInt(v, 10),
      120,
    )
    .option(
      "--filter <kinds>",
      "Comma-separated event kinds to keep (alert,run:created,run:updated,run:completed,fleet:snapshot)",
    )
    .option("--run <id>", "Filter to a single run id (or its 12-char prefix)")
    .option(
      "--no-snapshot",
      "Suppress the periodic fleet:snapshot events (they're noisy)",
    )
    .option("--json", "Emit each event as one JSON line (newline-delimited)")
    .option(
      "--files",
      "Also capture agent file side effects: recursively watches EVERY file under the current directory (minus .meterbilityignore/.gitignore) — no per-file selection needed",
    )
    .option(
      "--files-dir <path>",
      "Watch this directory tree instead of the current directory (--files)",
    )
    .option(
      "--attribution-window <n>",
      "Max seconds between a step and a file event for attribution (--files)",
      (v) => parseInt(v, 10),
      120,
    )
    .action(
      async (opts: {
        watchTool: string[];
        stallSeconds: number;
        filter?: string;
        run?: string;
        snapshot: boolean;
        json?: boolean;
        files?: boolean;
        filesDir?: string;
        attributionWindow: number;
      }) => {
        const store = openStore();
        // Settings fallback (parity with `meter web`).
        const watchToolsEffective =
          opts.watchTool.length > 0
            ? opts.watchTool
            : (getSetting(store, "live.watch_tools") ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        const stallFromSetting = getSetting(store, "live.stall_seconds");
        const stallSecondsEffective =
          opts.stallSeconds !== 120
            ? opts.stallSeconds
            : stallFromSetting
              ? parseInt(stallFromSetting, 10) || opts.stallSeconds
              : opts.stallSeconds;

        const allowedKinds = opts.filter
          ? new Set(
              opts.filter
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          : null;
        const runFilter = opts.run;
        const matchesRun = (id: string): boolean => {
          if (!runFilter) return true;
          return id === runFilter || id.startsWith(runFilter);
        };

        const live = new LiveInspector(store, {
          watchTools: watchToolsEffective,
          stallSeconds: stallSecondsEffective,
        });

        if (!opts.json) {
          console.log(
            pc.dim(
              `watching ~/.claude/projects · tools=${watchToolsEffective.join(",") || "(none)"} · stall=${stallSecondsEffective}s` +
                (runFilter ? ` · run=${runFilter}` : "") +
                (allowedKinds ? ` · filter=${[...allowedKinds].join(",")}` : "") +
                "\n" +
                "press ctrl-c to stop",
            ),
          );
        }

        live.on("data", (e: LiveEvent) => {
          if (allowedKinds && !allowedKinds.has(e.type)) return;
          if (e.type === "fleet:snapshot" && opts.snapshot === false) return;
          // run-id filter (only meaningful for run-scoped events)
          if (
            runFilter &&
            (e.type === "run:created" ||
              e.type === "run:updated" ||
              e.type === "run:completed") &&
            !matchesRun(e.run.run_id)
          ) {
            return;
          }
          if (
            runFilter &&
            e.type === "alert" &&
            !matchesRun(e.run_id)
          ) {
            return;
          }
          if (opts.json) {
            process.stdout.write(JSON.stringify(e) + "\n");
            return;
          }
          printPretty(e);
        });

        await live.start();

        // v0.4 — opt-in filesystem side-effect capture. Runs alongside
        // the live inspector in the same process: the inspector keeps
        // runs/steps fresh via incremental ingest, the sentinel attributes
        // filesystem events against them.
        //
        // One-sentinel-per-root guard (red-team finding): watch --files
        // participates in the same live.heartbeat protocol meter live
        // uses — two sentinels on one root double-capture every event
        // into duplicate rows, and the attach nudge would otherwise
        // steer a watch --files user straight into that collision.
        let sentinel: FileSentinel | undefined;
        let heartbeat: NodeJS.Timeout | undefined;
        let watchRoot: string | undefined;
        if (opts.files) {
          watchRoot = resolve(opts.filesDir ?? process.cwd());
          if (liveCaptureHeldFor(store, watchRoot)) {
            console.error(
              pc.yellow(
                `meter watch: another instance already holds file capture on ${watchRoot} — skipping a duplicate sentinel (rows would double). \`meter live\` attaches as a viewer.`,
              ),
            );
            opts.files = false;
          }
        }
        if (opts.files) {
          // Validate up front and guard start(): fs.watch throws
          // synchronously on a bad root, which would otherwise kill
          // the whole watch session (live stream included) with an
          // unhandled rejection mid-stream.
          const filesRoot = resolve(opts.filesDir ?? process.cwd());
          let rootOk = false;
          try {
            rootOk = statSync(filesRoot).isDirectory();
          } catch {
            rootOk = false; // missing or vanished — same answer
          }
          if (!rootOk) {
            console.error(
              pc.red(
                `meter watch: --files-dir is not a directory: ${filesRoot} — continuing without file capture`,
              ),
            );
          } else {
            sentinel = new FileSentinel(store, {
              root: filesRoot,
              attributionWindowMs: opts.attributionWindow * 1000,
            });
            sentinel.on("data", (e: FileSentinelEvent) => {
              if (opts.json) {
                process.stdout.write(JSON.stringify(e) + "\n");
                return;
              }
              printFileEvent(e);
            });
            // Claim BEFORE start(): prime() walks the whole tree and
            // can take minutes on a big repo — an unclaimed prime
            // window let a concurrent instance start a second sentinel
            // and double-capture every event (adversarial 2). The
            // claim write sits OUTSIDE the start try so a transient
            // SQLITE_BUSY can't be misreported as a capture failure
            // that tears down a healthy sentinel (adversarial 5b).
            try {
              writeLiveHeartbeat(store, watchRoot!);
            } catch {
              // best-effort — refresher below re-writes
            }
            heartbeat = setInterval(() => {
              try {
                writeLiveHeartbeat(store, watchRoot!);
              } catch {
                // best-effort — staleness self-expires
              }
            }, 5_000);
            heartbeat.unref?.();
            try {
              await sentinel.start();
            } catch (err) {
              console.error(
                pc.red(
                  `meter watch: file capture failed to start (${String(err)}) — continuing without it`,
                ),
              );
              sentinel.stop();
              sentinel = undefined;
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = undefined;
              try {
                clearLiveHeartbeat(store, watchRoot!);
              } catch {
                // staleness self-expires
              }
            }
          }
        }

        // Keep alive — LiveInspector polls in the background.
        const stop = (): void => {
          live.stop();
          if (heartbeat) clearInterval(heartbeat);
          sentinel?.stop();
          if (heartbeat && watchRoot) {
            try {
              clearLiveHeartbeat(store, watchRoot);
            } catch {
              // best-effort — staleness self-expires
            }
          }
          try {
            store.close();
          } catch {
            // already closed — exiting regardless
          }
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      },
    );
}
