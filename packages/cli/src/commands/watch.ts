import { Command } from "commander";
import pc from "picocolors";
import {
  LiveInspector,
  type LiveEvent,
  type FleetEntry,
} from "@meterbility/server";
import { getSetting } from "@meterbility/collector";
import { openStore } from "../util.ts";

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
 */
export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description(
      "Stream live agent activity from ~/.claude/projects to the terminal",
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
    .action(
      async (opts: {
        watchTool: string[];
        stallSeconds: number;
        filter?: string;
        run?: string;
        snapshot: boolean;
        json?: boolean;
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

        // Keep alive — LiveInspector polls in the background.
        const stop = (): void => {
          live.stop();
          store.close();
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      },
    );
}

function printPretty(e: LiveEvent): void {
  const ts = new Date().toISOString().slice(11, 19);
  const head = pc.dim(ts) + "  ";
  switch (e.type) {
    case "run:created":
      console.log(
        head +
          pc.blue("run:created  ") +
          pc.cyan(e.run.run_id.slice(0, 12)) +
          (e.run.title ? "  " + e.run.title : ""),
      );
      return;
    case "run:updated":
      console.log(
        head +
          pc.dim("run:updated  ") +
          pc.cyan(e.run.run_id.slice(0, 12)) +
          pc.dim(`  +${e.new_steps.length} step${e.new_steps.length === 1 ? "" : "s"}`),
      );
      return;
    case "run:completed":
      console.log(
        head +
          pc.green("run:completed") +
          "  " +
          pc.cyan(e.run.run_id.slice(0, 12)) +
          pc.dim(`  status=${e.run.status}`),
      );
      return;
    case "alert":
      console.log(
        head +
          pc.yellow(`alert[${e.kind}] `) +
          pc.cyan(e.run_id.slice(0, 12)) +
          "  " +
          e.message,
      );
      return;
    case "fleet:snapshot": {
      const counts = e.entries.reduce<Record<string, number>>((acc, x: FleetEntry) => {
        acc[x.status] = (acc[x.status] ?? 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log(
        head + pc.dim(`fleet:snapshot ${e.entries.length} runs · ${summary}`),
      );
      return;
    }
  }
}
