import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange, FileOp } from "@spool/shared";
import { claudeFileHistoryDir } from "@spool/shared";
import type { ParsedRecord } from "./parser.ts";
import {
  isAssistant,
  isFileHistorySnapshot,
  type ClaudeContentBlock,
  type ClaudeFileHistorySnapshotRecord,
} from "./types.ts";
import { diffLines } from "./diff.ts";
import { isProbablyText } from "@spool/collector";

/**
 * v0.3 Track A — Claude Code file-history-snapshot parser.
 *
 * Implements the algorithm in SPEC §3.4. Pulls one or more FileChange
 * events out of every modifying assistant turn, using the JSONL
 * `file-history-snapshot` records to recover the pre-edit bytes from
 * `~/.claude/file-history/<session-uuid>/<backupFileName>`.
 *
 * What gets captured (full fidelity, blob refs both sides):
 *   - `Edit` (str_replace on one file)
 *   - `MultiEdit` (N str_replaces on one file, atomic)
 *   - `Write` (full overwrite or new file creation)
 *
 * What gets captured as partial (`partial_diff = true`, no blob refs):
 *   - `Bash` — shell side effects need the v0.4 file-watcher to capture
 *   - `NotebookEdit` — v0.3 doesn't do cell-structural diffs; flagged
 *     to surface in the UI alongside a docs pointer
 *
 * What we deliberately skip (no row):
 *   - Read-only tools (`Read`, `Glob`, `Grep`, etc.) — they don't
 *     mutate the working tree, so they have no FileChange surface.
 *
 * Sub-agent (`Task`) attribution: the sub-agent's own
 * `agent-<shortId>.jsonl` is NOT parsed in v0.3 (the spec defers this
 * to v0.5+ when sub-agents become first-class). The parent Task step
 * is captured as a tool_call action; any file changes the sub-agent
 * made are invisible in v0.3.
 *
 * Bug-surface defenses (each one observed in upstream Claude Code
 * issues — see SPEC §3.4):
 *
 *   1. `file-history-snapshot.messageId` occasionally collides with a
 *      real message `uuid`. We always discriminate by record `type`
 *      first via `isFileHistorySnapshot`. Never key into the snapshot
 *      map by `messageId` and trust the result.
 *
 *   2. The first JSONL line is nondeterministic. Our generator iterates
 *      the entire record stream; we never key off `records[0]`.
 *
 *   3. Snapshot bloat: handled by the blob store's content-addressed
 *      dedup. A backup file that appears in 50 consecutive snapshots
 *      gets stored once.
 *
 *   4. Backup file missing / cleaned up by Claude: we emit a FileChange
 *      with `partial_diff = true` and `before_blob_ref = undefined`
 *      rather than dropping the row entirely. The UI surfaces the
 *      partial flag so the user knows what's missing.
 */

/** Mapping of (sessionId, backupFileName) → bytes. Tests inject a
 *  pure-in-memory implementation; the real one reads from
 *  `~/.claude/file-history/<sessionId>/<backupFileName>`. */
export type BackupReader = (
  sessionId: string,
  backupFileName: string,
) => Promise<Buffer | undefined>;

export const fsBackupReader: BackupReader = async (
  sessionId,
  backupFileName,
) => {
  try {
    return await readFile(join(claudeFileHistoryDir(sessionId), backupFileName));
  } catch {
    return undefined;
  }
};

/** Minimal blob-store surface this module needs — keeps the test seam
 *  small and avoids dragging the whole Store into pure logic. */
export interface BlobSink {
  putBuffer(buf: Buffer, opts?: { skipRedact?: boolean }): Promise<string>;
  putString(s: string, opts?: { skipRedact?: boolean }): Promise<string>;
}

export interface ExtractArgs {
  records: ParsedRecord[];
  /** Lookup from the assistant message uuid to the inserted Step row.
   *  The extractor needs `step_id` to populate FileChange.step_id, and
   *  `sequence` is included for sanity-checking. */
  stepByAssistantUuid: Map<string, { step_id: string; sequence: number }>;
  /** `run.run_id` — every emitted FileChange is scoped to this. */
  runId: string;
  /** Run's cwd, used to convert tool-input absolute paths to repo-
   *  relative POSIX paths. */
  cwd: string;
  /** Session id used to resolve the file-history directory. */
  sessionId: string;
  blobs: BlobSink;
  readBackup?: BackupReader;
}

