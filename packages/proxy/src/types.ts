import type { Action, ContextComponent, TokenUsage } from "@spool/shared";

/**
 * Per-provider capture interface. Each capture module knows how to:
 *   1. Parse a request body into the bits we want for the context snapshot
 *      (system prompt, history, tool defs).
 *   2. Parse a buffered response body into the action + tokens.
 *   3. Reassemble an SSE stream into the same shape.
 *
 * The proxy server itself is provider-agnostic — it just routes by URL
 * path and dispatches to the right capture module.
 */

export interface CapturedExchange {
  model: string;
  /** Raw decision JSON (what gets stored as the decision_ref blob). */
  decisionJson: string;
  action: Action;
  tokens: TokenUsage;
}

export interface ParsedRequest {
  model: string;
  systemPrompt?: string;
  toolDefinitions?: unknown;
  history: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  /** tool_result blocks pulled from the user's outgoing message — used to
   *  retro-attach to the previous step in the same Run. */
  pendingToolResults: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
  isStream: boolean;
}

export interface ProviderCapture {
  parseRequest: (rawBody: string) => ParsedRequest;
  buildContext: (parsed: ParsedRequest) => {
    systemPrompt?: string;
    toolDefinitions?: unknown;
    history: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
    extraComponents?: ContextComponent[];
  };
  parseResponse: (rawBody: string) => CapturedExchange | undefined;
  reassembleStream: (text: string) => CapturedExchange | undefined;
}
