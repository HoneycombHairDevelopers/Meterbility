import type { FileChange, FileOp, Step } from "@meterbility/shared";
import {
  IgnoreMatcher,
  SENSITIVE_METERBILITYIGNORE,
  diffLines,
  hashJson,
  redactString,
} from "@meterbility/shared";
import { enforceFileSizePolicy } from "@meterbility/collector";
import type { CopilotShellToolInfo, CopilotToolResult } from "./types.ts";

/**
 * GitHub Copilot CLI file-change derivation.
 *
 * events.jsonl carries tool INPUTS on `tool.execution_start` and tool
 * RESULTS on `tool.execution_complete`; it never carries file bytes
 * directly. The tool-result tier nevertheless recovers full before/
 * after images for most edits (verified against the 5 local real
 * sessions, 2026-10: 12/12 successful edits, 41/41 successful creates):
 *
 *   - `create` → `arguments.file_text` IS the after-image.
 *   - `view` (no `view_range`) → `result.content` is the whole file with
 *     "N. " line numbering; stripped, it is a byte-exact image of the
 *     file at that moment (equal to the all-context diff the CLI puts
 *     in `result.detailedContent` in every observed case).
 *   - `edit` → `old_str`/`new_str` applied to the freshest known image
 *     of the path gives before + after. `result.detailedContent` is the
 *     CLI's own git unified diff of what it actually wrote: stored as
 *     `patch_text`, and its hunk +/- counts cross-check our derivation.
 *
 * Before-image resolution, freshest wins (recorded as
 * `normalizer_notes.before_source`, same convention as the Claude Code
 * adapter):
 *   "view_result"   — the most recent successful whole-file `view` of
 *                     the path in this session
 *   "session_chain" — the after-image of the previous captured
 *                     create/edit of the path in this session
 *   "none"          — neither (row stays partial, no blobs)
 * "Freshest" is by file order: a view taken BEFORE a captured edit of
 * the same path is stale, and `old_str` can still fit a stale image
 * (the edit may touch an untouched region), so recency — not a fixed
 * source rank — decides. A candidate that `old_str` does not fit
 * exactly once is rejected; a derived pair whose line counts disagree
 * with the CLI's own hunks is rejected too (partial stub instead).
 *
 * Rows are finalized on `tool.execution_complete`: a failed completion
 * (`success:false` / `isError` / `error`) produces NO row — the CLI
 * refused the write ("Path already exists", "No match found"). A start
 * with no completion at all (torn tail, crash) keeps a partial stub.
 *
 * `bash` is a (shell) stub by default (same convention as Claude Code's
 * Bash). When the CLI's own `shellToolInfo` says the command redirects
 * into a file AND the redirect target we parse from the command is one
 * of its `possiblePaths`, the stub is path-aware instead.
 */

/** Tool names whose success mutates a file → FileChange row. The real
 *  vocabulary is `create` / `edit`; the rest are alias insurance for
 *  older/community shapes and cost nothing when absent. */
export const MUTATING_TOOLS = new Map<string, FileOp>([
  ["create", "create"],
  ["write", "create"],
  ["write_file", "create"],
  ["edit", "modify"],
  ["edit_file", "modify"],
  ["str_replace", "modify"],
  ["str_replace_editor", "modify"],
  ["apply_patch", "modify"],
  ["insert", "modify"],
  ["delete_file", "delete"],
]);

/** Shell tools: opaque side effects → stub rows. */
export const SHELL_TOOLS = new Set(["bash", "shell"]);

/** Read-only tools whose successful result is a file image. */
export const VIEW_TOOLS = new Set(["view", "read_file", "read"]);

/** Combined old+new size above which str_replace-style inputs get
 *  whole-block line counts instead of a real diff — diffLines is
 *  O(n*m) in lines and session files are untrusted input. */
export const DIFF_INPUT_CAP_BYTES = 512_000;
/** Largest file image we keep in session memory for chaining. */
const IMAGE_CAP_BYTES = 2_000_000;
/** Largest patch_text we persist on the row (both blobs still land;
 *  the diff is derivable from them). */