/**
 * The FileChange payload shape inserted via collector's
 * `insertFileChange`. We omit `file_change_id` + `created_at` so the
 * collector helper generates them.
 */
export type FileChangeInsert = Omit<
  FileChange,
  "file_change_id" | "created_at"
>;

/**
 * Walk the records, find every modifying assistant turn that we have
 * a matching Step for, and emit one or more FileChange rows per turn.
 *
 * Pure-ish — only IO is `blobs.putBuffer` (write captured bytes) and
 * `readBackup` (read pre-edit bytes from Claude's file-history). All
 * other state lives in the records + the stepByAssistantUuid map the
 * caller pre-builds from inserted Steps.
 */
export async function extractFileChanges(
  args: ExtractArgs,
): Promise<FileChangeInsert[]> {
  const { records, stepByAssistantUuid, runId, cwd, sessionId, blobs } = args;
  const readBackup = args.readBackup ?? fsBackupReader;

  // Build messageId → snapshot index. Discriminator-first per defense
  // #1: only records whose `type === "file-history-snapshot"` get
  // indexed, so a regular assistant uuid that happens to match a
  // snapshot's messageId can never be misinterpreted.
  const snapshotByMessageId = new Map<string, ClaudeFileHistorySnapshotRecord>();
  for (const { record } of records) {
    if (!isFileHistorySnapshot(record)) continue;
    if (record.messageId) snapshotByMessageId.set(record.messageId, record);
  }

  const out: FileChangeInsert[] = [];

  for (const { record } of records) {
    if (!isAssistant(record)) continue;
    const assistantUuid = record.uuid;
    if (!assistantUuid) continue;
    const step = stepByAssistantUuid.get(assistantUuid);
    if (!step) continue; // step builder collapsed this — fine, skip

    const blocks = arrayContent(record.message);
    const snapshot = snapshotByMessageId.get(assistantUuid);

    // Intra-step sequence — UNIQUE(step_id, sequence) in the schema.
    // We reset per step and increment for every emitted row regardless
    // of tool kind. Order: tool_use blocks in the order they appear in
    // the assistant message.
    let sequence = 0;

    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const generated = await extractForToolUse({
        toolUse: block,
        snapshot,
        runId,
        stepId: step.step_id,
        startingSequence: sequence,
        cwd,
        sessionId,
        blobs,
        readBackup,
      });
      sequence += generated.length;
      out.push(...generated);
    }
  }

  return out;
}

interface PerToolArgs {
  toolUse: Extract<ClaudeContentBlock, { type: "tool_use" }>;
  snapshot: ClaudeFileHistorySnapshotRecord | undefined;
  runId: string;
  stepId: string;
  startingSequence: number;
  cwd: string;
  sessionId: string;
  blobs: BlobSink;
  readBackup: BackupReader;
}

async function extractForToolUse(
  args: PerToolArgs,
): Promise<FileChangeInsert[]> {
  const { toolUse, runId, stepId } = args;
  const tool = toolUse.name;

  // Bash: most commands are opaque to us (the command could `touch`,
  // `mv`, `npm install`, ...), so by default we emit ONE stub per Bash
  // call so the Files tab can surface "this step ran shell, contents
  // not captured" without faking a path.
  //
  // Narrow exception: pure `rm <path>` invocations. These are the most
  // common way an agent deletes a file via Bash, and the user-visible
  // win is high — without this, the Files tab silently swallows the
  // delete (just a generic shell stub) and never shows `-N` lines
  // removed even when we have the pre-delete bytes in a backup.
  //
  // Detection is conservative: `parseRmCommand` returns non-null ONLY
  // when the entire command is a pure `rm` with literal paths (no
  // chaining, no globs, no var expansion). Any uncertainty → fall back
  // to the (shell) stub. False negatives are silent + safe; false
  // positives would invent delete rows.
  if (tool === "Bash") {
    return await extractBash(args);
  }

  // NotebookEdit: v0.3 doesn't ship cell-structural diffs (spec open
  // question #4: deferred to v0.4). The path is in tool_input but the
  // edit semantics need a Jupyter-aware diff — stub for now.
  if (tool === "NotebookEdit") {
    const path = toRepoRelative(
      String(toolUse.input.notebook_path ?? "(notebook)"),
      args.cwd,
    );
    return [
      makeStub({
        runId,
        stepId,
        sequence: args.startingSequence,
        toolCallId: toolUse.id,
        path,
        sourceToolName: "NotebookEdit",
        sourceToolInput: toolUse.input,
        patchFormat: "notebook_cell",
      }),
    ];
  }

  if (tool === "Write") {
    return await extractWrite(args);
  }
  if (tool === "Edit") {
    return await extractEdit(args);
  }
  if (tool === "MultiEdit") {
    return await extractMultiEdit(args);
  }

  // Any other tool (Read, Glob, Grep, Task, etc.): no FileChange row.
  return [];
}

