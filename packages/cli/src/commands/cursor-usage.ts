import type { Command } from "commander";
import pc from "picocolors";
import { pullCursorUsage } from "@meterbility/cursor-adapter";
import { openStore } from "../util.ts";

/**
 * `meter cursor-usage` — pull billed usage from the Cursor Admin API
 * (Teams/Business) and join it to locally-ingested Cursor runs via
 * conversationId. This is the only source of real cost/cache numbers
 * for Cursor: the local DB never persists them.
 *
 * Setup: meter config set cursor.admin_api_key <team-scoped key>
 */
export function registerCursorUsageCommand(program: Command): void {
  program
    .command("cursor-usage")
    .description(
      "Pull billed token usage from the Cursor Admin API and attach it to Cursor runs (requires cursor.admin_api_key)",
    )
    .option("--days <n>", "How many days back to pull (default 7)", "7")
    .option("--json", "Print the pull summary as JSON")
    .action(async (opts: { days: string; json?: boolean }) => {
      const days = Number(opts.days);
      if (!Number.isFinite(days) || days <= 0) {
        console.error(pc.red(`meter cursor-usage: invalid --days "${opts.days}"`));
        process.exitCode = 2;
        return;
      }
      const store = openStore();
      try {
        const result = await pullCursorUsage(store, {
          startDateMs: Date.now() - days * 24 * 60 * 60 * 1000,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + "\n");
          if (result.status !== "ok") process.exitCode = 1;
          return;
        }
        if (result.status === "no_api_key") {
          console.error(pc.yellow(result.reason!));
          process.exitCode = 1;
          return;
        }
        if (result.status === "http_error") {
          console.error(pc.red(`meter cursor-usage: ${result.reason}`));
          process.exitCode = 1;
          return;
        }
        console.log(
          `${pc.green("✓")} ${result.events_seen} events → ${result.events_applied} applied, ` +
            `${result.events_unmatched} unmatched, ${result.events_skipped} skipped · ` +
            `${result.runs_updated} run(s) now carry ${pc.cyan("cost:actual")}`,
        );
        if (result.events_unmatched > 0) {
          console.log(
            pc.dim(
              "  unmatched events belong to conversations not yet ingested — run `meter ingest cursor` first for full joins",
            ),
          );
        }
      } finally {
        store.close();
      }
    });
}
