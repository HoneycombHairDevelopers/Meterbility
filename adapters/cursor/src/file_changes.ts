import type { FileChange } from "@meterbility/shared";
import { diffLines, hashJson, redactString } from "@meterbility/shared";
import { insertFileChange } from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import type { CursorDb } from "./parser.ts";
import { toRepoRelative } from "./paths.ts";
import type { CursorBubble } from "./types.ts";

/**
 * Cursor file-change extraction (cross-vendor parity, 2026-08-04).
 *
 * Cursor's local DB stores file mutations in `toolFormerData` on the
 * bubble that ran the tool — richer than any other vendor's local data:
 *
 * - `search_replace` / `write`: `params.relativeWorkspacePath` plus
 *   `result.diff.chunks[]` ({diffString, linesAdded, linesRemoved}) —
 *   per-edit unified-diff hunks. No before-content → partial_diff rows
 *   with patch_text.
 * - `edit_file_v2`: `result.{beforeContentId, afterContentId}` —
 *   content-addressed ids resolving to `composer.content.<id>` KV rows
 *   holding FULL before/after file bodies → complete (non-partial)
 *   FileChange rows with both blobs. A missing `beforeContentId` (or
 *   `result.isNewlyCreated`) is a create. The before-image source is
 *   recorded as `normalizer_notes.before_source` with the same
 *   vocabulary the Claude Code adapter uses (`tool-result`: the tool's
 *   own result addressed the blob).
 * - `delete_file`: `params.relativeWorkspacePath` → fact-only delete row.
 *
 * Real-data shapes (verified 2026-10-13 against a live Cursor 2.x
 * state.vscdb): `relativeWorkspacePath` is ABSOLUTE despite its name;
 * content ids already carry the `composer.content.` prefix;
 * search_replace chunks carry `oldLines/newLines/linesAdded` but omit
 * `linesRemoved` when it is zero (and the diffString has no `@@`
 * header — lines are prefixed `+ `, `- `, `  `).
 *
 * Paths are stored repo-relative (against the composer's workspace cwd)
 * so the checkpoint fallback in extras.ts — which canonicalizes
 * checkpoint URIs the same way — can tell which paths are already
 * covered instead of emitting a duplicate `cursor-checkpoint` row.
 *
 * When `additionalData.codeblockId` is present, the accept/reject fate
 * ledger (`codeBlockPartialInlineDiffFates:<composerId>:<codeblockId>`)
 * is summarized into `normalizer_notes` — which AI edits the human
 * actually kept. No other vendor exposes this.
 */

/** Tool names the extractor derives file_change rows from (see probe.ts). */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  "search_replace",
  "write",
  "edit_file_v2",
  "delete_file",
]);

function isFileTool(name: string | undefined): boolean {
  return name !== undefined && FILE_TOOLS.has(name);
}

/** Every branch emits exactly one row per (run, bubble, path). */
const FIRST_CHANGE_SEQ = 0;

