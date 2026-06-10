import { Command } from "commander";
import pc from "picocolors";
import {
  getRun,
  listRuns,
  setRunStatus,
  updateRunTotals,
} from "@spool-ai/collector";
import { openStore } from "../util.ts";

/**
 * `spool runs <subcommand>` — run-management ops.
 *
 * Today this hosts `close` for sealing in-progress runs. Proxy-captured
 * runs (and any tracer that exited without calling `tracer.end()`) hang
 * around with status="in_progress" forever because nothing else upstream
 * can know when a Run is "done." `runs close` is the manual escape hatch.
 *
 * Future homes for this namespace: `runs delete`, `runs rename`,
 * `runs tag`, `runs export-batch`, etc.
 */
export function registerRunsCommand(program: Command): void {
  const runs = program.command("runs").description("Run-management operations");

  runs
    .command("close [id]")
    .description("Mark an in-progress run as completed (seals status + ended_at)")
    .option(
      "--status <kind>",
      "Final status to set (ok|error|abandoned)",
      "ok",
    )
    .option(
      "--all",
      "Close every in_progress run (use --older-than to scope by age)",
    )
    .option(
      "--older-than <minutes>",
      "Only close runs whose last activity is older than N minutes",
      (v) => parseInt(v, 10),
    )
    .option("--source <runtime>", "Restrict --all to one source_runtime (e.g. proxy)")
    .option("--dry-run", "Print what would close without writing")
    .action(
      (
        id: string | undefined,
        opts: {
          status: string;
          all?: boolean;
          olderThan?: number;
          source?: string;
          dryRun?: boolean;
        },
      ) => {
        if (!id && !opts.all) {
          console.error(
            pc.red(
              "spool runs close: provide a run id, or pass --all to close every in_progress run.",
            ),
          );
          process.exit(2);
        }
        if (!isValidStatus(opts.status)) {
          console.error(
            pc.red(`invalid --status: ${opts.status}. allowed: ok | error | abandoned`),
          );
          process.exit(2);
        }
        const finalStatus = opts.status as "ok" | "error" | "abandoned";

        const store = openStore();
        try {
          const targets = id
            ? singleTarget(store, id)
            : bulkTargets(store, opts);
          if (targets.length === 0) {
            console.log(pc.dim("no runs to close"));
            return;
          }
          const now = new Date().toISOString();
          for (const run of targets) {
            if (opts.dryRun) {
              console.log(
                `${pc.yellow("would close")} ${pc.cyan(run.run_id.slice(0, 12))}  ${pc.dim(`(${run.status} → ${finalStatus})`)}  ${pc.dim(run.title ?? "")}`,
              );
              continue;
            }
            setRunStatus(store, run.run_id, finalStatus, now);
            // Recompute totals — proxy steps land asynchronously, and a
            // close call after the dust has settled is a good time to
            // make sure step_count / cost reflect everything written.
            updateRunTotals(store, run.run_id);
            console.log(
              `${pc.green("closed")}  ${pc.cyan(run.run_id.slice(0, 12))}  ${pc.dim(`${run.status} → ${finalStatus}`)}  ${pc.dim(run.title ?? "")}`,
            );
          }
          if (!opts.dryRun && targets.length > 1) {
            console.log(pc.bold(`\n${targets.length} run(s) closed`));
          }
        } finally {
          store.close();
        }
      },
    );
}

function singleTarget(
  store: import("@spool-ai/collector").Store,
  id: string,
): Array<import("@spool-ai/shared").Run> {
  const run = getRun(store, id);
  if (!run) {
    console.error(pc.red(`run not found: ${id}`));
    process.exit(1);
  }
  if (run.status !== "in_progress") {
    console.log(
      pc.dim(
        `${run.run_id.slice(0, 12)} already ${run.status} — nothing to close. (Pass any explicit --status to override.)`,
      ),
    );
    process.exit(0);
  }
  return [run];
}

function bulkTargets(
  store: import("@spool-ai/collector").Store,
  opts: { olderThan?: number; source?: string },
): Array<import("@spool-ai/shared").Run> {
  const all = listRuns(store, { limit: 1000 });
  const cutoffMs = opts.olderThan
    ? Date.now() - opts.olderThan * 60_000
    : undefined;
  return all.filter((run) => {
    if (run.status !== "in_progress") return false;
    if (opts.source && run.source_runtime !== opts.source) return false;
    if (cutoffMs !== undefined) {
      const startedMs = Date.parse(run.started_at);
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) return false;
    }
    return true;
  });
}

function isValidStatus(s: string): boolean {
  return s === "ok" || s === "error" || s === "abandoned";
}
