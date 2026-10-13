/**
 * Subset of Claude Code's JSONL session record schema that Meterbility depends
 * on. Other fields are intentionally typed as `unknown` — we want to fail
 * loudly if the shape changes underneath us rather than silently lose
 * data.
 */

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ClaudeContentBlock[];
      is_error?: boolean;
    };

export interface ClaudeMessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  model?: string;
  content: string | ClaudeContentBlock[];
  usage?: ClaudeMessageUsage;
  id?: string;
}

export interface ClaudeRecordBase {
  type: string;
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

export interface ClaudeUserRecord extends ClaudeRecordBase {
  type: "user";
  message: ClaudeMessage;
  /**
   * Claude Code's own structured view of the tool result carried by
   * this record (the `tool_result` block in `message.content` is the
   * model-facing rendering). Shape varies per tool; the file tools
   * are the ones we read — see `ClaudeFileToolUseResult`.
   */
  toolUseResult?: unknown;
}

/**
 * The `toolUseResult` Claude Code attaches to the user record that
 * carries an `Edit` / `MultiEdit` / `Write` tool_result. `originalFile`
 * is the full pre-edit file body (null when a Write created the file),
 * which makes it the most exact before-image we have — exact even when
 * a Bash command rewrote the file between two Edits in one turn, which
 * the once-per-turn file-history backup can't see.
 */
export interface ClaudeFileToolUseResult {
  filePath?: string;
  /** Write only: "create" (new file) or "update" (overwrite). */
  type?: string;
  originalFile?: string | null;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  userModified?: boolean;
}

/** Narrow an arbitrary `toolUseResult` to the file-tool shape, or undefined. */
export function asFileToolUseResult(
  value: unknown,
): ClaudeFileToolUseResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!("originalFile" in v)) return undefined;
  const of = v.originalFile;
  if (of !== null && typeof of !== "string") return undefined;
  return v as ClaudeFileToolUseResult;
}

export interface ClaudeAssistantRecord extends ClaudeRecordBase {
  type: "assistant";
  message: ClaudeMessage;
  requestId?: string;
}

export interface ClaudeSystemRecord extends ClaudeRecordBase {
  type: "system";
  subtype?: string;
  durationMs?: number;
  messageCount?: number;
}

/**
 * One tracked file's backup pointer, shared by both file-history
 * record shapes. `backupFileName: null` means the file didn't exist
 * when the turn started (the upcoming op is a `create`). Non-null is
 * the name Claude chose at backup time (`<hash>@v<N>` in current
 * builds); the bytes live at `<claudeFileHistoryDir>/<backupFileName>`.
 */
export interface ClaudeFileHistoryBackupEntry {
  backupFileName: string | null;
  version?: number;
  backupTime?: string;
  /** Absolute directory the tracked file lives in (newer builds only). */
  realParentDir?: string;
}

/**
 * v0.3 file-history-snapshot record. Claude Code emits one snapshot
 * per user turn, before any tool runs, carrying the backups it still
 * holds under `.snapshot.trackedFileBackups`. The outer `messageId`
 * gets a fresh uuid on every update, while `snapshot.messageId` is the
 * stable key — in older builds it pointed at the assistant uuid of the
 * modifying turn, in current builds it is the uuid of the user prompt
 * that opened the turn. Either way it is the id the matching
 * `file-history-delta` records cite as `snapshotMessageId`.
 *
 * Path keys in `trackedFileBackups` are repo-relative (e.g.
 * `"src/index.ts"`), not absolute, except for files outside the
 * session cwd, which are keyed by their absolute path.
 */
export interface ClaudeFileHistorySnapshotRecord extends ClaudeRecordBase {
  type: "file-history-snapshot";
  messageId: string;
  isSnapshotUpdate?: boolean;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, ClaudeFileHistoryBackupEntry>;
    timestamp?: string;
  };
}

/**
 * file-history-delta record (observed 2026-10). Current Claude Code
 * builds no longer grow the snapshot as a turn touches files; instead
 * each first touch of a path within a turn appends one delta:
 *
 *   - `messageId`         — uuid of the ASSISTANT record whose tool
 *                           call (Edit / MultiEdit / Write) first
 *                           touched `trackingPath` this turn. This is
 *                           the direct link to a Step.
 *   - `snapshotMessageId` — `snapshot.messageId` of the turn's
 *                           file-history-snapshot (the user prompt
 *                           uuid), so deltas fold into that turn's map.
 *   - `trackingPath`      — same key convention as `trackedFileBackups`.
 *   - `backup`            — the pre-turn backup pointer; null
 *                           `backupFileName` when the file was created
 *                           by this turn.
 *
 * A path gets at most one delta per turn, so a second Edit of the same
 * file in one turn has no delta of its own — its before-image has to
 * come from the first edit's after-image (see `file_changes.ts`).
 * Deltas are usually appended right after their assistant record but
 * occasionally land a line or two before it; never rely on order.
 */
export interface ClaudeFileHistoryDeltaRecord extends ClaudeRecordBase {
  type: "file-history-delta";
  messageId: string;
  snapshotMessageId: string;
  trackingPath: string;
  backup: ClaudeFileHistoryBackupEntry;
}

export type ClaudeRecord =
  | ClaudeUserRecord
  | ClaudeAssistantRecord
  | ClaudeSystemRecord
  | ClaudeFileHistorySnapshotRecord
  | ClaudeFileHistoryDeltaRecord
  | (ClaudeRecordBase & { type: string });

export function isAssistant(r: ClaudeRecord): r is ClaudeAssistantRecord {
  return r.type === "assistant";
}

export function isUser(r: ClaudeRecord): r is ClaudeUserRecord {
  return r.type === "user";
}

/**
 * Discriminator-first guard. The spec calls out that
 * `file-history-snapshot.messageId` occasionally collides with a real
 * message `uuid` — so we check `type` BEFORE we read any other field,
 * and never key off `messageId` without first confirming the record is
 * a snapshot.
 */
export function isFileHistorySnapshot(
  r: ClaudeRecord,
): r is ClaudeFileHistorySnapshotRecord {
  return r.type === "file-history-snapshot";
}

/** Discriminator-first guard for the delta shape — same rule as above. */
export function isFileHistoryDelta(
  r: ClaudeRecord,
): r is ClaudeFileHistoryDeltaRecord {
  return r.type === "file-history-delta";
}
