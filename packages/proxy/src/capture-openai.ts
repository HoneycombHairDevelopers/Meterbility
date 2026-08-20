import type { Action } from "@meterbility/shared";
import { parseSseStream, timeAtOffset, type ChunkMark, type SseEvent } from "./sse.ts";
import type { CapturedExchange, ProviderCapture, StreamTiming } from "./types.ts";

/**
 * OpenAI /v1/chat/completions capture.
 *
 * Notable differences from Anthropic:
 *   - System prompt arrives as a `messages[0]` with role: "system" — we
 *     pull it out before building the conversation_history.
 *   - Tool calls live under `message.tool_calls` (an array), not a
 *     content block. We capture the first one as the action; multi-tool
 *     calls in a single response get joined with newlines in the
 *     decision blob (rare in practice).
 *   - Cache pricing has only one tier — `prompt_tokens_details.cached_tokens`
 *     maps to `cached_read`, no creation split.
 *   - Streaming chunks have `choices[0].delta` with text or tool_calls.
 *     Usage shows up in the final chunk only when
 *     `stream_options.include_usage: true` was sent.
 */
export const openaiCapture: ProviderCapture = {
  buildContext,
  parseRequest,
  parseResponse,
  reassembleStream,
};

interface OpenAIRequest {
  model: string;
  messages?: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content?:
      | string
      | Array<{ type: string; text?: string } & Record<string, unknown>>
      | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  tools?: unknown;
  stream?: boolean;
}

