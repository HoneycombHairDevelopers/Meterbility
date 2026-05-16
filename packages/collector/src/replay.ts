import type {
  BaselineTree,
  ManifestEntry,
  WorkingTree,
} from "@spool/shared";
import {
  getBaselineTree,
  getRun,
  listFileChanges,
} from "./queries.ts";
import type { Store } from "./store.ts";

/**
 * v0.3 file-capture replay layer.
 *
 * Two responsibilities, kept in one module because they're entirely
 * mutually-dependent:
 *
 *   1. **Manifest serde** — the on-disk format for a `baseline_tree`'s
 *      manifest blob (sorted, NUL-separated, newline-delimited records:
 *      `path` + 0x00 + `mode` + 0x00 + `blob_ref` + 0x0A). Sortedness
 *      is what makes two identical trees produce byte-identical
 *      manifests, which makes the blob store dedup naturally — the
 *      dominant storage win flagged in v0.3 §3.5.
 *
 *   2. **`workingTreeAt(store, runId, stepSeq)`** — the spec's §3.6
 *      algorithm. Layers FileChange events on top of a baseline tree
 *      to compute the working tree at a chosen point in the run.
 *      Pure function over store reads; never touches the filesystem.
 */

// ─── Manifest format ──────────────────────────────────────────────────

const FIELD_SEP = 0x00;
const RECORD_SEP = 0x0a;

/**
 * Serialize a list of manifest entries into the on-disk format. Entries
 * are sorted by path (bytewise on the UTF-8 representation, matching
 * git's convention — deterministic across locales).
 *
 * Throws on illegal paths: NUL (0x00) and newline (0x0A) bytes would
 * break the record separators. POSIX disallows both in filenames; if
 * the agent somehow produced one we refuse rather than silently
 * corrupt the manifest.
 */
export function serializeManifest(entries: ManifestEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ab = Buffer.from(a.path, "utf-8");
    const bb = Buffer.from(b.path, "utf-8");
    return Buffer.compare(ab, bb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const pathBuf = Buffer.from(e.path, "utf-8");
    if (pathBuf.includes(FIELD_SEP) || pathBuf.includes(RECORD_SEP)) {
      throw new Error(
        `serializeManifest: path contains illegal byte (NUL or newline): ${JSON.stringify(e.path)}`,
      );
    }
    const refBuf = Buffer.from(e.blob_ref, "utf-8");
    if (refBuf.includes(FIELD_SEP) || refBuf.includes(RECORD_SEP)) {
      throw new Error(
        `serializeManifest: blob_ref contains illegal byte: ${JSON.stringify(e.blob_ref)}`,
      );
    }
    parts.push(pathBuf);
    parts.push(Buffer.from([FIELD_SEP]));
    parts.push(Buffer.from(String(e.mode), "utf-8"));
    parts.push(Buffer.from([FIELD_SEP]));
    parts.push(refBuf);
    parts.push(Buffer.from([RECORD_SEP]));
  }
  return Buffer.concat(parts);
}

/**
 * Inverse of `serializeManifest`. Tolerates an absent trailing newline
 * (empty manifests serialize to an empty buffer; we return [] for both
 * `Buffer.alloc(0)` and `Buffer.from([])`).
 */
export function parseManifest(buf: Buffer): ManifestEntry[] {
  if (buf.length === 0) return [];
  const entries: ManifestEntry[] = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const nl = buf.indexOf(RECORD_SEP, cursor);
    const end = nl === -1 ? buf.length : nl;
    if (end === cursor) {
      // empty line — tolerate, advance past it
      cursor = end + 1;
      continue;
    }
    const record = buf.subarray(cursor, end);
    const sep1 = record.indexOf(FIELD_SEP);
    if (sep1 === -1) {
      throw new Error(
        `parseManifest: malformed record at offset ${cursor} (no NUL separator)`,
      );
    }
    const sep2 = record.indexOf(FIELD_SEP, sep1 + 1);
    if (sep2 === -1) {
      throw new Error(
        `parseManifest: malformed record at offset ${cursor} (missing second NUL)`,
      );
    }
    const path = record.subarray(0, sep1).toString("utf-8");
    const modeStr = record.subarray(sep1 + 1, sep2).toString("utf-8");
    const blob_ref = record.subarray(sep2 + 1).toString("utf-8");
    const mode = Number.parseInt(modeStr, 10);
    if (!Number.isFinite(mode)) {
      throw new Error(
        `parseManifest: invalid mode "${modeStr}" at offset ${cursor}`,
      );
    }
    entries.push({ path, mode, blob_ref });
    if (nl === -1) break;
    cursor = nl + 1;
  }
  return entries;
}

