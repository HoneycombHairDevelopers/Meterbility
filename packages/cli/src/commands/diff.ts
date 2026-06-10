import { Command } from "commander";
import pc from "picocolors";
import { getRun } from "@spool-ai/collector";
import { diffRuns, type DiffResult } from "@spool-ai/server";
import { openStore } from "../util.ts";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff <run-a> <run-b>")
    .description("Side-by-side trajectory diff of two runs")
    .option("--json", "Emit machine-readable JSON")
    .option("--all", "Include shared rows (default: only diff rows)")
    .action((runA: string, runB: string, opts: { json?: boolean; all?: boolean }) => {
      const store = openStore();
      try {
        const a = getRun(store, runA);
        const b = getRun(store, runB);
        if (!a) throw new Error(`run not found: ${runA}`);
        if (!b) throw new Error(`run not found: ${runB}`);
        const result = diffRuns(store, a.run_id, b.run_id);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printDiff(result, opts.all ?? false);
      } finally {
        store.close();
      }
    });
}

function printDiff(d: DiffResult, includeShared: boolean): void {
  console.log(pc.bold(`Diff: ${d.run_a_id.slice(0, 12)} vs ${d.run_b_id.slice(0, 12)}`));
  console.log(
    `  ${pc.dim("shared prefix")}   ${d.shared_prefix_length} step(s)\n` +
      `  ${pc.dim("divergence at")}   ${d.first_divergence_sequence ?? "—"}\n` +
      `  ${pc.dim("total A / B")}    ${d.total_steps_a} / ${d.total_steps_b}`,
  );
  console.log("");
  for (const row of d.rows) {
    if (!includeShared && row.kind === "shared") continue;
    const color = pickColor(row.kind);
    const a =
      row.a
        ? `${row.a.action_kind}${row.a.tool_name ? `(${row.a.tool_name})` : ""} · ${row.a.outcome_status}`
        : "—";
    const b =
      row.b
        ? `${row.b.action_kind}${row.b.tool_name ? `(${row.b.tool_name})` : ""} · ${row.b.outcome_status}`
        : "—";
    console.log(
      `  ${String(row.sequence).padStart(4)}  ${color(row.kind.padEnd(14))}  ${a.padEnd(34)}  ${pc.dim("│")}  ${b}`,
    );
  }
}

function pickColor(kind: string): (s: string) => string {
  switch (kind) {
    case "shared":
      return pc.dim;
    case "context_diff":
      return pc.yellow;
    case "decision_diff":
      return pc.cyan;
    case "action_diff":
      return pc.red;
    case "outcome_diff":
      return pc.magenta;
    case "only_a":
      return pc.red;
    case "only_b":
      return pc.green;
    case "diverged":
      return pc.magenta;
    default:
      return (s) => s;
  }
}