interface DiffChunk {
  diffString?: string;
  oldLines?: number;
  newLines?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * Where an edit_file_v2 before-image came from — same vocabulary as
 * the Claude Code adapter's `BeforeSource` so cross-adapter consumers
 * can rank trustworthiness uniformly. Cursor only has one source: the
 * content blob the tool result itself addressed.
 */
type BeforeSource = "tool-result";

type NormalizerNotes =
  | string
  | { before_source: BeforeSource; note?: string }
  | undefined;

export async function extractCursorFileChanges(
  store: Store,
  cursor: CursorDb,
  composerId: string,
  bubble: CursorBubble,
  runId: string,
  stepId: string,
  cwd?: string,
): Promise<number> {
  const tf = bubble.toolFormerData;
  if (!tf || !isFileTool(tf.name)) return 0;

  const params = parseMaybeJson(tf.params) ?? parseMaybeJson(tf.rawArgs);
  const rawPath =
    isObj(params) && typeof params.relativeWorkspacePath === "string"
      ? params.relativeWorkspacePath
      : undefined;
  if (!rawPath) return 0;
  // Despite the name, real Cursor writes an absolute path here. Store
  // it repo-relative when the composer has a workspace cwd; a path
  // already relative (fixtures, older Cursor) passes through unchanged.
  const relPath = toRepoRelative(rawPath, cwd);
  if (relPath.length === 0) return 0;

  const result = parseMaybeJson(tf.result);
  // Stable across re-ingests regardless of step-id scheme: keyed on the
  // bubble, not the step.
  const anchor = bubble.bubbleId ?? stepId;
  const fcId = `fc_${hashJson([runId, anchor, relPath, FIRST_CHANGE_SEQ])}`;
  const notes = fateNotes(cursor, composerId, tf);

  // Params carry raw edit content (old_string/new_string) which
  // bypasses the blob pipeline's redaction — store the redacted JSON
  // string, matching the codex adapter's raw V4A input handling.
  const inputRedaction =
    params !== undefined ? redactString(JSON.stringify(params)) : undefined;
  const base = {
    run_id: runId,
    step_id: stepId,
    tool_call_id: tf.toolCallId ?? tf.modelCallId,
    derived_from: "tool_call" as const,
    gitignored: false,
    bom: false,
    redacted: (inputRedaction?.redactions.length ?? 0) > 0,
    source_tool_name: tf.name,
    source_tool_input: inputRedaction?.text,
    normalizer_notes: notes,
  };

  const insertGuarded = (
    fc: Omit<FileChange, "created_at"> & { file_change_id: string },
  ): number => {
    const exists = store.db
      .prepare(`SELECT 1 FROM file_change WHERE file_change_id = ?`)
      .get(fc.file_change_id);
    if (exists) return 0;
    insertFileChange(store, fc);
    return 1;
  };

  if (tf.name === "delete_file") {
    return insertGuarded({
      ...base,
      file_change_id: fcId,
      sequence: FIRST_CHANGE_SEQ,
      path: relPath,
      op: "delete",
      partial_diff: true,
      lines_added: 0,
      lines_removed: 0,
    });
  }

  if (tf.name === "edit_file_v2") {
    const beforeId =
      isObj(result) && typeof result.beforeContentId === "string"
        ? result.beforeContentId
        : undefined;
    const afterId =
      isObj(result) && typeof result.afterContentId === "string"
        ? result.afterContentId
        : undefined;
    const flaggedCreate = isObj(result) && result.isNewlyCreated === true;
    const beforeContent = beforeId ? cursor.getContentBlob(beforeId) : undefined;
    const afterContent = afterId ? cursor.getContentBlob(afterId) : undefined;
    // A beforeContentId whose blob was pruned by Cursor's retention is
    // NOT a create — the file existed, its prior content is just gone.
    // Only a genuinely absent beforeContentId (or an empty "" before
    // body, or an explicit isNewlyCreated flag) means create; a pruned
    // before degrades the whole row to the partial-diff branch below
    // (the partial_diff invariant requires BOTH blob refs null, so the
    // after content can't be stored either).
    const beforePruned =
      beforeId !== undefined && beforeContent === undefined && !flaggedCreate;

    if (afterContent !== undefined && !beforePruned) {
      const isCreate =
        flaggedCreate || beforeContent === undefined || beforeContent.length === 0;
      const stats =
        beforeContent !== undefined
          ? diffLines(beforeContent, afterContent).stats
          : { added: countLines(afterContent), removed: 0 };
      const beforeRef =
        beforeContent !== undefined && !isCreate
          ? await store.blobs.putString(beforeContent)
          : undefined;
      const afterRef = await store.blobs.putString(afterContent);
      // Record where the before-image came from, as the Claude Code
      // adapter does. Omitted for creates (no before-image) so create
      // rows keep their existing shape.
      const fullNotes: NormalizerNotes = beforeRef
        ? { before_source: "tool-result", ...(notes ? { note: notes } : {}) }
        : notes;
      return insertGuarded({
        ...base,
        file_change_id: fcId,
        sequence: FIRST_CHANGE_SEQ,
        path: relPath,
        op: isCreate ? "create" : "modify",
        normalizer_notes: fullNotes,
        before_blob_ref: beforeRef,
        after_blob_ref: afterRef,
        partial_diff: false,
        size_before: beforeRef ? Buffer.byteLength(beforeContent!, "utf-8") : undefined,
        size_after: Buffer.byteLength(afterContent, "utf-8"),
        line_count_before: beforeRef ? countLines(beforeContent!) : undefined,
        line_count_after: countLines(afterContent),
        lines_added: stats.added,
        lines_removed: stats.removed,
      });
    }
    // Content blobs pruned by Cursor's retention — degrade to fact-only.
    return insertGuarded({
      ...base,
      file_change_id: fcId,
      sequence: FIRST_CHANGE_SEQ,
      path: relPath,
      op: "modify",
      partial_diff: true,
      lines_added: 0,
      lines_removed: 0,
      normalizer_notes: joinNotes(
        notes,
        beforePruned && afterContent !== undefined
          ? "before content pruned by Cursor retention"
          : "content blobs pruned by Cursor retention",
      ),
    });
  }

  // search_replace / write — unified-diff chunks, no before-content.
  const chunks: DiffChunk[] =
    isObj(result) && isObj(result.diff) && Array.isArray(result.diff.chunks)
      ? (result.diff.chunks as DiffChunk[])
      : [];
  // Inline patch text bypasses the blob pipeline's redaction — apply
  // the same pass before it hits SQLite.
  const patchRedaction = redactString(
    chunks
      .map((c) => c.diffString)
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n"),
  );
  const patchText = patchRedaction.text;
  const linesAdded = chunks.reduce((n, c) => n + chunkLinesAdded(c), 0);
  const linesRemoved = chunks.reduce((n, c) => n + chunkLinesRemoved(c), 0);

  return insertGuarded({
    ...base,
    file_change_id: fcId,
    sequence: FIRST_CHANGE_SEQ,
    path: relPath,
    op: "modify",
    partial_diff: true,
    patch_text: patchText.length > 0 ? patchText : undefined,
    patch_format: patchText.length > 0 ? "unified" : undefined,
    redacted: base.redacted || patchRedaction.redactions.length > 0,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  });
}

/**
 * Summarize the accept/reject fate ledger for this tool call's code
 * block, when present. Defensive: the fates shape is reverse-engineered;
 * unknown shapes degrade to no note, never a throw.
 */
function fateNotes(
  cursor: CursorDb,
  composerId: string,
  tf: NonNullable<CursorBubble["toolFormerData"]>,
): string | undefined {
  const ad = tf.additionalData;
  const codeblockId =
    isObj(ad) && typeof ad.codeblockId === "string" ? ad.codeblockId : undefined;
  if (!codeblockId) return undefined;
  const raw = cursor.getRawKV(
    `codeBlockPartialInlineDiffFates:${composerId}:${codeblockId}`,
  );
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { fates?: Array<{ fate?: unknown }> };
    const fates = Array.isArray(parsed?.fates) ? parsed.fates : [];
    if (fates.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const f of fates) {
      const k = typeof f?.fate === "string" ? f.fate : String(f?.fate);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const summary = [...counts.entries()]
      .map(([k, n]) => `${k}:${n}`)
      .join(",");
    return `fates{${summary}}`;
  } catch {
    return undefined;
  }
}

/**
 * Real chunks omit `linesAdded`/`linesRemoved` when zero. Derive the
 * missing count from the hunk extents — a hunk spans `context +
 * removed` old lines and `context + added` new lines, so
 * `removed = oldLines − newLines + added` — and fall back to counting
 * the `-`/`+` prefixed lines of `diffString` when the extents are
 * absent too.
 */
function chunkLinesAdded(c: DiffChunk): number {
  if (typeof c.linesAdded === "number") return c.linesAdded;
  if (
    typeof c.oldLines === "number" &&
    typeof c.newLines === "number" &&
    typeof c.linesRemoved === "number"
  ) {
    return Math.max(0, c.newLines - c.oldLines + c.linesRemoved);
  }
  return countPrefixedLines(c.diffString, "+");
}

function chunkLinesRemoved(c: DiffChunk): number {
  if (typeof c.linesRemoved === "number") return c.linesRemoved;
  if (
    typeof c.oldLines === "number" &&
    typeof c.newLines === "number" &&
    typeof c.linesAdded === "number"
  ) {
    return Math.max(0, c.oldLines - c.newLines + c.linesAdded);
  }
  return countPrefixedLines(c.diffString, "-");
}

function countPrefixedLines(diff: string | undefined, prefix: "+" | "-"): number {
  if (!diff) return 0;
  let n = 0;
  for (const line of diff.split("\n")) {
    // Skip unified-diff file headers (`+++`/`---`) and hunk headers.
    if (line.startsWith(prefix) && !line.startsWith(prefix.repeat(3))) n += 1;
  }
  return n;
}

function joinNotes(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}
