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

export type ClaudeRecord =
  | ClaudeUserRecord
  | ClaudeAssistantRecord
  | ClaudeSystemRecord
  | (ClaudeRecordBase & { type: string });

export function isAssistant(r: ClaudeRecord): r is ClaudeAssistantRecord {
  return r.type === "assistant";
}

export function isUser(r: ClaudeRecord): r is ClaudeUserRecord {
  return r.type === "user";
}