// ─── Per-tool extractors ─────────────────────────────────────────────

async function extractWrite(args: PerToolArgs): Promise<FileChangeInsert[]> {
  const input = args.toolUse.input as { file_path?: string; content?: string };
  const absPath = input.file_path;
  if (!absPath) return [];
  const path = toRepoRelative(absPath, args.cwd);
  const afterText = input.content ?? "";
  const backup = await readBackupForPath(args, absPath);
  const isNew = backup === undefined;
  const op: FileOp = isNew ? "create" : "modify";

  const beforeBuf = backup;
  const afterBuf = Buffer.from(afterText, "utf-8");
  return [
    await materialize({
      args,
      path,
      op,
      beforeBuf,
      afterBuf,
      tool: "Write",
    }),
  ];
}

async function extractEdit(args: PerToolArgs): Promise<FileChangeInsert[]> {
  const input = args.toolUse.input as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
  };
  const absPath = input.file_path;
  if (!absPath || input.old_string === undefined || input.new_string === undefined) {
    return [];
  }
  const path = toRepoRelative(absPath, args.cwd);
  const backup = await readBackupForPath(args, absPath);
  if (backup === undefined) {
    // No backup. Emit a partial — the existence of the Edit is real,
    // we just can't reconstruct the bytes.
    return [
      makeStub({
        runId: args.runId,
        stepId: args.stepId,
        sequence: args.startingSequence,
        toolCallId: args.toolUse.id,
        path,
        sourceToolName: "Edit",
        sourceToolInput: input,
      }),
    ];
  }
  const beforeText = backup.toString("utf-8");
  const afterText = applyEdit(beforeText, input.old_string, input.new_string);
  if (afterText === undefined) {
    // The Edit's `old_string` didn't match — Claude Code refused this
    // edit too, so no actual change occurred. No row.
    return [];
  }
  const afterBuf = Buffer.from(afterText, "utf-8");
  return [
    await materialize({
      args,
      path,
      op: "modify",
      beforeBuf: backup,
      afterBuf,
      tool: "Edit",
    }),
  ];
}

async function extractMultiEdit(
  args: PerToolArgs,
): Promise<FileChangeInsert[]> {
  const input = args.toolUse.input as {
    file_path?: string;
    edits?: Array<{ old_string: string; new_string: string }>;
  };
  const absPath = input.file_path;
  if (!absPath || !Array.isArray(input.edits) || input.edits.length === 0) {
    return [];
  }
  const path = toRepoRelative(absPath, args.cwd);
  const backup = await readBackupForPath(args, absPath);
  if (backup === undefined) {
    return [
      makeStub({
        runId: args.runId,
        stepId: args.stepId,
        sequence: args.startingSequence,
        toolCallId: args.toolUse.id,
        path,
        sourceToolName: "MultiEdit",
        sourceToolInput: input,
      }),
    ];
  }
  let current = backup.toString("utf-8");
  for (const edit of input.edits) {
    const next = applyEdit(current, edit.old_string, edit.new_string);
    if (next === undefined) {
      // A later edit didn't match. MultiEdit is atomic — Claude would
      // have rejected the whole thing. So no captured row.
      return [];
    }
    current = next;
  }
  return [
    await materialize({
      args,
      path,
      op: "modify",
      beforeBuf: backup,
      afterBuf: Buffer.from(current, "utf-8"),
      tool: "MultiEdit",
    }),
  ];
}

