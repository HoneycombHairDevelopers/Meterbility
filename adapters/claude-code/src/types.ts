/**
 * Subset of Claude Code's JSONL session record schema that Spool depends
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
 * v0.3 file-history-snapshot record. Claude Code emits one initial
 * snapshot before each modifying turn (`isSnapshotUpdate: false`) and
 * any number of follow-up update records (`isSnapshotUpdate: true`)
 * as the turn touches more files. The captured bytes live under
 * `.snapshot.trackedFileBackups`; the outer `messageId` gets a fresh
 * uuid on every update, while `snapshot.messageId` keeps pointing at
 * the assistant uuid the turn belongs to — that's the field that
 * links a snapshot back to its Step.
 *
 * Path keys in `trackedFileBackups` are repo-relative (e.g.
 * `"src/index.ts"`), not absolute. `backupFileName: null` means the
 * file didn't exist before the turn (the upcoming op is a `create`).
 * Non-null is the SHA Claude chose at backup time; the file lives at
 * `<claudeFileHistoryDir>/<backupFileName>`.
 */
export interface ClaudeFileHistorySnapshotRecord extends ClaudeRecordBase {
  type: "file-history-snapshot";
  messageId: string;
  isSnapshotUpdate?: boolean;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<
      string,
      { backupFileName: string | null; version?: number; backupTime?: string }
    >;
    timestamp?: string;
  };
}

export type ClaudeRecord =
  | ClaudeUserRecord
  | ClaudeAssistantRecord
  | ClaudeSystemRecord
  | ClaudeFileHistorySnapshotRecord
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