const PATCH_TEXT_CAP_BYTES = 1_000_000;

export type BeforeSource = "view_result" | "session_chain" | "none";

export interface KnownImage {
  text: string;
  source: Exclude<BeforeSource, "none">;
}

/** Session-scoped memory of the freshest known content per path. */
export class SessionImages {
  private map = new Map<string, KnownImage>();
  get(path: string): KnownImage | undefined {
    return this.map.get(path);
  }
  set(path: string, img: KnownImage): void {
    if (img.text.length > IMAGE_CAP_BYTES) {
      this.map.delete(path);
      return;
    }
    this.map.set(path, img);
  }
  invalidate(path: string): void {
    this.map.delete(path);
  }
  get size(): number {
    return this.map.size;
  }
}

export interface BlobSink {
  putString(s: string, opts?: { skipRedact?: boolean }): Promise<string>;
}

export interface FileToolCall {
  runId: string;
  step: Step;
  callId: string;
  toolName: string;
  rawInput: unknown;
  /** Workspace cwd for relativizing absolute tool-input paths. */
  cwd?: string;
  blobs: BlobSink;
  images: SessionImages;
}

export function isFileTool(toolName: string): boolean {
  const t = toolName.toLowerCase();
  return MUTATING_TOOLS.has(t) || SHELL_TOOLS.has(t);
}

export function isViewTool(toolName: string): boolean {
  return VIEW_TOOLS.has(toolName.toLowerCase());
}

// ─── View results → known images ─────────────────────────────────────

/** Strip Copilot's "N. " line numbering from a `view` result. Returns
 *  undefined when any line lacks the numbering (directory listings,
 *  truncation notices, foreign shapes) — never a half-stripped file. */
export function stripViewNumbering(content: string): string | undefined {
  if (content === "") return "";
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = /^\d+\.( |$)/.exec(line);
    if (!m) return undefined;
    out.push(line.slice(m[0].length));
  }
  return out.join("\n");
}

/** A successful `view` with no range is a whole-file image. */
export function recordViewResult(
  call: Pick<FileToolCall, "rawInput" | "cwd" | "images">,
  result: CopilotToolResult | undefined,
): boolean {
  const input = inputRecord(call.rawInput);
  const path = pathOf(input);
  if (!path || !result || typeof result.content !== "string") return false;
  if (input.view_range !== undefined || input.range !== undefined) return false;
  const text = stripViewNumbering(result.content);
  if (text === undefined) return false;
  call.images.set(toRelative(path, call.cwd), { text, source: "view_result" });
  return true;
}

// ─── Completion → rows ───────────────────────────────────────────────

/**
 * Rows for a SUCCESSFUL completion of a mutating or shell tool. The
 * caller has already decided the completion succeeded; failures never
 * reach here.
 */
