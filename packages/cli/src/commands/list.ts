import { Command } from "commander";
import pc from "picocolors";
import { getChildRuns, listRuns } from "@meterbility/collector";
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
              "no runs found. Try: meter ingest claude-code --limit 1",
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
        for (const r of runs) {
          console.log(runSummaryLine(r));
          // v8 — carved agent runs nest under their parent with a
          // display-time fleet rollup (never stored).
          const children = getChildRuns(store, r.run_id);
          if (children.length > 0) {
            for (const ch of children) {
              console.log(`  ${pc.dim("↳")} ${runSummaryLine(ch)}`);
            }
            const fleetCents =
              r.cost_cents +
              children.reduce((acc, ch) => acc + ch.cost_cents, 0);
            console.log(
              pc.dim(
                `    fleet: ${children.length} agent(s) · ${fmtCents(fleetCents)}`,
              ),
            );
          }
        }
      } finally {
        store.close();
      }
    });
}
