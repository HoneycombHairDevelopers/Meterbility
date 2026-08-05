/**
 * Codex Desktop / CLI session JSONL schema. Three top-level types live
 * inside the file; the discriminator is `type` and the per-record body
 * lives under `payload`.
 */

export interface CodexSessionMetaPayload {
  id: string;
  timestamp: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  base_instructions?: { text?: string };
  git?: {
    branch?: string;
    commit?: string;
    commit_hash?: string;
    repository_url?: string;
  };
  parent_thread_id?: string;
}

/**
 * Per-turn context record (newer CLIs only). `model` is the authoritative
 * real model id (`gpt-5.5`, `gpt-5-codex`, `o3`, ...) — session_meta only
 * carries the provider string (`"openai"`), which must never be used as a
 * model id.
 */
export interface CodexTurnContextPayload {
  model?: string;
  cwd?: string;
  effort?: string;
  sandbox_policy?: { type?: string };
  [k: string]: unknown;
}

/**
 * Cumulative + per-request token usage, from event_msg/token_count.
 * `last_token_usage` is the delta for the most recent API request;
 * `total_token_usage` is the running cumulative sum of deltas (billed
 * tokens, NOT context occupancy). `cached_input_tokens` is a subset of
 * `input_tokens`; `reasoning_output_tokens` is a subset of
 * `output_tokens`.
 */
export interface CodexTokenUsageBlock {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexTokenCountInfo {
  total_token_usage?: CodexTokenUsageBlock;
  last_token_usage?: CodexTokenUsageBlock;
  model_context_window?: number;
}

/**
 * Structured file-mutation record emitted by write-mode sessions
 * (shape pinned against a live capture, 2026-08-04). `changes` keys are
 * ABSOLUTE paths; adds carry full after-content, updates carry a unified
 * diff (no before-content), renames set move_path.
 */
export interface CodexPatchApplyEndPayload {
  type: "patch_apply_end";
  call_id?: string;
  turn_id?: string;
  stdout?: string;
  stderr?: string;
  success?: boolean;
  status?: string;
  changes?: Record<
    string,
    {
      type: "add" | "update" | "delete" | string;
      content?: string;
      unified_diff?: string;
      move_path?: string | null;
    }
  >;
}

export interface CodexResponseItemMessage {
  type: "message";
  role: "user" | "assistant";
  content: Array<
    | { type: "input_text"; text: string }
    | { type: "output_text"; text: string }
    | { type: string; [k: string]: unknown }
  >;
}

export interface CodexResponseItemFunctionCall {
  type: "function_call";
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface CodexResponseItemFunctionCallOutput {
  type: "function_call_output";
  call_id?: string;
  output?: string;
}

/**
 * Freeform tool call (newer CLIs) — `apply_patch` arrives this way, with
 * the raw V4A patch text in `input`. Joined to patch_apply_end and
 * custom_tool_call_output via `call_id`.
 */
export interface CodexResponseItemCustomToolCall {
  type: "custom_tool_call";
  id?: string;
  status?: string;
  call_id?: string;
  name?: string;
  input?: string;
  metadata?: { turn_id?: string };
}

export interface CodexResponseItemCustomToolCallOutput {
  type: "custom_tool_call_output";
  call_id?: string;
  output?: string;
}

export type CodexResponseItem =
  | CodexResponseItemMessage
  | CodexResponseItemFunctionCall
  | CodexResponseItemFunctionCallOutput
  | CodexResponseItemCustomToolCall
  | CodexResponseItemCustomToolCallOutput
  | { type: string; [k: string]: unknown };

export interface CodexEventMsgPayload {
  type: string;
  [k: string]: unknown;
}

export type CodexRecord =
  | { type: "session_meta"; timestamp?: string; payload: CodexSessionMetaPayload }
  | { type: "turn_context"; timestamp?: string; payload: CodexTurnContextPayload }
  | { type: "response_item"; timestamp?: string; payload: CodexResponseItem }
  | { type: "event_msg"; timestamp?: string; payload: CodexEventMsgPayload };

export function isResponseItem(
  r: CodexRecord,
): r is { type: "response_item"; timestamp?: string; payload: CodexResponseItem } {
  return r.type === "response_item";
}

export function isTurnContext(
  r: CodexRecord,
): r is { type: "turn_context"; timestamp?: string; payload: CodexTurnContextPayload } {
  return r.type === "turn_context";
}

export function isCustomToolCall(
  p: CodexResponseItem,
): p is CodexResponseItemCustomToolCall {
  return p.type === "custom_tool_call";
}

export function isCustomToolCallOutput(
  p: CodexResponseItem,
): p is CodexResponseItemCustomToolCallOutput {
  return p.type === "custom_tool_call_output";
}

export function isMessage(
  p: CodexResponseItem,
): p is CodexResponseItemMessage {
  return p.type === "message";
}

export function isFunctionCall(
  p: CodexResponseItem,
): p is CodexResponseItemFunctionCall {
  return p.type === "function_call";
}

export function isFunctionCallOutput(
  p: CodexResponseItem,
): p is CodexResponseItemFunctionCallOutput {
  return p.type === "function_call_output";
}

export function textOfMessage(m: CodexResponseItemMessage): string {
  return m.content
    .map((c) => {
      if (typeof c === "object" && c && "text" in c && typeof c.text === "string") {
        return c.text;
      }
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
}