export async function fileChangesForCompletion(
  call: FileToolCall,
  result: CopilotToolResult | undefined,
  shellInfo: CopilotShellToolInfo | undefined,
): Promise<FileChange[]> {
  const tool = call.toolName.toLowerCase();
  if (SHELL_TOOLS.has(tool)) return shellRows(call, shellInfo);
  const op = MUTATING_TOOLS.get(tool);
  if (!op) return [];
  const input = inputRecord(call.rawInput);
  const path = pathOf(input);
  if (!path) return [];
  const relPath = toRelative(path, call.cwd);
  const detailed =
    result?.detailedContent !== undefined && isUnifiedDiff(result.detailedContent)
      ? rewriteDiffHeaders(result.detailedContent, path, relPath)
      : undefined;
  const hunks = detailed ? hunkCounts(detailed) : undefined;

  if (op === "create") {
    const text = createContentOf(input);
    if (text === undefined) {
      return [await materialize(call, { path: relPath, op, sequence: 0, partial: true })];
    }
    const added = lineCount(text);
    const notes: Record<string, unknown> = {};
    if (hunks) notes.hunk_check = hunks.added === added && hunks.removed === 0 ? "ok" : "mismatch";
    const row = await materialize(call, {
      path: relPath,
      op,
      sequence: 0,
      partial: false,
      after: text,
      patchText: detailed ?? (text.length <= DIFF_INPUT_CAP_BYTES ? diffLines("", text).unified : undefined),
      linesAdded: added,
      linesRemoved: 0,
      notes,
    });
    call.images.set(relPath, { text, source: "session_chain" });
    return [row];
  }

  if (op === "delete") {
    const row = await materialize(call, { path: relPath, op, sequence: 0, partial: true });
    call.images.invalidate(relPath);
    return [row];
  }

  // modify
  const oldStr = oldStrOf(input);
  const newStr = newStrOf(input);
  if (oldStr === undefined || newStr === undefined) {
    // apply_patch / insert style inputs we don't model: fact-only stub
    // with the CLI's own diff when it shipped one.
    const row = await materialize(call, {
      path: relPath,
      op,
      sequence: 0,
      partial: true,
      patchText: detailed,
      linesAdded: hunks?.added ?? 0,
      linesRemoved: hunks?.removed ?? 0,
      notes: { before_source: "none", before_miss: "unmodeled-input" },
    });
    call.images.invalidate(relPath);
    return [row];
  }

  const known = call.images.get(relPath);
  let miss: string | undefined;
  if (!known) miss = "no-prior-image";
  else if (oldStr.length === 0) miss = "old_str-empty";
  else {
    const n = countOccurrences(known.text, oldStr);
    if (n === 0) miss = "old_str-not-found";
    else if (n > 1) miss = "old_str-ambiguous";
    else if (known.text.length + newStr.length > DIFF_INPUT_CAP_BYTES) miss = "size-cap";
  }

  if (known && miss === undefined) {
    const before = known.text;
    const after = before.replace(oldStr, () => newStr);
    const d = diffLines(before, after);
    const hunkOk = !hunks || (hunks.added === d.stats.added && hunks.removed === d.stats.removed);
    if (hunkOk) {
      const row = await materialize(call, {
        path: relPath,
        op,
        sequence: 0,
        partial: false,
        before,
        after,
        patchText: detailed ?? d.unified,
        linesAdded: d.stats.added,
        linesRemoved: d.stats.removed,
        notes: {
          before_source: known.source,
          hunk_check: hunks ? "ok" : "unavailable",
        },
      });
      call.images.set(relPath, { text: after, source: "session_chain" });
      return [row];
    }
    miss = "hunk-mismatch";
  }

  // Degraded: the edit's own old/new strings still give an honest
  // partial row; the CLI's hunks (when present) are authoritative for
  // the counts because they describe what was actually written.
  let patchText: string | undefined = detailed;
  let linesAdded = hunks?.added;
  let linesRemoved = hunks?.removed;
  if (patchText === undefined || linesAdded === undefined || linesRemoved === undefined) {
    if (oldStr.length + newStr.length <= DIFF_INPUT_CAP_BYTES) {
      const d = diffLines(oldStr, newStr);
      patchText ??= d.unified || undefined;
      linesAdded ??= d.stats.added;
      linesRemoved ??= d.stats.removed;
    } else {
      linesAdded ??= newStr.split(/\r?\n/).length;
      linesRemoved ??= oldStr.split(/\r?\n/).length;
    }
  }
  const row = await materialize(call, {
    path: relPath,
    op,
    sequence: 0,
    partial: true,
    patchText,
    linesAdded,
    linesRemoved,
    notes: {
      before_source: "none",
      before_miss: miss,
      ...(known ? { before_rejected: known.source } : {}),
      ...(hunks && miss === "hunk-mismatch" ? { hunk_check: "mismatch" } : {}),
    },
  });
  // Whatever we knew about this path is now stale.
  call.images.invalidate(relPath);
  return [row];
}

