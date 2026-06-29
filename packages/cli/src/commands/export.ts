import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import {
  getBaselineTree,
  getRun,
  getSetting,
  listFileChanges,
  listSteps,
  resolveSnapshotBlobRef,
} from "@meterbility/collector";
import { TRACE_FORMAT_VERSION } from "@meterbility/spec";
import { openStore } from "../util.ts";

/**
 * Export a run to the canonical Meterbility Trace Format JSON file (v0.3.0).
 *
 * This is how Meterbility talks to other tools and the open spec — one
 * self-contained document with the run, every step, every FileChange,
 * the baseline tree (if any), and every referenced blob inlined
 * (base64-encoded UTF-8 for safe round-tripping).
 *
 * Per SPEC-V0_3 §10.4: file *content* blobs are excluded by default
 * because bug reports get shared. Pass `--include-file-blobs` to
 * include the actual file bytes. The baseline tree's *manifest* blob
 * is always included — it's a structured index, not content. Patch
 * text on each FileChange is also always included (it's already
 * routed through the redaction pass).
 *
 * Setting fallback chain (per SPEC-V0_3 §7.3): the
 * `export.include_file_blobs` setting flips the default if the flag
 * isn't passed explicitly.
 */
export function registerExportCommand(program: Command): void {
  program
    .command("export <run-id>")
    .description("Export a run to the open Meterbility Trace Format (0.3.0)")
    .option("-o, --output <path>", "Output file (default: stdout)")
    .option(
      "--no-blobs",
      "Skip inlining blob contents (refs only — much smaller)",
    )
    .option(
      "--include-file-blobs",
      "Inline file-content blobs in the export (default: omit — bug reports get shared)",
    )
    .action(async (
      runId: string,
      opts: { output?: string; blobs: boolean; includeFileBlobs?: boolean },
    ) => {
      const store = openStore();
      try {
        const run = getRun(store, runId);
        if (!run) throw new Error(`run not found: ${runId}`);
        const steps = listSteps(store, run.run_id);
        const file_changes = listFileChanges(store, { runId: run.run_id });
        // Resolve the baseline_tree row if the run has one. Single
        // row per run; legacy + non-coding runs have none.
        const baseline_trees = run.baseline_tree_id
          ? [getBaselineTree(store, run.baseline_tree_id)].filter(
              (bt): bt is NonNullable<typeof bt> => !!bt,
            )
          : [];
        const trace: Record<string, unknown> = {
          meter_trace_version: TRACE_FORMAT_VERSION,
          run,
          steps,
          file_changes,
          baseline_trees,
        };

        if (opts.blobs !== false) {
          // Settings fallback: explicit flag wins; otherwise the
          // export.include_file_blobs setting decides; otherwise false.
          const includeFileBlobs =
            opts.includeFileBlobs ??
            (getSetting(store, "export.include_file_blobs") === "true");

          const blobs: Record<string, string> = {};
          const fileBlobRefs = new Set<string>();
          // File content blob refs go in a separate set so we can gate
          // their inlining on --include-file-blobs without losing
          // structural blobs (context snapshots, decisions, tool
          // results, baseline manifests).
          for (const fc of file_changes) {
            if (fc.before_blob_ref) fileBlobRefs.add(fc.before_blob_ref);
            if (fc.after_blob_ref) fileBlobRefs.add(fc.after_blob_ref);
          }

          const structuralRefs = new Set<string>();
          for (const s of steps) {
            // Translate snapshot id → blob ref so consumers can verify
            // the SHA matches the bytes.
            structuralRefs.add(
              resolveSnapshotBlobRef(store, s.context_snapshot_id),
            );
            structuralRefs.add(s.decision_ref);
            if (s.outcome.tool_result_ref) {
              structuralRefs.add(s.outcome.tool_result_ref);
            }
          }
          // Baseline manifest blobs are always included — they're
          // structured indexes (path/mode/blob_ref tuples), not
          // redactable content. Per SPEC-V0_3 §12.
          for (const bt of baseline_trees) {
            if (bt.manifest_blob_ref) {
              structuralRefs.add(bt.manifest_blob_ref);
            }
          }

          const refsToInline = new Set<string>(structuralRefs);
          if (includeFileBlobs) {
            for (const r of fileBlobRefs) refsToInline.add(r);
          }

          for (const r of refsToInline) {
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
            `${pc.green("exported")}  ${runId.slice(0, 12)} → ${opts.output}  ${pc.dim(`(${(json.length / 1024).toFixed(1)}KB · ${file_changes.length} file changes)`)}`,
          );
        } else {
          process.stdout.write(json + "\n");
        }
      } finally {
        store.close();
      }
    });
}
