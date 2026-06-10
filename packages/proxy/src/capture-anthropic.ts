import type { Action, ContextComponent } from "@spool-ai/shared";
import { parseSseStream, type SseEvent } from "./sse.ts";
import type { CapturedExchange, ProviderCapture } from "./types.ts";

/**
 * Anthropic /v1/messages capture.
 *
 * Handles both response shapes:
 *   - Non-streaming: `stream: false` (or omitted) — body is the full
 *     Message JSON.
 *   - Streaming: `stream: true` — body is SSE events. Reassembled into
 *     the same Message shape via `reassembleStream`.
 *
 * Tool result attribution: when a request comes in whose `messages`
 * array contains `tool_result` content blocks, those become
 * `record_tool_result` data on the *previous* step in the same Run
 * (handled in grouping.ts — this module just exposes the data).
 */
export const anthropicCapture: ProviderCapture = {
  buildContext,
  parseRequest,
  parseResponse,
  reassembleStream,
};

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<{ type: string; text?: string } & Record<string, unknown>>;
  }>;
  tools?: unknown;
  stream?: boolean;
}

interface AnthropicMessage {
  id?: string;
  model: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
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
  const req = safeJson<AnthropicRequest>(rawBody) ?? ({} as AnthropicRequest);
  const systemPrompt = flattenAnthropicSystem(req.system);
  const history: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [];
  const pendingToolResults: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> = [];

  for (const m of req.messages ?? []) {
    const content = m.content;
    if (typeof content === "string") {
      history.push({ role: m.role === "assistant" ? "assistant" : "user", content });
      continue;
    }
    // Block-array content. Walk blocks to find tool_result entries (which
    // belong to the *previous* assistant step) and concat text+tool_use
    // for the visible history.
    const textParts: string[] = [];
    for (const block of content ?? []) {
      const btype = (block as { type?: string }).type;
      if (btype === "text") {
        textParts.push(String((block as { text?: string }).text ?? ""));
      } else if (btype === "tool_use") {
        textParts.push(
          `[tool_call ${(block as { name?: string }).name ?? ""} ${JSON.stringify(
            (block as { input?: unknown }).input ?? {},
          )}]`,
        );
      } else if (btype === "tool_result") {
        const tu = block as {
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        };
        const text =
          typeof tu.content === "string"
            ? tu.content
            : JSON.stringify(tu.content ?? "");
        pendingToolResults.push({
          tool_use_id: tu.tool_use_id ?? "",
          content: text,
          is_error: tu.is_error === true,
        });
        textParts.push(`[tool_result ${tu.tool_use_id ?? ""}]`);
      }
    }
    history.push({
      role:
        m.role === "assistant"
          ? "assistant"
          : pendingToolResults.length > 0 && textParts.every((p) => p.startsWith("[tool_result"))
            ? "tool"
            : "user",
      content: textParts.join("\n"),
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
  extraComponents?: ContextComponent[];
} {
  return {
    systemPrompt: parsed.systemPrompt,
    toolDefinitions: parsed.toolDefinitions,
    history: parsed.history,
  };
}

function parseResponse(rawBody: string): CapturedExchange | undefined {
  const msg = safeJson<AnthropicMessage>(rawBody);
  if (!msg) return undefined;
  return shapeFromMessage(msg, rawBody);
}

function reassembleStream(text: string): CapturedExchange | undefined {
  const events = parseSseStream(text);
  const msg = reassembleAnthropicMessage(events);
  if (!msg) return undefined;
  return shapeFromMessage(msg, JSON.stringify(msg));
}

function shapeFromMessage(
  msg: AnthropicMessage,
  rawDecisionJson: string,
): CapturedExchange {
  const blocks = msg.content ?? [];
  const toolUse = blocks.find(
    (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
      b.type === "tool_use",
  );
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const action: Action = toolUse
    ? {
        kind: "tool_call",
        tool_name: toolUse.name,
        tool_use_id: toolUse.id,
        tool_input: toolUse.input,
      }
    : text
      ? { kind: "message", text }
      : { kind: "thinking_only" };

  const cc = msg.usage?.cache_creation;
  const tokens5m = cc
    ? cc.ephemeral_5m_input_tokens ?? 0
    : (msg.usage?.cache_creation_input_tokens ?? 0);
  const tokens1h = cc?.ephemeral_1h_input_tokens ?? 0;

  return {
    model: msg.model,
    decisionJson: rawDecisionJson,
    action,
    tokens: {
      input: msg.usage?.input_tokens ?? 0,
      output: msg.usage?.output_tokens ?? 0,
      cached_read: msg.usage?.cache_read_input_tokens ?? 0,
      cache_creation: tokens5m,
      cache_creation_1h: tokens1h,
    },
  };
}

/**
 * Walk Anthropic SSE events and rebuild the final Message. Spec:
 *   message_start    → seed message + usage.input_tokens
 *   content_block_start → push empty block at index
 *   content_block_delta → append text or input_json deltas to that block
 *   content_block_stop  → finalize that block (parse partial JSON if tool_use)
 *   message_delta    → patch usage.output_tokens, stop_reason
 *   message_stop     → done
 */
function reassembleAnthropicMessage(events: SseEvent[]): AnthropicMessage | undefined {
  let message: AnthropicMessage | undefined;
  const partialJsonByIndex = new Map<number, string>();
  for (const e of events) {
    if (e.data === "[DONE]" || typeof e.data !== "object" || e.data === null) {
      continue;
    }
    const data = e.data as Record<string, unknown>;
    const type = data.type as string | undefined;
    if (type === "message_start") {
      message = (data.message as AnthropicMessage) ?? { model: "unknown" };
      message.content = [];
    } else if (type === "content_block_start" && message) {
      const idx = (data.index as number) ?? 0;
      const block = data.content_block as Record<string, unknown>;
      message.content![idx] = {
        ...(block as object),
        // For text blocks, deltas accumulate into `text`.
        // For tool_use blocks, deltas accumulate into `input`.
        text: block.type === "text" ? "" : block.text,
        input: block.type === "tool_use" ? {} : block.input,
      } as AnthropicMessage["content"] extends Array<infer T> ? T : never;
    } else if (type === "content_block_delta" && message) {
      const idx = (data.index as number) ?? 0;
      const delta = data.delta as Record<string, unknown>;
      const block = message.content![idx] as Record<string, unknown> | undefined;
      if (!block) continue;
      if (delta.type === "text_delta") {
        block.text = String(block.text ?? "") + String(delta.text ?? "");
      } else if (delta.type === "input_json_delta") {
        partialJsonByIndex.set(
          idx,
          (partialJsonByIndex.get(idx) ?? "") + String(delta.partial_json ?? ""),
        );
      }
    } else if (type === "content_block_stop" && message) {
      const idx = (data.index as number) ?? 0;
      const block = message.content![idx] as Record<string, unknown> | undefined;
      if (block && block.type === "tool_use") {
        const partial = partialJsonByIndex.get(idx);
        if (partial) {
          try {
            block.input = JSON.parse(partial);
          } catch {
            block.input = { _spool_partial_json: partial };
          }
        }
      }
    } else if (type === "message_delta" && message) {
      const delta = data.delta as Record<string, unknown> | undefined;
      const usage = data.usage as AnthropicMessage["usage"] | undefined;
      if (delta?.stop_reason) message.stop_reason = String(delta.stop_reason);
      if (usage) {
        message.usage = { ...(message.usage ?? {}), ...usage };
      }
    }
  }
  return message;
}

function flattenAnthropicSystem(
  system: AnthropicRequest["system"],
): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system
    .filter((b): b is { type: string; text: string } => typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function safeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
