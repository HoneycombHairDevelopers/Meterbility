import { Command } from "commander";
import pc from "picocolors";
import {
  getBaselineTree,
  getRun,
  getStep,
  getStepBySequence,
  listFileChanges,
  listSteps,
} from "@meterbility/collector";
import type { FileChange, FileOp, Run, Step } from "@meterbility/shared";
import {
  RESERVED_SEQUENCE_BASE,
  ADMIN_SEQUENCE_BASE,
  CHECKPOINT_SEQUENCE_BASE,
} from "@meterbility/shared";
import { openStore } from "../util.ts";

/**
 * v0.3 Track A — `meter files <run-id>`.
 *
 * The CLI surface for the file-capture data (SPEC §7.1). Four shapes:
 *
 *   1. `meter files <run-id>`
 *      Default: a git-status-style cumulative summary across the whole
 *      run. One row per unique path, terminal op (A/M/D/R), `+N −M`
 *      stats, footer with totals + baseline metadata. Matches the
 *      example output in §8.1 of the spec.
 *
 *   2. `meter files <run-id> --at <step>`
 *      Same row format but scoped to the FileChanges that happened AT
 *      that step. Useful for "what did step 5 change?"
 *
 *   3. `meter files <run-id> --diff <path>`
 *      Cumulative unified diff for one path across the run. Optional
 *      `--from <step_a> --to <step_b>` restricts to a step window —
 *      handy for "what changed between step 3 and step 7 to this file?"
 *
 *   4. `--json` on any of the above — machine-readable output for
 *      scripts.
 *
 * Why these and not `--tree <step>`: the spec defers tree-manifest
 * dumps to v0.5 because there's no UI consumer in v0.3 (the
 * working-tree panel doesn't exist yet). When v0.5 lands, `--tree`
 * becomes the obvious fifth shape.
 */
export function registerFilesCommand(program: Command): void {
  program
    .command("files <run-id>")
    .description("Show file changes captured for a run (v0.3+)")
    .option(
      "--at <seq-or-step-id>",
      "Restrict to changes from a specific step (sequence number or step id)",
    )
    .option(
      "--diff <path>",
      "Print the unified diff for one path. Combine with --from/--to to scope.",
    )
    .option(
      "--from <seq-or-step-id>",
      "Lower step bound (inclusive). Without --diff: all-files range summary. Defaults to start of run.",
    )
    .option(
      "--to <seq-or-step-id>",
      "Upper step bound (inclusive). Without --diff: defaults to the latest ingested step — 'to the current step' on a live run.",
    )
    .option(
      "--main-band-only",
      "Range summary: exclude synthetic-band changes (hook/admin/checkpoint) from the window",
    )
    .option("--json", "Emit JSON instead of human-readable output")
    .action(
      async (
        runId: string,
        opts: {
          at?: string;
          diff?: string;
          from?: string;
          to?: string;
          mainBandOnly?: boolean;
          json?: boolean;
        },
      ) => {
        // --at answers "what did THIS step change"; --from/--to answers
        // "what changed across this window". Combining them has no
        // coherent meaning — error rather than pick a silent precedence
        // (eng review, meter-live design).
        if (opts.at !== undefined && (opts.from !== undefined || opts.to !== undefined)) {
          console.error(
            pc.red("--at cannot be combined with --from/--to (use one or the other)"),
          );
          process.exit(2);
        }
        const store = openStore();
        try {
          const run = getRun(store, runId);
          if (!run) {
            console.error(pc.red(`run not found: ${runId}`));
            process.exit(1);
          }

          // Dispatch to one of five shapes based on flag combinations.
          // Order matters: --diff is the most specific, then --at, then
          // the --from/--to range summary, then default summary. JSON
          // output happens inside each branch so each shape can pick
          // its own structure.
          if (opts.diff) {
            await runDiffMode(store, run, opts);
            return;
          }
          if (opts.at !== undefined) {
            await runAtMode(store, run, opts);
            return;
          }
          if (opts.from !== undefined || opts.to !== undefined) {
            await runRangeMode(store, run, opts);
            return;
          }
          await runSummaryMode(store, run, opts);
        } finally {
          store.close();
        }
      },
    );
}