async function extractBash(args: PerToolArgs): Promise<FileChangeInsert[]> {
  const input = args.toolUse.input as { command?: string };
  const cmd = typeof input.command === "string" ? input.command : "";
  const targets = parseRmCommand(cmd);

  // Not a pure `rm` — fall back to the historic single (shell) stub.
  if (targets === null) {
    return [
      makeStub({
        runId: args.runId,
        stepId: args.stepId,
        sequence: args.startingSequence,
        toolCallId: args.toolUse.id,
        path: "(shell)",
        sourceToolName: "Bash",
        sourceToolInput: args.toolUse.input,
      }),
    ];
  }

  // Pure `rm` with N path arguments. One row per target, in argument
  // order. If the path was previously tracked in a file-history-snapshot
  // we can recover bytes and emit a real -N delete row; otherwise we
  // emit a path-aware delete stub (the intent is captured even if the
  // contents aren't).
  //
  // We deliberately do NOT also emit the generic (shell) stub here —
  // for a pure `rm`, the per-target rows fully describe the side
  // effects, so adding a (shell) row would just be duplicate noise.
  const rows: FileChangeInsert[] = [];
  let seq = args.startingSequence;
  for (const target of targets) {
    const absPath = resolveBashTarget(target, args.cwd);
    const path = toRepoRelative(absPath, args.cwd);
    const backup = await readBackupForPath(args, absPath);
    if (backup === undefined) {
      // No backup → can't recover bytes. Emit a delete-op stub so the
      // intent shows up in the Files tab; lines_removed stays 0 because
      // we genuinely don't know N.
      rows.push(
        makeStub({
          runId: args.runId,
          stepId: args.stepId,
          sequence: seq,
          toolCallId: args.toolUse.id,
          path,
          sourceToolName: "Bash",
          sourceToolInput: args.toolUse.input,
          op: "delete",
        }),
      );
    } else {
      rows.push(
        await materialize({
          args,
          path,
          op: "delete",
          beforeBuf: backup,
          afterBuf: undefined,
          tool: "Bash",
        }),
      );
    }
    seq++;
  }
  return rows;
}

/**
 * Parse a Bash command string. Returns the list of file path arguments
 * iff the command is a pure `rm` invocation with literal paths. Returns
 * `null` for anything else — compound commands, globs, variable
 * expansion, command substitution, or non-`rm` commands. The caller
 * treats `null` as "fall back to the generic shell stub."
 *
 * Conservative on purpose: false positives would invent delete rows for
 * files that weren't actually deleted. False negatives just degrade to
 * the existing (shell) stub — safe.
 *
 * Exported for direct unit testing.
 */
