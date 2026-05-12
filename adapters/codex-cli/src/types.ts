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
  git?: { branch?: string; commit?: string };
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

export type CodexResponseItem =
  | CodexResponseItemMessage
  | CodexResponseItemFunctionCall
  | CodexResponseItemFunctionCallOutput
  | { type: string; [k: string]: unknown };

export interface CodexEventMsgPayload {
  type: string;
  [k: string]: unknown;
}

export type CodexRecord =
  | { type: "session_meta"; timestamp?: string; payload: CodexSessionMetaPayload }
  | { type: "response_item"; timestamp?: string; payload: CodexResponseItem }
  | { type: "event_msg"; timestamp?: string; payload: CodexEventMsgPayload };

export function isResponseItem(
  r: CodexRecord,
): r is { type: "response_item"; timestamp?: string; payload: CodexResponseItem } {
  return r.type === "response_item";
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