interface OpenAIResponse {
  model: string;
  choices?: Array<{
    message?: {
      role: string;
      content?: string | null;
      /** Nonstandard but common on reasoning-capable OpenAI-compatible
       *  hosts (NVIDIA NIM et al.) — the model's thinking text. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function parseRequest(rawBody: string): {
  model: string;
  systemPrompt?: string;
  toolDefinitions?: unknown;
  history: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  pendingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
  isStream: boolean;
} {
  const req = safeJson<OpenAIRequest>(rawBody) ?? ({} as OpenAIRequest);
  const messages = req.messages ?? [];
  let systemPrompt: string | undefined;
  const history: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [];
  const pendingToolResults: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> = [];

  for (const m of messages) {
    if (m.role === "system" && systemPrompt === undefined) {
      systemPrompt = flattenContent(m.content);
      continue;
    }
    if (m.role === "tool") {
      // `tool` messages are tool_result deliveries — attach to previous step.
      pendingToolResults.push({
        tool_use_id: m.tool_call_id ?? "",
        content: flattenContent(m.content),
      });
      history.push({ role: "tool", content: flattenContent(m.content) });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // Render tool calls as an inline trace so the conversation history
      // includes everything the model decided to do.
      const calls = m.tool_calls.map(
        (tc) => `[tool_call ${tc.function.name} ${tc.function.arguments}]`,
      );
      const text = m.content ? flattenContent(m.content) + "\n" + calls.join("\n") : calls.join("\n");
      history.push({ role: "assistant", content: text });
      continue;
    }
    history.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: flattenContent(m.content),
    });
  }

  return {
    model: req.model ?? "unknown",
    systemPrompt,
    toolDefinitions: req.tools,
    history,
    pendingToolResults,
    isStream: req.stream === true,
  };
}

function buildContext(parsed: ReturnType<typeof parseRequest>): {
  systemPrompt?: string;
  toolDefinitions?: unknown;
  history: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
} {
  return {
    systemPrompt: parsed.systemPrompt,
    toolDefinitions: parsed.toolDefinitions,
    history: parsed.history,
  };
}

function parseResponse(rawBody: string): CapturedExchange | undefined {
  const r = safeJson<OpenAIResponse>(rawBody);
  if (!r) return undefined;
  return shapeFromResponse(r, rawBody);
}

function reassembleStream(text: string, marks?: ChunkMark[]): CapturedExchange | undefined {
  const events = parseSseStream(text);
  const r = reassembleOpenAIResponse(events);
  if (!r) return undefined;
  const exchange = shapeFromResponse(r.response, JSON.stringify(r.response));
  if (marks && marks.length > 0) {
    const timing: StreamTiming = {};
    if (r.firstDeltaOffset !== undefined) {
      timing.first_delta_ms = timeAtOffset(marks, r.firstDeltaOffset);
    }
    if (r.firstVisibleOffset !== undefined) {
      timing.first_visible_ms = timeAtOffset(marks, r.firstVisibleOffset);
    }
    if (timing.first_delta_ms !== undefined || timing.first_visible_ms !== undefined) {
      exchange.timing = timing;
    }
  }
  return exchange;
}

function shapeFromResponse(
  r: OpenAIResponse,
  rawDecisionJson: string,
): CapturedExchange {
  const choice = r.choices?.[0];
  const msg = choice?.message;
  const text = typeof msg?.content === "string" ? msg.content : "";
  const toolCall = msg?.tool_calls?.[0];

  const action: Action = toolCall
    ? {
        kind: "tool_call",
        tool_name: toolCall.function.name,
        tool_use_id: toolCall.id,
        tool_input: safeJson<unknown>(toolCall.function.arguments) ??
          toolCall.function.arguments,
      }
    : text
      ? { kind: "message", text }
      : { kind: "thinking_only" };

  return {
    model: r.model,
    decisionJson: rawDecisionJson,
    action,
    tokens: {
      input: r.usage?.prompt_tokens ?? 0,
      output: r.usage?.completion_tokens ?? 0,
      cached_read: r.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation: 0, // OpenAI charges nothing extra on cache write
      cache_creation_1h: 0,
      reasoning: r.usage?.completion_tokens_details?.reasoning_tokens,
    },
    // "cached_read: 0" above can mean two different things: the host said
    // 0, or the host said nothing. Only meaningful when usage exists at
    // all (a missing usage block is the usage:missing case, not this one).
    cacheReported: r.usage
      ? r.usage.prompt_tokens_details != null
      : undefined,
  };
}

/**
 * Walk OpenAI streaming chunks and rebuild the final response shape.
 * Each chunk has `choices[i].delta` with content/reasoning_content/
 * tool_calls fragments. Final chunk (when the host sends usage — some,
 * like NVIDIA, do so by default) carries `usage`.
 *
 * Also records the text offsets of the first delta of any kind and the
 * first VISIBLE delta (content or tool-call fragment) — joined against
 * the tee's arrival marks, the gap between them is the invisible
 * reasoning burn a client experiences before the first real token.
 */
function reassembleOpenAIResponse(events: SseEvent[]):
  | {
      response: OpenAIResponse;
      firstDeltaOffset?: number;
      firstVisibleOffset?: number;
    }
  | undefined {
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<
    number,
    { id?: string; type?: string; name?: string; arguments: string }
  >();
  let model: string | undefined;
  let usage: OpenAIResponse["usage"] | undefined;
  let finishReason: string | undefined;
  let firstDeltaOffset: number | undefined;
  let firstVisibleOffset: number | undefined;

  for (const e of events) {
    if (e.data === "[DONE]" || typeof e.data !== "object" || e.data === null) {
      continue;
    }
    const chunk = e.data as Record<string, unknown>;
    if (chunk.model && !model) model = String(chunk.model);
    const choices = chunk.choices as
      | Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>
      | undefined;
    const ch = choices?.[0];
    const hasVisible = Boolean(ch?.delta?.content || ch?.delta?.tool_calls?.length);
    const hasAny = hasVisible || Boolean(ch?.delta?.reasoning_content);
    if (hasAny && firstDeltaOffset === undefined) firstDeltaOffset = e.offset;
    if (hasVisible && firstVisibleOffset === undefined) firstVisibleOffset = e.offset;
    if (ch?.delta?.reasoning_content) reasoning.push(ch.delta.reasoning_content);
    if (ch?.delta?.content) text.push(ch.delta.content);
    if (ch?.delta?.tool_calls) {
      for (const tc of ch.delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolCalls.get(idx) ?? { arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }
    if (ch?.finish_reason) finishReason = ch.finish_reason;
    if (chunk.usage) usage = chunk.usage as OpenAIResponse["usage"];
  }

  if (!model && text.length === 0 && toolCalls.size === 0 && reasoning.length === 0) {
    return undefined;
  }
  const message: NonNullable<OpenAIResponse["choices"]>[number]["message"] = {
    role: "assistant",
    content: text.join(""),
    // Reassembled decision-blob parity with non-streamed responses: the
    // thinking text a stream-only capture would otherwise lose forever.
    reasoning_content: reasoning.length > 0 ? reasoning.join("") : undefined,
    tool_calls:
      toolCalls.size > 0
        ? [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id ?? "",
              type: "function" as const,
              function: { name: tc.name ?? "", arguments: tc.arguments },
            }))
        : undefined,
  };
  return {
    response: {
      model: model ?? "unknown",
      choices: [{ message, finish_reason: finishReason }],
      usage,
    },
    firstDeltaOffset,
    firstVisibleOffset,
  };
}

function flattenContent(content: OpenAIRequest["messages"] extends Array<infer M>
  ? M extends { content?: infer C }
    ? C
    : unknown
  : unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && "text" in b ? String(b.text ?? "") : ""))
      .join("\n");
  }
  return String(content);
}

function safeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
