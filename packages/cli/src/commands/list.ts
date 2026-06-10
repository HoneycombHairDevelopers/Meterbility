import { Command } from "commander";
import pc from "picocolors";
import { listRuns } from "@spool-ai/collector";
import { fmtCents, openStore, runSummaryLine, statusColor } from "../util.ts";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("List recent runs")
    .option("-n, --limit <n>", "max rows", (v) => parseInt(v, 10), 30)
    .option("--status <s>", "filter by status (ok|error|in_progress|abandoned)")
    .option("--tool <name>", "filter to runs containing a tool call by name")
    .action(async (opts: { limit: number; status?: string; tool?: string }) => {
      const store = openStore();
      try {
        const runs = listRuns(store, {
          limit: opts.limit,
          status: opts.status as
            | "ok"
            | "error"
            | "in_progress"
            | "abandoned"
            | undefined,
          containsTool: opts.tool,
        });
        if (runs.length === 0) {
          console.log(
            pc.dim(
              "no runs found. Try: spool ingest claude-code --limit 1",
            ),
          );
          return;
        }
        console.log(
          pc.bold(
            "RUN".padEnd(12) +
              "  STATUS       STEPS  COST       BRANCH            TITLE",
          ),
        );
        for (const r of runs) console.log(runSummaryLine(r));
      } finally {
        store.close();
      }
    });
}
