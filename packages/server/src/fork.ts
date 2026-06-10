import type {
  Action,
  ConversationMessage,
  ForkEdit,
  ForkEditType,
  Outcome,
  TokenUsage,
} from "@spool-ai/shared";
import {
  getRun,
  getStep,
  getStepBySequence,
  insertFork,
  listSteps,
} from "@spool-ai/collector";
import type { Store } from "@spool-ai/collector";
import { appendLiveStep, materializePrefix } from "./replay.ts";

export interface ForkArgs {
  origin_run_id: string;
  /** Either a full step id (stp_…) or a step sequence number. */
  at: string | number;
  edit: ForkEdit;
}

export interface ForkOutcome {
  fork_id: string;
  fork_run_id: string;
  prefix_steps: number;
  /** True if a live-suffix step was also materialized. False if the
   *  fork was created without a live model call (the operator can run
   *  one later via the API/CLI). */
  live: boolean;
}

/**
 * High-level fork entry point. Resolves the target step, materializes
 * the deterministic prefix, records the fork relationship, and (if
 * `liveSuffix` is provided) generates one live step using the operator-
 * supplied responder. We deliberately avoid hard-coding an Anthropic
 * call here so the engine is testable without a network round-trip and
 * so non-Anthropic providers can plug in later.
 */
export async function forkRun(
  store: Store,
  args: ForkArgs,
  liveSuffix?: LiveResponder,
): Promise<ForkOutcome> {
  const origin = getRun(store, args.origin_run_id);
  if (!origin) throw new Error(`unknown origin run: ${args.origin_run_id}`);

  const targetStep =
    typeof args.at === "number"
      ? getStepBySequence(store, origin.run_id, args.at)
      : getStep(store, args.at);
  if (!targetStep || targetStep.run_id !== origin.run_id) {
    throw new Error(`fork target step not found in run ${origin.run_id}`);
  }

  validateEdit(args.edit);

  const { run_id: fork_run_id, prefix_steps } = await materializePrefix(
    store,
    origin.run_id,
    targetStep.step_id,
    args.edit,
  );

  const fork_id = insertFork(store, {
    originRunId: origin.run_id,
    originStepId: targetStep.step_id,
    forkRunId: fork_run_id,
    edit: args.edit,
  });

  let live = false;
  if (liveSuffix) {
    const forkSteps = listSteps(store, fork_run_id);
    const lastForkStep = forkSteps[forkSteps.length - 1]!;
    const history = lastForkStep.context_snapshot_id;
    const result = await liveSuffix({
      origin_step: targetStep,
      context_snapshot_id: history,
      edit: args.edit,
    });
    await appendLiveStep(store, fork_run_id, {
      model: result.model,
      action: result.action,
      outcome: result.outcome ?? { status: "ok" },
      tokens: result.tokens,
      latency_ms: result.latency_ms ?? 0,
      parent_step_id: lastForkStep.step_id,
      snapshot: {
        id: lastForkStep.context_snapshot_id,
        components: [],
      },
      decisionContent: result.decision_content,
    });
    live = true;
  }

  return { fork_id, fork_run_id, prefix_steps, live };
}

function validateEdit(edit: ForkEdit): void {
  const allowed: ForkEditType[] = [
    "replace_system_prompt",
    "add_context",
    "remove_tool",
    "modify_tool_description",
    "replace_user_message",
    "inject_message",
    "change_model",
  ];
  if (!allowed.includes(edit.type)) {
    throw new Error(`unsupported edit type: ${edit.type}`);
  }
}

export interface LiveResponderArgs {
  origin_step: import("@spool-ai/shared").Step;
  context_snapshot_id: string;
  edit: ForkEdit;
}

export interface LiveResponderResult {
  model: string;
  action: Action;
  outcome?: Outcome;
  tokens: TokenUsage;
  latency_ms?: number;
  decision_content: unknown;
}

export type LiveResponder = (
  args: LiveResponderArgs,
) => Promise<LiveResponderResult>;

/**
 * A fake responder useful for tests and demos — produces a trivial
 * "message" step with zero tokens. Real implementations call an LLM.
 */
export function fakeResponder(text: string): LiveResponder {
  return async () => ({
    model: "fake",
    action: { kind: "message", text },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 1,
    decision_content: [{ type: "text", text }],
  });
}

export interface AnthropicResponderOptions {
  apiKey: string;
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
}

/**
 * Anthropic-backed live responder. Pulls the conversation history out
 * of the snapshot's blobs, sends it to the API, and packages the
 * response back into a Step. Kept here (not in adapters/) because it is
 * runtime-agnostic — it works for any captured history regardless of
 * which agent runtime produced it.
 */
export function anthropicResponder(
  store: Store,
  opts: AnthropicResponderOptions,
): LiveResponder {
  return async (args: LiveResponderArgs) => {
    // Lazy import so users without the package installed can still run
    // deterministic-prefix forks.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: opts.apiKey });
    const snapshot = await store.blobs.getJson<{
      components: Array<{
        type: string;
        messages?: ConversationMessage[];
        content_ref?: string;
      }>;
    }>(args.context_snapshot_id);
    const history = snapshot.components.find(
      (c) => c.type === "conversation_history",
    );
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (history?.messages) {
      for (const m of history.messages) {
        if (m.role === "tool") continue;
        const text = await store.blobs.tryGetString(m.content_ref);
        messages.push({ role: m.role, content: text ?? "" });
      }
    }
    let systemPrompt = opts.systemPrompt;
    const sys = snapshot.components.find((c) => c.type === "system_prompt");
    if (sys?.content_ref && !systemPrompt) {
      systemPrompt = await store.blobs.tryGetString(sys.content_ref);
    }
    const t0 = Date.now();
    const resp = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: systemPrompt,
      messages: messages.length
        ? messages
        : [{ role: "user", content: "(no history)" }],
    });
    const t1 = Date.now();
    const text = (resp.content ?? [])
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    // Split 5m / 1h cache writes when the API exposes the breakdown. The SDK's
    // Usage type predates the cache fields, so the whole block is cast.
    const usage = resp.usage as
      | {
          cache_creation?: {
            ephemeral_5m_input_tokens?: number;
            ephemeral_1h_input_tokens?: number;
          };
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    const cc = usage?.cache_creation;
    const tokens5m = cc
      ? cc.ephemeral_5m_input_tokens ?? 0
      : (usage?.cache_creation_input_tokens ?? 0);
    const tokens1h = cc?.ephemeral_1h_input_tokens ?? 0;
    return {
      model: resp.model,
      action: { kind: "message", text },
      outcome: { status: "ok" },
      tokens: {
        input: resp.usage?.input_tokens ?? 0,
        output: resp.usage?.output_tokens ?? 0,
        cached_read: usage?.cache_read_input_tokens ?? 0,
        cache_creation: tokens5m,
        cache_creation_1h: tokens1h,
      },
      latency_ms: t1 - t0,
      decision_content: resp.content,
    };
  };
}