// ─── Mode 1: default cumulative summary ──────────────────────────────

async function runSummaryMode(
  store: import("@meterbility/collector").Store,
  run: Run,
  opts: { json?: boolean },
): Promise<void> {
  const steps = listSteps(store, run.run_id);
  const fcs = listFileChanges(store, { runId: run.run_id });
  const collapsed = collapseByPath(fcs);
  const stats = totalStats(collapsed);
  const baseline = run.baseline_tree_id
    ? getBaselineTree(store, run.baseline_tree_id)
    : undefined;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          run_id: run.run_id,
          source_runtime: run.source_runtime,
          step_count: steps.length,
          files_touched: collapsed.length,
          lines_added_total: stats.added,
          lines_removed_total: stats.removed,
          baseline: baseline
            ? {
                baseline_tree_id: baseline.baseline_tree_id,
                git_head: baseline.git_head,
                git_dirty: baseline.git_dirty,
              }
            : undefined,
          files: collapsed.map(rowToJson),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // Pretty header.
  const sourceLabel = run.source_runtime === "fork" ? "Fork" : run.source_runtime;
  console.log(
    pc.bold(`RUN  ${run.run_id.slice(0, 12)}`) +
      pc.dim(
        `  (${sourceLabel} · ${steps.length} step${steps.length === 1 ? "" : "s"} · ${collapsed.length} file${collapsed.length === 1 ? "" : "s"} touched)`,
      ),
  );
  if (collapsed.length === 0) {
    console.log(pc.dim("\n  no file changes captured for this run"));
    if (!run.baseline_tree_id) {
      console.log(
        pc.dim(
          "  v0.3 file capture is opt-in per project — run `meter init` in the project's cwd to enable",
        ),
      );
    }
    return;
  }
  console.log("");
  for (const row of collapsed) {
    printRow(row);
  }
  // Footer
  console.log(
    pc.bold(
      `\nFinal ${signedAdd(stats.added)} ${signedRemove(stats.removed)}`,
    ) + pc.dim(`  across ${collapsed.length} file${collapsed.length === 1 ? "" : "s"}`),
  );
  if (baseline) {
    const head = baseline.git_head ? baseline.git_head.slice(0, 7) : "(no git)";
    const dirty = baseline.git_dirty
      ? pc.yellow("dirty")
      : pc.dim("clean");
    console.log(
      pc.dim(`Baseline:  git HEAD ${head}  (${dirty})`),
    );
  } else {
    console.log(
      pc.dim(
        "Baseline:  (none captured — proxy / non-coding runs or pre-v0.3 ingest)",
      ),
    );
  }
}

// ─── Mode 2: per-step ────────────────────────────────────────────────

async function runAtMode(
  store: import("@meterbility/collector").Store,
  run: Run,
  opts: { at?: string; json?: boolean },
): Promise<void> {
  const step = resolveStep(store, run, opts.at!);
  const fcs = listFileChanges(store, { stepId: step.step_id });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          run_id: run.run_id,
          step_id: step.step_id,
          sequence: step.sequence,
          files: fcs.map(rowToJson),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(
    pc.bold(`STEP #${step.sequence}`) +
      pc.dim(`  ${step.step_id.slice(0, 12)} · ${fcs.length} file change${fcs.length === 1 ? "" : "s"}`),
  );
  if (fcs.length === 0) {
    console.log(pc.dim("\n  step did not modify any files"));
    return;
  }
  console.log("");
  for (const fc of fcs) {
    printRow(toCollapsedRow(fc));
  }
}

// ─── Mode 2.5: --from/--to range summary (no path required) ──────────

/**
 * "Everything that changed from step X to [Y | current]" — the query
 * shape the meter-live design (docs/designs/meter-live-front-door.md §5)
 * identified as missing. Window semantics:
 *
 *   - `--from`/`--to` resolve against MAIN-BAND sequences; `--to`
 *     omitted = the latest ingested main-band step, so re-running
 *     against a live run means "to the current step".
 *   - Synthetic-band rows (hooks 100k / admin 200k / checkpoints 300k)
 *     are INCLUDED by default via wall-clock mapping (outside-voice T1:
 *     "everything" means everything): a band row counts when its parent
 *     step's timestamp falls within the boundary steps' timestamps,
 *     inclusive both ends. `--main-band-only` opts out; the footer
 *     reports what the opt-out excluded.
 */
