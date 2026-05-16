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
 * v0.3 file-history-snapshot record (SPEC §3.4). Claude Code writes
 * one of these immediately before each modifying assistant turn — the
 * `trackedFileBackups` map names a backup blob per file the turn is
 * about to touch.
 *
 * `messageId` points at the assistant message that will follow. We use
 * it to attribute the captured pre-edit bytes to a specific Step.
 *
 * `backupFileName: null` means "this file did not previously exist"
 * (i.e., the upcoming `op` is `create`). Non-null is the SHA Claude
 * chose at backup time; the file lives at
 * `<claudeFileHistoryDir>/<backupFileName>`.
 */
export interface ClaudeFileHistorySnapshotRecord extends ClaudeRecordBase {
  type: "file-history-snapshot";
  messageId: string;
  trackedFileBackups: Record<string, { backupFileName: string | null }>;
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