/**
 * Load a baseline tree's manifest from the blob store and parse it
 * into a WorkingTree (the seed state the replay layers FileChanges on
 * top of). Returns an empty tree if the manifest blob can't be read
 * — better than throwing because a run with a missing baseline can
 * still be partially reconstructed from FileChanges, and the UI can
 * surface a warning instead of a hard failure.
 */
export async function loadBaselineTree(
  store: Store,
  baseline: BaselineTree,
): Promise<WorkingTree> {
  const tree: WorkingTree = new Map();
  const buf = await store.blobs.getBuffer(baseline.manifest_blob_ref).catch(
    () => undefined,
  );
  if (!buf) return tree;
  for (const e of parseManifest(buf)) {
    tree.set(e.path, { blob_ref: e.blob_ref, mode: e.mode });
  }
  return tree;
}

// ─── Replay ───────────────────────────────────────────────────────────

export interface WorkingTreeAtOpts {
  /**
   * Apply only FileChanges from steps with `sequence < this value`.
   * Default: undefined → include every step in the run (final state).
   * Use 0 to get the baseline (pre-step-0) state.
   */
  stepSeq?: number;
}

/**
 * Compute the working tree at a chosen point in a run.
 *
 * Implements the algorithm in v0.3 §3.6:
 *   1. Load the run's baseline tree (the seed).
 *   2. Apply every FileChange with `step.sequence < stepSeq` in order
 *      (step.sequence ASC, file_change.sequence ASC).
 *   3. Return the resulting (path → {blob_ref, mode}) map.
 *
 * Complexity: O(touched_paths). The `idx_fc_run_path` and the
 * `listFileChanges` join keep this bounded by the number of files
 * modified in the run, never by the total files in the repo.
 *
 * Returns an empty tree if:
 *   - The run doesn't exist.
 *   - The run has no `baseline_tree_id` AND no FileChanges (typical for
 *     non-coding runs).
 *
 * Returns a baseline-only tree if the run has a baseline but no
 * FileChanges before `stepSeq` — useful for "what did the agent see
 * walking in?" queries.
 */
export async function workingTreeAt(
  store: Store,
  runId: string,
  opts: WorkingTreeAtOpts = {},
): Promise<WorkingTree> {
  const run = getRun(store, runId);
  if (!run) return new Map();
  const tree: WorkingTree = run.baseline_tree_id
    ? await (async () => {
        const bt = getBaselineTree(store, run.baseline_tree_id!);
        return bt ? await loadBaselineTree(store, bt) : new Map();
      })()
    : new Map();

  const fcs = listFileChanges(store, {
    runId: run.run_id,
    maxStepSeqExclusive: opts.stepSeq,
  });

  for (const fc of fcs) {
    applyFileChange(tree, fc);
  }
  return tree;
}

/**
 * Apply a single FileChange to a WorkingTree in place. Pulled out so
 * the v0.5 working-tree-scrubber UI can re-use it for incremental
 * updates without re-running the whole replay each frame.
 *
 * `chmod` updates mode bits only — the spec's algorithm sketch passes
 * for blob-ref purposes (content unchanged), but we DO update `mode`
 * when present because mode is also part of the working-tree contract.
 * If `mode_after` is unset, the operation is a true no-op.
 *
 * `partial_diff` FileChanges (typically Bash steps in v0.3) carry no
 * blob refs. They're applied as a no-op for tree reconstruction — the
 * Files UI surfaces the existence of the change separately so the user
 * knows to enable the v0.4 watcher for full fidelity.
 */
export function applyFileChange(
  tree: WorkingTree,
  fc: {
    op: string;
    path: string;
    old_path?: string;
    after_blob_ref?: string;
    mode_after?: number;
    partial_diff?: boolean;
  },
): void {
  if (fc.partial_diff) return; // shell-mediated; no content to apply
  if (fc.op === "delete") {
    tree.delete(fc.path);
    return;
  }
  if (fc.op === "rename") {
    if (fc.old_path) tree.delete(fc.old_path);
    if (fc.after_blob_ref) {
      const existing = tree.get(fc.path);
      tree.set(fc.path, {
        blob_ref: fc.after_blob_ref,
        mode: fc.mode_after ?? existing?.mode ?? 0o100644,
      });
    }
    return;
  }
  if (fc.op === "chmod") {
    const existing = tree.get(fc.path);
    if (existing && fc.mode_after !== undefined) {
      tree.set(fc.path, { ...existing, mode: fc.mode_after });
    }
    return;
  }
  // create | modify
  if (fc.after_blob_ref) {
    const existing = tree.get(fc.path);
    tree.set(fc.path, {
      blob_ref: fc.after_blob_ref,
      mode: fc.mode_after ?? existing?.mode ?? 0o100644,
    });
  }
}