/** Partial stub(s) for a mutating/shell start that never completed. */
export async function fileChangesForMissingCompletion(
  call: FileToolCall,
): Promise<FileChange[]> {
  const tool = call.toolName.toLowerCase();
  const input = inputRecord(call.rawInput);
  if (SHELL_TOOLS.has(tool)) {
    return [
      await materialize(call, {
        path: "(shell)",
        op: "modify",
        sequence: 0,
        partial: true,
        notes: { completion: "missing" },
      }),
    ];
  }
  const op = MUTATING_TOOLS.get(tool);
  if (!op) return [];
  const path = pathOf(input);
  if (!path) return [];
  const relPath = toRelative(path, call.cwd);
  // Line counts from the inputs alone — the outcome is unknown, so no
  // blobs and no chain update.
  let linesAdded = 0;
  let linesRemoved = 0;
  let patchText: string | undefined;
  const oldStr = oldStrOf(input);
  const newStr = newStrOf(input);
  const createText = createContentOf(input);
  if (op === "modify" && oldStr !== undefined && newStr !== undefined) {
    if (oldStr.length + newStr.length <= DIFF_INPUT_CAP_BYTES) {
      const d = diffLines(oldStr, newStr);
      patchText = d.unified || undefined;
      linesAdded = d.stats.added;
      linesRemoved = d.stats.removed;
    } else {
      linesAdded = newStr.split(/\r?\n/).length;
      linesRemoved = oldStr.split(/\r?\n/).length;
    }
  } else if (op === "create" && createText !== undefined) {
    linesAdded = lineCount(createText);
  }
  call.images.invalidate(relPath);
  return [
    await materialize(call, {
      path: relPath,
      op,
      sequence: 0,
      partial: true,
      patchText,
      linesAdded,
      linesRemoved,
      notes: { completion: "missing", before_source: "none" },
    }),
  ];
}

// ─── Shell ───────────────────────────────────────────────────────────

/** Commands that rewrite files in place or move the tree under us —
 *  after one of these, every known image among its possiblePaths is
 *  suspect and gets dropped (conservative: a false drop only costs a
 *  before-image; a stale image would fabricate one). */
