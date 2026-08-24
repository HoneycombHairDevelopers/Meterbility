import type { Action, ContextComponent, TokenUsage } from "@meterbility/shared";
import type { ChunkMark } from "./sse.ts";

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

/**
 * Stream timing recovered from the tee's chunk-arrival marks, in ms
 * since the tee started (≈ response headers). The server adds the
 * request→headers latency to anchor them to request start.
 */
export interface StreamTiming {
  /** First delta of ANY kind — reasoning, text, or tool-call fragment.
   *  For reasoning models this is when the model started thinking. */
  first_delta_ms?: number;
  /** First delta a user would SEE (text content / tool call). The gap
   *  from first_delta_ms is the invisible reasoning burn. */
  first_visible_ms?: number;
}

export interface CapturedExchange {
  model: string;
  /** Raw decision JSON (what gets stored as the decision_ref blob). */
  decisionJson: string;
  action: Action;
  tokens: TokenUsage;
  /** Only set for streamed exchanges when the tee provided marks. */
  timing?: StreamTiming;
  /** OpenAI dialect only: whether the upstream's usage carried
   *  `prompt_tokens_details` at all. `false` means cache metrics were
   *  ABSENT (distinct from an explicit cached_tokens: 0) — the store
   *  tags the step `usage:cache-unreported` so "0 cached" is never
   *  conflated with "didn't say". Undefined = dialect doesn't apply. */
  cacheReported?: boolean;
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
  /** `marks` (when the tee provides them) let the reassembler compute
   *  StreamTiming; omitting them just omits the timing. */
  reassembleStream: (text: string, marks?: ChunkMark[]) => CapturedExchange | undefined;
}