export function parseRmCommand(cmd: string): string[] | null {
  const trimmed = cmd.trim();
  if (trimmed === "") return null;

  // Reject anything with shell metacharacters that could mean "more
  // than one command" or "expand into something we can't see." We err
  // on the side of rejecting — even inside quotes, since a string like
  // `rm "foo;bar"` is rare in agent traffic and not worth the risk of
  // mis-parsing related patterns like `rm foo; rm bar`.
  if (/[;&|<>`$()*?[\]{}~\n\r]/.test(trimmed)) return null;

  // Tokenize on whitespace, honoring single + double quotes. No escape
  // processing beyond removing the quote characters — the metachar
  // guard above already rejected anything that would need it.
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    if (i >= trimmed.length) break;
    let tok = "";
    while (i < trimmed.length && !/\s/.test(trimmed[i]!)) {
      const ch = trimmed[i]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < trimmed.length && trimmed[i] !== quote) {
          tok += trimmed[i]!;
          i++;
        }
        if (i >= trimmed.length) return null; // unterminated quote
        i++; // skip closing quote
      } else {
        tok += ch;
        i++;
      }
    }
    tokens.push(tok);
  }

  if (tokens.length === 0) return null;
  if (tokens[0] !== "rm") return null;

  // Split flags from path operands. `--` terminates flag parsing.
  const paths: string[] = [];
  let endOfFlags = false;
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (!endOfFlags && t === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && t.startsWith("-") && t.length > 1) {
      // Flag token. We don't validate which flags — `rm -rf`, `rm -f`,
      // `rm -R`, etc. all work. We only care about the path operands.
      continue;
    }
    paths.push(t);
  }

  if (paths.length === 0) return null;
  return paths;
}

/**
 * Resolve a `rm` argument to an absolute path. Absolute inputs are
 * kept as-is (minus any trailing slash, so directory-form lookups in
 * trackedFileBackups still hit a file-keyed entry). Relative inputs
 * are resolved against the session's cwd.
 */
function resolveBashTarget(arg: string, cwd: string): string {
  const stripped = arg.replace(/\/+$/, "") || "/";
  if (stripped.startsWith("/")) return stripped;
  const base = cwd.replace(/\/+$/, "");
  return `${base}/${stripped}`;
}

// ─── Materialization helpers ─────────────────────────────────────────

interface MaterializeArgs {
  args: PerToolArgs;
  path: string;
  op: FileOp;
  beforeBuf: Buffer | undefined;
  afterBuf: Buffer | undefined;
  tool: string;
}

async function materialize(m: MaterializeArgs): Promise<FileChangeInsert> {
  const { args, path, op, beforeBuf, afterBuf, tool } = m;
  // A side counts as "text" if it doesn't exist (we treat the missing
  // side as an empty file for diff purposes) OR if it passes the
  // null-byte heuristic from PR 1. We can run a text diff iff at
  // least one side actually has bytes AND every present side is text.
  //
  // This is the key fix vs the original Turn 4 code: that version
  // gated on `bothText` (both sides present + text), which meant
  // creates (no beforeBuf) and deletes (no afterBuf) always reported
  // +0 −0 instead of +N or −N. The user noticed when a new file
  // captured via Write showed up in the Files tab with zero counts.
  const beforeIsText =
    beforeBuf === undefined || isProbablyText(beforeBuf);
  const afterIsText =
    afterBuf === undefined || isProbablyText(afterBuf);
  const canTextDiff =
    (beforeBuf !== undefined || afterBuf !== undefined) &&
    beforeIsText &&
    afterIsText;

  // Write blobs. `skipRedact: false` is the default — text blobs
  // route through the redaction pass; binary auto-skips per PR 1.
  const before_blob_ref = beforeBuf
    ? await args.blobs.putBuffer(beforeBuf)
    : undefined;
  const after_blob_ref = afterBuf
    ? await args.blobs.putBuffer(afterBuf)
    : undefined;

  let patch_text: string | undefined;
  let lines_added = 0;
  let lines_removed = 0;
  let patch_format: FileChangeInsert["patch_format"];
  if (canTextDiff) {
    // Missing-side → "" gives correct +N/-0 (create) and +0/-N
    // (delete). diffLines short-circuits when either side is empty,
    // so this is the same hot path for modify-both-text.
    const beforeStr = beforeBuf ? beforeBuf.toString("utf-8") : "";
    const afterStr = afterBuf ? afterBuf.toString("utf-8") : "";
    const diff = diffLines(beforeStr, afterStr);
    patch_text = diff.unified || undefined;
    lines_added = diff.stats.added;
    lines_removed = diff.stats.removed;
    patch_format = patch_text ? "unified" : undefined;
  } else if (beforeBuf || afterBuf) {
    // At least one side exists and is binary — no patch text but the
    // row still records the op, blob refs, and size delta.
    patch_format = "binary";
  }

  // For line-endings, sniff whichever side has bytes (after wins
  // when both exist — the agent just wrote it). For line counts and
  // encoding, prefer the side that's present and text.
  const lineEndingsBuf = afterBuf ?? beforeBuf;
  return {
    run_id: args.runId,
    step_id: args.stepId,
    sequence: args.startingSequence,
    tool_call_id: args.toolUse.id,
    derived_from: "tool_call",
    path,
    op,
    before_blob_ref,
    after_blob_ref,
    partial_diff: false,
    gitignored: false,
    patch_text,
    patch_format,
    encoding: canTextDiff ? "utf-8" : "binary",
    bom: false,
    line_endings:
      canTextDiff && lineEndingsBuf
        ? detectLineEndings(lineEndingsBuf)
        : undefined,
    size_before: beforeBuf?.length,
    size_after: afterBuf?.length,
    line_count_before:
      beforeBuf && beforeIsText
        ? countLines(beforeBuf.toString("utf-8"))
        : undefined,
    line_count_after:
      afterBuf && afterIsText
        ? countLines(afterBuf.toString("utf-8"))
        : undefined,
    lines_added,
    lines_removed,
    source_tool_name: tool,
    source_tool_input: args.toolUse.input,
    redacted: false,
  };
}

interface StubArgs {
  runId: string;
  stepId: string;
  sequence: number;
  toolCallId: string | undefined;
  path: string;
  sourceToolName: string;
  sourceToolInput: unknown;
  patchFormat?: FileChangeInsert["patch_format"];
  /**
   * Override the row's `op`. Defaults to "modify" — the historic stub
   * shape for "something changed, contents unknown." Pass "delete" for
   * a `rm <untracked-path>` Bash stub so the row honestly reflects
   * intent (we know it was a delete, we just don't have the bytes).
   */
  op?: FileOp;
}

function makeStub(s: StubArgs): FileChangeInsert {
  return {
    run_id: s.runId,
    step_id: s.stepId,
    sequence: s.sequence,
    tool_call_id: s.toolCallId,
    derived_from: "tool_call",
    path: s.path,
    op: s.op ?? "modify", // honest-ish default: we know there was an edit, just not what
    before_blob_ref: undefined,
    after_blob_ref: undefined,
    partial_diff: true,
    gitignored: false,
    patch_text: undefined,
    patch_format: s.patchFormat,
    bom: false,
    lines_added: 0,
    lines_removed: 0,
    source_tool_name: s.sourceToolName,
    source_tool_input: s.sourceToolInput,
    redacted: false,
  };
}

// ─── Small utilities ─────────────────────────────────────────────────

async function readBackupForPath(
  args: PerToolArgs,
  absPath: string,
): Promise<Buffer | undefined> {
  const entry = args.snapshot?.trackedFileBackups[absPath];
  if (!entry) return undefined;
  if (entry.backupFileName === null) return undefined; // file didn't exist before
  return args.readBackup(args.sessionId, entry.backupFileName);
}

/**
 * Convert an absolute path to repo-relative POSIX form. If the path
 * isn't under cwd (unusual but possible — agent edits something
 * outside the project), fall back to the absolute path so the row is
 * still meaningful.
 */
function toRepoRelative(absPath: string, cwd: string): string {
  const normCwd = cwd.replace(/\/+$/, "");
  if (absPath === normCwd) return "";
  if (absPath.startsWith(normCwd + "/")) {
    return absPath.slice(normCwd.length + 1).split("\\").join("/");
  }
  return absPath.split("\\").join("/");
}

/**
 * Apply one `old_string → new_string` substitution. Returns undefined
 * if `old_string` doesn't appear in `text` (matches Claude Code's own
 * "first match must be unique" semantics loosely — we accept first
 * match and don't enforce uniqueness here because v0.3 doesn't need
 * to reject; the recorder is the spec, not the linter).
 */
export function applyEdit(
  text: string,
  oldString: string,
  newString: string,
): string | undefined {
  const idx = text.indexOf(oldString);
  if (idx < 0) return undefined;
  return text.slice(0, idx) + newString + text.slice(idx + oldString.length);
}

function detectLineEndings(buf: Buffer): "lf" | "crlf" | "mixed" | undefined {
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) crlf += 1;
      else lf += 1;
    }
  }
  if (lf === 0 && crlf === 0) return undefined;
  if (lf > 0 && crlf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // Count the number of newline boundaries; if the file has no
  // trailing newline, the last partial line still counts.
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) n += 1;
  }
  if (text.charCodeAt(text.length - 1) !== 0x0a) n += 1;
  return n;
}

function arrayContent(
  msg: { content: string | ClaudeContentBlock[] },
): ClaudeContentBlock[] {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  return msg.content;
}