const MUTATING_SHELL_RE =
  /(?:^|[\s;&|(])(?:sed\s+-[a-zA-Z]*i|perl\s+-[a-zA-Z]*i|tee|mv|rm|cp|truncate|dd|git\s+(?:checkout|restore|stash|reset|merge|rebase|pull|apply|cherry-pick|revert))(?:\s|$)/;

async function shellRows(
  call: FileToolCall,
  shellInfo: CopilotShellToolInfo | undefined,
): Promise<FileChange[]> {
  const input = inputRecord(call.rawInput);
  const cmd = typeof input.command === "string" ? input.command : "";
  const mutating = shellInfo?.hasWriteFileRedirection === true || MUTATING_SHELL_RE.test(cmd);
  if (mutating && shellInfo) {
    for (const p of shellInfo.possiblePaths) call.images.invalidate(toRelative(p, call.cwd));
  }
  const targets = shellWriteTargets(cmd, shellInfo);
  if (targets.length === 0) {
    return [await materialize(call, { path: "(shell)", op: "modify", sequence: 0, partial: true })];
  }
  const rows: FileChange[] = [];
  for (const [i, t] of targets.entries()) {
    const rel = toRelative(t, call.cwd);
    call.images.invalidate(rel);
    rows.push(
      await materialize(call, {
        path: rel,
        op: "modify",
        sequence: i,
        partial: true,
        notes: { shell: "write-redirection" },
      }),
    );
  }
  return rows;
}

const REDIRECT_RE =
  /(?:^|[^<>&\d])(?:\d*|&)>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/g;

/**
 * Redirect targets the command writes to, confirmed against the CLI's
 * own `possiblePaths` (both signals must agree — the CLI's list also
 * contains subcommands, pids and ports, and our regex cannot see
 * through quoting edge cases). Empty unless the CLI flagged a write
 * redirection.
 */
export function shellWriteTargets(
  cmd: string,
  shellInfo: CopilotShellToolInfo | undefined,
): string[] {
  if (!shellInfo?.hasWriteFileRedirection || shellInfo.possiblePaths.length === 0) return [];
  const out: string[] = [];
  for (const m of cmd.matchAll(REDIRECT_RE)) {
    const target = m[1] ?? m[2] ?? m[3];
    if (!target || target.startsWith("&") || target === "/dev/null") continue;
    const hit = shellInfo.possiblePaths.find(
      (p) => p === target || p.endsWith(`/${target}`),
    );
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

// ─── Unified-diff helpers ────────────────────────────────────────────

/** Copilot writes `diff --git a/<abs> b/<abs>` headers; the row's path
 *  is repo-relative, so the stored patch's headers should be too. Only
 *  header lines are touched — body lines are the file's own content. */
export function rewriteDiffHeaders(diff: string, abs: string, rel: string): string {
  // toRelative only changes absolute inputs, so abs starts with "/" here
  // and `a/<abs>` → `a/<rel>` keeps the git prefix's slash.
  if (abs === rel || !abs.startsWith("/")) return diff;
  return diff
    .split("\n")
    .map((line) =>
      line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")
        ? line.split(abs).join(`/${rel}`)
        : line,
    )
    .join("\n");
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

export function isUnifiedDiff(s: string): boolean {
  return HUNK_HEADER_RE.test(s);
}

/** +/- line totals over every hunk of a unified diff. */
export function hunkCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

// ─── Materialization ─────────────────────────────────────────────────

interface RowSpec {
  path: string;
  op: FileOp;
  sequence: number;
  partial: boolean;
  before?: string;
  after?: string;
  patchText?: string;
  linesAdded?: number;
  linesRemoved?: number;
  notes?: Record<string, unknown>;
}

/** Compiled once — the sensitive-path set is a shipped constant. */
const SENSITIVE_MATCHER = IgnoreMatcher.fromLines([...SENSITIVE_METERBILITYIGNORE]);

async function materialize(call: FileToolCall, spec: RowSpec): Promise<FileChange> {
  const base = {
    file_change_id: `fc_${hashJson([call.step.step_id, spec.path, call.callId])}`,
    run_id: call.runId,
    step_id: call.step.step_id,
    sequence: spec.sequence,
    tool_call_id: call.callId,
    derived_from: "tool_call" as const,
    path: spec.path,
    op: spec.op,
    gitignored: false,
    bom: false,
    source_tool_name: call.toolName,
    created_at: call.step.timestamp,
  };
  // Sensitive-path suppression (mirrors the Claude Code adapter): record
  // the FACT of the change but never its contents — no blobs, no
  // patch, no tool-input echo (a create's input carries the whole file).
  if (spec.path !== "(shell)" && SENSITIVE_MATCHER.matches(spec.path, false)) {
    return {
      ...base,
      partial_diff: true,
      size_before: spec.before !== undefined ? Buffer.byteLength(spec.before) : undefined,
      size_after: spec.after !== undefined ? Buffer.byteLength(spec.after) : undefined,
      lines_added: 0,
      lines_removed: 0,
      source_tool_input: undefined,
      redacted: true,
      normalizer_notes: { ...(spec.notes ?? {}), redacted_reason: "sensitive-path" },
    };
  }

  let redacted = false;
  const scrub = (s: string | undefined): Buffer | undefined => {
    if (s === undefined) return undefined;
    const r = redactString(s);
    redacted ||= r.redactions.length > 0;
    return Buffer.from(r.text, "utf-8");
  };
  const policy = enforceFileSizePolicy({
    beforeBuf: scrub(spec.before),
    afterBuf: scrub(spec.after),
  });
  // Buffers are already scrubbed — skip the blob store's second pass.
  const before_blob_ref = policy.beforeBuf
    ? await call.blobs.putString(policy.beforeBuf.toString("utf-8"), { skipRedact: true })
    : undefined;
  const after_blob_ref = policy.afterBuf
    ? await call.blobs.putString(policy.afterBuf.toString("utf-8"), { skipRedact: true })
    : undefined;
  const partial = spec.partial || policy.partial_diff || policy.redacted;

  let patch_text: string | undefined;
  if (spec.patchText !== undefined && !policy.redacted && spec.patchText.length <= PATCH_TEXT_CAP_BYTES) {
    const r = redactString(spec.patchText);
    redacted ||= r.redactions.length > 0;
    patch_text = r.text || undefined;
  }
  const toolInput = redactToolInputVerbose(call.rawInput);
  redacted ||= toolInput.redacted;

  const notes = { ...(spec.notes ?? {}) };
  if (policy.partial_diff || policy.redacted) notes.size_policy = policy.redacted ? "skip" : "partial";

  return {
    ...base,
    before_blob_ref,
    after_blob_ref,
    partial_diff: partial,
    patch_text,
    patch_format: patch_text ? "unified" : undefined,
    size_before: policy.size_before,
    size_after: policy.size_after,
    line_count_before: spec.before !== undefined ? lineCount(spec.before) : undefined,
    line_count_after: spec.after !== undefined ? lineCount(spec.after) : undefined,
    lines_added: policy.redacted ? 0 : (spec.linesAdded ?? 0),
    lines_removed: policy.redacted ? 0 : (spec.linesRemoved ?? 0),
    source_tool_input: toolInput.value,
    redacted,
    ...(Object.keys(notes).length > 0 ? { normalizer_notes: notes } : {}),
  };
}

// ─── Input helpers ───────────────────────────────────────────────────

function inputRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function pathOf(input: Record<string, unknown>): string | undefined {
  return firstString(input.path, input.file_path, input.filePath, input.filename, input.target);
}

function oldStrOf(input: Record<string, unknown>): string | undefined {
  return firstStringAllowEmpty(input.old_str, input.oldText, input.old_string);
}

function newStrOf(input: Record<string, unknown>): string | undefined {
  return firstStringAllowEmpty(input.new_str, input.newText, input.new_string);
}

function createContentOf(input: Record<string, unknown>): string | undefined {
  return firstStringAllowEmpty(input.file_text, input.content, input.text);
}

/** Lines in a text the way `wc -l`/git count them: a trailing newline
 *  does not open an extra empty line; "" is 0 lines. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const parts = text.split(/\r?\n/);
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    if (n > 1) break;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function toRelative(p: string, cwd?: string): string {
  // FileChange.path is repo-relative by contract. When the session's
  // workspace cwd is known (workspace.yaml), absolute paths under it
  // relativize properly ("/repo/src/x.ts" → "src/x.ts"); otherwise we
  // strip a leading slash rather than guess a root.
  if (cwd && cwd.startsWith("/")) {
    const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (p.startsWith(root)) return p.slice(root.length);
    if (p === cwd || p === root) return ".";
  }
  return p.startsWith("/") ? p.slice(1) : p;
}

export function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function firstStringAllowEmpty(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Redact tool inputs before they land in steps.action_json /
 *  file_change.source_tool_input (matches the v0.5.1 inline-capture
 *  convention). Structure survives; string payloads run through
 *  redactString. `redacted` reports whether any replacement actually
 *  happened — consumers surface it honestly (FileChange.redacted). */
export function redactToolInputVerbose(input: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (input === undefined || input === null) return { value: undefined, redacted: false };
  let raw: string;
  try {
    raw = JSON.stringify(input);
  } catch {
    return { value: undefined, redacted: false };
  }
  if (raw === undefined) return { value: undefined, redacted: false };
  const { text, redactions } = redactString(raw);
  const redacted = redactions.length > 0;
  try {
    return { value: JSON.parse(text), redacted };
  } catch {
    return { value: text, redacted };
  }
}
