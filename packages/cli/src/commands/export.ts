import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import { getRun, listSteps, resolveSnapshotBlobRef } from "@spool/collector";
import { TRACE_FORMAT_VERSION } from "@spool/spec";
import { openStore } from "../util.ts";

/**
 * Export a run to the canonical Spool Trace Format JSON file. This is
 * how Spool talks to other tools and the open spec — one self-contained
 * document with the run, every step, and every referenced blob inlined
 * (base64-encoded UTF-8 for safe roundtripping).
 */
export function registerExportCommand(program: Command): void {
  program
    .command("export <run-id>")
    .description("Export a run to the open Spool Trace Format")
    .option("-o, --output <path>", "Output file (default: stdout)")
    .option(
      "--no-blobs",
      "Skip inlining blob contents (refs only — much smaller)",
    )
    .action(async (
      runId: string,
      opts: { output?: string; blobs: boolean },
    ) => {
      const store = openStore();
      try {
        const run = getRun(store, runId);
        if (!run) throw new Error(`run not found: ${runId}`);
        const steps = listSteps(store, run.run_id);
        const trace: Record<string, unknown> = {
          spool_trace_version: TRACE_FORMAT_VERSION,
          run,
          steps,
        };
        if (opts.blobs !== false) {
          const blobs: Record<string, string> = {};
          const refs = new Set<string>();
          for (const s of steps) {
            // Translate snapshot id → blob ref so consumers can verify
            // the SHA matches the bytes.
            refs.add(resolveSnapshotBlobRef(store, s.context_snapshot_id));
            refs.add(s.decision_ref);
            if (s.outcome.tool_result_ref) refs.add(s.outcome.tool_result_ref);
          }
          for (const r of refs) {
            const text = await store.blobs.tryGetString(r);
            if (text !== undefined) {
              blobs[r] = Buffer.from(text, "utf-8").toString("base64");
            }
          }
          trace.blobs = blobs;
        }
        const json = JSON.stringify(trace, null, 2);
        if (opts.output) {
          await writeFile(opts.output, json);
          console.log(
            `${pc.green("exported")}  ${runId.slice(0, 12)} → ${opts.output}  ${pc.dim(`(${(json.length / 1024).toFixed(1)}KB)`)}`,
          );
        } else {
          process.stdout.write(json + "\n");
        }
      } finally {
        store.close();
      }
    });
}