async function runRangeMode(
  store: import("@meterbility/collector").Store,
  run: Run,
  opts: { from?: string; to?: string; mainBandOnly?: boolean; json?: boolean },
): Promise<void> {
  const steps = listSteps(store, run.run_id);
  const mainSteps = steps.filter((s) => s.sequence < RESERVED_SEQUENCE_BASE);
  const fromSeq = opts.from ? resolveStepSeqLoose(store, run, opts.from) : 0;
  const latestMainSeq =
    mainSteps.length > 0 ? mainSteps[mainSteps.length - 1]!.sequence : 0;
  const toSeq = opts.to ? resolveStepSeqLoose(store, run, opts.to) : latestMainSeq;
  // Inverted bounds are a user error only when the user supplied BOTH.
  // With --to defaulted to the current step, `--from 50` on a 3-step
  // run is a legitimate empty window (loose-resolution posture, same
  // as --diff), not a mistake to punish.
  if (fromSeq > toSeq && opts.to !== undefined) {
    console.error(pc.red(`--from (${fromSeq}) must be <= --to (${toSeq})`));
    process.exit(2);
  }

  // Boundary steps for the wall-clock band mapping. ISO-8601 timestamps
  // compare lexicographically.
  const inWindowMain = mainSteps.filter(
    (s) => s.sequence >= fromSeq && s.sequence <= toSeq,
  );
  const lowerTs = inWindowMain[0]?.timestamp;
  const upperTs = inWindowMain[inWindowMain.length - 1]?.timestamp;

  const stepById = new Map<string, Step>();
  for (const s of steps) stepById.set(s.step_id, s);

  const fcs = listFileChanges(store, { runId: run.run_id });
  const included: FileChange[] = [];
  /** file_change_id → band label, for rows included via wall-clock mapping. */
  const bandLabelByFcId = new Map<string, string>();
  let bandExcluded = 0;
  for (const fc of fcs) {
    const st = stepById.get(fc.step_id);
    if (!st) continue;
    if (st.sequence < RESERVED_SEQUENCE_BASE) {
      if (st.sequence >= fromSeq && st.sequence <= toSeq) included.push(fc);
      continue;
    }
    // Synthetic band. No main-band steps in the window → no wall-clock
    // span → band rows can never map in.
    const inWall =
      lowerTs !== undefined &&
      upperTs !== undefined &&
      st.timestamp >= lowerTs &&
      st.timestamp <= upperTs;
    if (!inWall) continue;
    if (opts.mainBandOnly) {
      bandExcluded += 1;
      continue;
    }
    bandLabelByFcId.set(fc.file_change_id, bandLabel(st.sequence));
    included.push(fc);
  }

  const collapsed = collapseByPath(included, bandLabelByFcId);
  const stats = totalStats(collapsed);
  const bandIncluded = bandLabelByFcId.size;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          run_id: run.run_id,
          from: fromSeq,
          to: toSeq,
          to_is_current: opts.to === undefined,
          main_band_only: opts.mainBandOnly === true,
          band_changes_included: bandIncluded,
          band_changes_excluded: bandExcluded,
          files_touched: collapsed.length,
          lines_added_total: stats.added,
          lines_removed_total: stats.removed,
          files: collapsed.map(rowToJson),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(
    pc.bold(`RANGE  steps ${fromSeq}–${toSeq}`) +
      pc.dim(
        `  (run ${run.run_id.slice(0, 12)}` +
          (opts.to === undefined ? " · to current step" : "") +
          ` · ${collapsed.length} file${collapsed.length === 1 ? "" : "s"} touched)`,
      ),
  );
  if (collapsed.length === 0) {
    console.log(pc.dim("\n  no captured changes in this step window"));
    if (bandExcluded > 0) {
      console.log(
        pc.dim(
          `  ${bandExcluded} band-attributed change${bandExcluded === 1 ? "" : "s"} excluded (--main-band-only)`,
        ),
      );
    }
    return;
  }
  console.log("");
  for (const row of collapsed) {
    printRow(row);
  }
  console.log(
    pc.bold(`\nWindow ${signedAdd(stats.added)} ${signedRemove(stats.removed)}`) +
      pc.dim(
        `  across ${collapsed.length} file${collapsed.length === 1 ? "" : "s"}`,
      ),
  );
  if (opts.mainBandOnly && bandExcluded > 0) {
    console.log(
      pc.dim(
        `${bandExcluded} band-attributed change${bandExcluded === 1 ? "" : "s"} excluded (--main-band-only)`,
      ),
    );
  } else if (bandIncluded > 0) {
    console.log(
      pc.dim(
        `${bandIncluded} band-attributed change${bandIncluded === 1 ? "" : "s"} included (hook/admin) — --main-band-only to exclude`,
      ),
    );
  }
}

