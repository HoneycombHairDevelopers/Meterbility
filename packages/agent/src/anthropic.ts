import type { Action } from "@spool/shared";
import type { SpoolTracer } from "./tracer.ts";

/**
 * Convenience wrapper for the common "I'm calling the Anthropic SDK"
 * case. Captures one Step per messages.create() invocation, mapping the
 * SDK's request/response into Spool's data model.
 *
 * Usage:
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   const client = new Anthropic();
 *   const tracer = new SpoolTracer({ project, agent });
 *   const traced = traceAnthropic(tracer, (req) => client.messages.create(req));
 *
 *   const resp = await traced({
 *     model: "claude-opus-4-7",
 *     max_tokens: 1024,
 *     system: "you are helpful",
 *     messages: [{ role: "user", content: "hello" }],
 *   });
 *
 * Returns the SDK response untouched. One captured Step per call.
 */
export function traceAnthropic<
  Req extends AnthropicMessagesRequest,
  Resp extends AnthropicMessagesResponse,
>(
  tracer: SpoolTracer,
  call: (req: Req) => Promise<Resp>,
): (req: Req) => Promise<Resp> {
  return async (req: Req) => {
    const history: Array<{
      role: "user" | "assistant" | "tool";
      content: string;
    }> = [];
    for (const m of req.messages ?? []) {
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content ?? [])
              .filter(
                (b): b is { type: "text"; text: string } => b.type === "text",
              )
              .map((b) => b.text)
              .join("\n");
      history.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: text,
      });
    }

    const step = tracer.startStep({
      model: req.model,
      systemPrompt: typeof req.system === "string" ? req.system : undefined,
      toolDefinitions: req.tools,
      history,
    });

    const t0 = Date.now();
    let resp: Resp;
    try {
      resp = await call(req);
    } catch (err) {
      step
        .recordAction({ kind: "none" })
        .recordOutcome({
          outcome: {
            status: "error",
            is_error: true,
            summary: (err as Error).message?.slice(0, 200),
          },
        });
      await step.end();
      throw err;
    }
    const t1 = Date.now();

    const blocks = resp.content ?? [];
    const toolUse = blocks.find(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use",
    );
    const text = blocks
      .filter((b): b is AnthropicTextBlock => b.type === "text")
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

    step
      .recordDecision({ decision: resp.content, action })
      .recordTokens({
        tokens: {
          input: resp.usage?.input_tokens ?? 0,
          output: resp.usage?.output_tokens ?? 0,
          cached_read: resp.usage?.cache_read_input_tokens ?? 0,
          cache_creation: resp.usage?.cache_creation_input_tokens ?? 0,
        },
        latency_ms: t1 - t0,
      })
      .recordOutcome({ outcome: { status: "ok" } });
    await step.end();
    return resp;
  };
}

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  system?:
    | string
    | Array<{ type: string; text: string }>;
  messages: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<{ type: string; text?: string } | Record<string, unknown>>;
  }>;
  tools?: unknown;
}

interface AnthropicMessagesResponse {
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  content?: Array<AnthropicTextBlock | AnthropicToolUseBlock | { type: string }>;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