/**
 * Human label for a synthetic-band sequence. Floors come from
 * @meterbility/shared (sequence.ts) — the same constants the cursor
 * adapter's band authority re-exports, so a floor change can't strand
 * this label.
 */
function bandLabel(sequence: number): string {
  if (sequence >= CHECKPOINT_SEQUENCE_BASE) return "checkpoint";
  if (sequence >= ADMIN_SEQUENCE_BASE) return "admin";
  return "hook";
}

// ─── Mode 3: --diff for one path ─────────────────────────────────────

async function runDiffMode(
  store: import("@meterbility/collector").Store,
  run: Run,
  opts: { diff?: string; from?: string; to?: string; json?: boolean },
): Promise<void> {
  const path = opts.diff!;
  // --from / --to accept any integer or step-id (existing or not).
  // "show me everything from step 100 onward" is a legitimate query
  // even when the run only has 10 steps — it just yields an empty
  // window. The strict-resolution path is reserved for `--at`, where
  // a missing step actually IS an error.
  const fromSeq = opts.from ? resolveStepSeqLoose(store, run, opts.from) : 0;
  const toSeq = opts.to
    ? resolveStepSeqLoose(store, run, opts.to)
    : Number.MAX_SAFE_INTEGER;
  if (fromSeq > toSeq) {
    console.error(pc.red(`--from (${fromSeq}) must be <= --to (${toSeq})`));
    process.exit(2);
  }

  // listFileChanges returns rows sorted by (step.sequence, fc.sequence).
  // We filter post-query by step.sequence window because the query
  // helper takes maxStepSeqExclusive, not a from/to pair.
  const all = listFileChanges(store, { runId: run.run_id, path });
  const inWindow = filterByStepSeq(store, all, fromSeq, toSeq);

  if (opts.json) {
    const blocks = await Promise.all(
      inWindow.map(async (fc) => ({
        step_id: fc.step_id,
        op: fc.op,
        partial_diff: fc.partial_diff,
        patch_text: fc.patch_text,
        lines_added: fc.lines_added,
        lines_removed: fc.lines_removed,
        before_blob_ref: fc.before_blob_ref,
        after_blob_ref: fc.after_blob_ref,
      })),
    );
    process.stdout.write(
      JSON.stringify(
        { run_id: run.run_id, path, from: fromSeq, to: toSeq, blocks },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(
    pc.bold(`DIFF  ${path}`) +
      pc.dim(`  (run ${run.run_id.slice(0, 12)} · ${inWindow.length} change${inWindow.length === 1 ? "" : "s"} in window)`),
  );
  if (inWindow.length === 0) {
    console.log(pc.dim("\n  no captured changes for this path in the chosen step window"));
    return;
  }
  // Build a step_id → sequence lookup once so each diff block can show
  // a meaningful "step #N" instead of the intra-step ordering field
  // (which is always 0 for the first row in a step).
  const steps = listSteps(store, run.run_id);
  const seqByStepId = new Map<string, number>();
  for (const s of steps) seqByStepId.set(s.step_id, s.sequence);
  for (const fc of inWindow) {
    const parentSeq = seqByStepId.get(fc.step_id);
    const seqLabel = parentSeq !== undefined ? `step #${parentSeq}` : "step ?";
    console.log(
      "\n" +
        pc.bold(`@@ ${seqLabel}`) +
        pc.dim(`  ${fc.step_id.slice(0, 12)} · ${fc.op}`),
    );
    if (fc.partial_diff) {
      console.log(
        pc.yellow(
          "  partial: this change ran outside captured tools (e.g. Bash). Run `meter init --hooks` for exact capture, or `meter watch --files` as a cross-vendor fallback.",
        ),
      );
      continue;
    }
    if (!fc.patch_text) {
      console.log(pc.dim("  (binary or no-op — no patch text)"));
      continue;
    }
    printColorizedPatch(fc.patch_text);
  }
}

// ─── Shared rendering helpers ────────────────────────────────────────

interface CollapsedRow {
  path: string;
  terminalOp: FileOp;
  lines_added: number;
  lines_removed: number;
  rename_from?: string;
  any_partial: boolean;
  any_binary: boolean;
  /** Count of underlying FileChange rows for this path. */
  change_count: number;
  /** Synthetic-band sources that contributed rows (range mode): e.g.
   *  ["hook"]. Empty for pure main-band paths. */
  band_labels: string[];
}

/**
 * Collapse multiple FileChanges to the same path into one summary
 * row. Used by the default + --at summary views. The "terminal op" is
 * the last op that hit the path in this view's window — gives the
 * user "what's the final state?" at a glance.
 */
function collapseByPath(
  fcs: FileChange[],
  bandLabelByFcId?: Map<string, string>,
): CollapsedRow[] {
  const byPath = new Map<string, CollapsedRow>();
  for (const fc of fcs) {
    // Normalize: rename rows are keyed by the new path; the old path
    // is recorded in `rename_from` for display.
    const key = fc.path;
    const band = bandLabelByFcId?.get(fc.file_change_id);
    const existing = byPath.get(key);
    if (existing) {
      existing.lines_added += fc.lines_added;
      existing.lines_removed += fc.lines_removed;
      existing.terminalOp = fc.op;
      existing.any_partial = existing.any_partial || fc.partial_diff;
      existing.any_binary =
        existing.any_binary || fc.patch_format === "binary";
      existing.change_count += 1;
      if (band && !existing.band_labels.includes(band)) {
        existing.band_labels.push(band);
      }
      if (fc.op === "rename" && fc.old_path) {
        existing.rename_from = fc.old_path;
      }
    } else {
      const row = toCollapsedRow(fc);
      if (band) row.band_labels.push(band);
      byPath.set(key, row);
    }
  }
  // Sort by path (matches what `git status` does — predictable scan
  // order beats arrival order for a summary view).
  return [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

function toCollapsedRow(fc: FileChange): CollapsedRow {
  return {
    path: fc.path,
    terminalOp: fc.op,
    lines_added: fc.lines_added,
    lines_removed: fc.lines_removed,
    rename_from: fc.op === "rename" ? fc.old_path : undefined,
    any_partial: fc.partial_diff,
    any_binary: fc.patch_format === "binary",
    change_count: 1,
    band_labels: [],
  };
}

function totalStats(rows: CollapsedRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    added += r.lines_added;
    removed += r.lines_removed;
  }
  return { added, removed };
}

function printRow(row: CollapsedRow): void {
  const tag = opTag(row.terminalOp);
  const renderedPath =
    row.terminalOp === "rename" && row.rename_from
      ? `${row.rename_from} → ${row.path}`
      : row.path;
  const pathCell = renderedPath.padEnd(32);
  const stats = `${signedAdd(row.lines_added).padStart(6)} ${signedRemove(row.lines_removed).padStart(6)}`;
  const flags: string[] = [];
  if (row.any_partial) flags.push(pc.yellow("partial"));
  if (row.any_binary) flags.push(pc.dim("binary"));
  if (row.change_count > 1) flags.push(pc.dim(`${row.change_count} changes`));
  for (const band of row.band_labels) flags.push(pc.magenta(`(${band})`));
  console.log(
    `  ${tag}  ${pathCell}  ${stats}${flags.length ? "  " + flags.join(" ") : ""}`,
  );
}

function opTag(op: FileOp): string {
  switch (op) {
    case "create":
      return pc.green("A");
    case "modify":
      return pc.yellow("M");
    case "delete":
      return pc.red("D");
    case "rename":
      return pc.magenta("R");
    case "chmod":
      return pc.dim("X");
  }
}

function signedAdd(n: number): string {
  return n === 0 ? "+0" : pc.green(`+${n}`);
}
function signedRemove(n: number): string {
  return n === 0 ? "−0" : pc.red(`−${n}`);
}

function printColorizedPatch(patch: string): void {
  // Standard `+`/`-` highlighting plus cerulean for hunk headers. We
  // intentionally don't word-diff — that's the v0.5 renderer's job.
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      console.log(pc.cyan(line));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      console.log(pc.green(line));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      console.log(pc.red(line));
    } else {
      console.log(line);
    }
  }
}

function rowToJson(arg: CollapsedRow | FileChange): unknown {
  if ("change_count" in arg) {
    const r = arg as CollapsedRow;
    return {
      path: r.path,
      op: r.terminalOp,
      rename_from: r.rename_from,
      lines_added: r.lines_added,
      lines_removed: r.lines_removed,
      change_count: r.change_count,
      partial: r.any_partial,
      binary: r.any_binary,
      ...(r.band_labels.length > 0 ? { band_sources: r.band_labels } : {}),
    };
  }
  const fc = arg as FileChange;
  return {
    file_change_id: fc.file_change_id,
    step_id: fc.step_id,
    sequence: fc.sequence,
    path: fc.path,
    old_path: fc.old_path,
    op: fc.op,
    before_blob_ref: fc.before_blob_ref,
    after_blob_ref: fc.after_blob_ref,
    partial_diff: fc.partial_diff,
    patch_format: fc.patch_format,
    lines_added: fc.lines_added,
    lines_removed: fc.lines_removed,
    source_tool_name: fc.source_tool_name,
  };
}

// ─── Step resolution helpers ─────────────────────────────────────────

/**
 * Accepts either a numeric sequence (`--at 5`) or a step-id prefix
 * (`--at stp_abc`). Mirrors the convention `meter inspect` uses so
 * the muscle memory is shared. Strict: a missing step is an error.
 */
function resolveStep(
  store: import("@meterbility/collector").Store,
  run: Run,
  needle: string,
): Step {
  const seq = Number(needle);
  const step = Number.isFinite(seq)
    ? getStepBySequence(store, run.run_id, seq)
    : getStep(store, needle);
  if (!step) {
    console.error(pc.red(`step not found: ${needle}`));
    process.exit(1);
  }
  return step;
}

/**
 * Loose variant used by --from / --to. Numeric inputs are taken at
 * face value (no validation against the run's step count) so a
 * window past the end is a legitimate empty-result query, not an
 * error. Non-numeric inputs still resolve through `getStep` and
 * error on miss — passing a bogus step-id is always a user mistake.
 */
function resolveStepSeqLoose(
  store: import("@meterbility/collector").Store,
  run: Run,
  needle: string,
): number {
  const seq = Number(needle);
  if (Number.isFinite(seq)) return seq;
  const step = getStep(store, needle);
  if (!step) {
    console.error(pc.red(`step not found: ${needle}`));
    process.exit(1);
  }
  return step.sequence;
}

/**
 * Cross-reference FileChanges with their parent steps to filter by
 * sequence window. The shape `listFileChanges` returns lacks
 * sequence (it's join-only in the query), so we re-look-up via the
 * steps already loaded.
 */
function filterByStepSeq(
  store: import("@meterbility/collector").Store,
  fcs: FileChange[],
  fromSeq: number,
  toSeq: number,
): FileChange[] {
  if (fcs.length === 0) return fcs;
  // Build a stepId → sequence map once. The run is finite; this is
  // cheap and avoids a hot per-row DB query.
  const steps = listSteps(store, fcs[0]!.run_id);
  const seqByStepId = new Map<string, number>();
  for (const s of steps) seqByStepId.set(s.step_id, s.sequence);
  return fcs.filter((fc) => {
    const seq = seqByStepId.get(fc.step_id);
    if (seq === undefined) return false;
    return seq >= fromSeq && seq <= toSeq;
  });
}
