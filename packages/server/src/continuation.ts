import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  Outcome,
  Step,
  TokenUsage,
} from "@spool/shared";
import { hashJson } from "@spool/shared";
import { costCents } from "@spool/spec";
import {
  getRun,
  insertStep,
  listSteps,
  recordContextSnapshot,
  resolveSnapshotBlobRef,
  setRunStatus,
  updateRunTotals,
} from "@spool/collector";
import type { Store } from "@spool/collector";
import { randomUUID } from "node:crypto";

/**
 * Multi-step continuation engine. After a fork has materialized its
 * deterministic prefix, this drives the agent loop until either:
 *   - the model produces a message (no tool call), or
 *   - max iterations are exceeded, or
 *   - a tool is requested that we cannot resolve in `simulate` mode.
 *
 * Two modes are offered, mirroring SPEC §7.2:
 *
 *   simulate — run the model live, but for each tool the model picks,
 *     look up the *original* run's tool result and feed that back. Only
 *     works when the model picks a tool whose call signature appears in
 *     the origin run; otherwise the loop stops with a `simulate_miss`
 *     marker tag on the last step.
 *
 *   live — run the model live AND execute tools via the caller-supplied
 *     executor. Side-effecting; the caller takes responsibility for
 *     sandboxing.
 */

export type ContinuationMode = "simulate" | "live";

export interface ContinuationCallArgs {
  /** History assembled so far (user/assistant turns, oldest → newest). */
  history: ConversationMessage[];
  /** The most recent step in the fork run. */
  prior_step: Step;
  /** Resolved system prompt content (if available). */
  system_prompt?: string;
  /** Iteration number, 0-indexed. */
  iteration: number;
}

export interface ContinuationCallResult {
  model: string;
  /** Raw model output to persist as decision blob. */
  decision_content: unknown;
  action: Action;
  tokens: TokenUsage;
  latency_ms: number;
}

export type ContinuationModelCaller = (
  args: ContinuationCallArgs,
) => Promise<ContinuationCallResult>;

export interface ToolCall {
  tool_name: string;
  tool_use_id?: string;
  tool_input: unknown;
}

export interface ToolExecutionResult {
  /** Anything serializable. Stored as a tool_result blob. */
  output: unknown;
  is_error?: boolean;
  /** Human-readable one-liner. */
  summary?: string;
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolExecutionResult>;

export interface ContinuationOptions {
  mode: ContinuationMode;
  modelCaller: ContinuationModelCaller;
  /** Required in `live` mode; ignored in `simulate`. */
  toolExecutor?: ToolExecutor;
  /** Cap iterations to bound runaway loops. Defaults to 25. */
  maxIterations?: number;
  /** Origin run id — used by simulate mode to look up cached tool results. */
  originRunId?: string;
}

export interface ContinuationResult {
  iterations_run: number;
  steps_added: number;
  terminal_reason:
    | "model_completed"
    | "max_iterations"
    | "simulate_miss"
    | "tool_error"
    | "model_error";
  final_step_id: string;
}

export async function continueFork(
  store: Store,
  forkRunId: string,
  opts: ContinuationOptions,
): Promise<ContinuationResult> {
  const fork = getRun(store, forkRunId);
  if (!fork) throw new Error(`fork run not found: ${forkRunId}`);
  const max = opts.maxIterations ?? 25;
  if (opts.mode === "live" && !opts.toolExecutor) {
    throw new Error("live mode requires a toolExecutor");
  }
  if (opts.mode === "simulate" && !opts.originRunId) {
    throw new Error("simulate mode requires an originRunId");
  }

  // Build the simulate-mode tool index up front: every tool call → result
  // pair from the origin run, keyed by canonical (tool_name, input) hash.
  const simIndex =
    opts.mode === "simulate"
      ? buildToolIndex(store, opts.originRunId!)
      : new Map<string, { result: unknown; is_error: boolean; summary?: string }>();

  let stepsAdded = 0;
  let lastStepId = "";

  for (let iteration = 0; iteration < max; iteration++) {
    const steps = listSteps(store, fork.run_id);
    const prior = steps[steps.length - 1];
    if (!prior) {
      throw new Error(`fork run has no steps: ${forkRunId}`);
    }
    lastStepId = prior.step_id;

    const { history, systemPrompt } = await assembleHistory(store, prior);

    // 1) Call the model.
    let modelResult: ContinuationCallResult;
    try {
      modelResult = await opts.modelCaller({
        history,
        prior_step: prior,
        system_prompt: systemPrompt,
        iteration,
      });
    } catch (err) {
      const errorStep = await persistErrorStep(store, fork.run_id, prior, {
        kind: "model_error",
        message: (err as Error).message,
      });
      stepsAdded += 1;
      lastStepId = errorStep.step_id;
      return {
        iterations_run: iteration + 1,
        steps_added: stepsAdded,
        terminal_reason: "model_error",
        final_step_id: lastStepId,
      };
    }

    // 2) Persist the model's step.
    const modelStep = await persistModelStep(store, fork.run_id, prior, modelResult);
    stepsAdded += 1;
    lastStepId = modelStep.step_id;

    // 3) If the model didn't request a tool, we're done.
    if (modelResult.action.kind !== "tool_call" || !modelResult.action.tool_name) {
      setRunStatus(store, fork.run_id, "ok", new Date().toISOString());
      updateRunTotals(store, fork.run_id);
      return {
        iterations_run: iteration + 1,
        steps_added: stepsAdded,
        terminal_reason: "model_completed",
        final_step_id: lastStepId,
      };
    }

    // 4) Resolve the tool call.
    const toolCall: ToolCall = {
      tool_name: modelResult.action.tool_name,
      tool_use_id: modelResult.action.tool_use_id,
      tool_input: modelResult.action.tool_input,
    };

    let toolResult: ToolExecutionResult | undefined;
    if (opts.mode === "simulate") {
      const sigKey = toolSignature(toolCall);
      const hit = simIndex.get(sigKey);
      if (!hit) {
        // No matching tool result in the origin — mark and stop.
        await tagStep(store, modelStep.step_id, "simulate_miss");
        setRunStatus(store, fork.run_id, "in_progress");
        updateRunTotals(store, fork.run_id);
        return {
          iterations_run: iteration + 1,
          steps_added: stepsAdded,
          terminal_reason: "simulate_miss",
          final_step_id: lastStepId,
        };
      }
      toolResult = {
        output: hit.result,
        is_error: hit.is_error,
        summary: hit.summary,
      };
    } else if (opts.mode === "live" && opts.toolExecutor) {
      try {
        toolResult = await opts.toolExecutor(toolCall);
      } catch (err) {
        toolResult = {
          output: { error: (err as Error).message },
          is_error: true,
          summary: `tool threw: ${(err as Error).message}`.slice(0, 200),
        };
      }
    }

    if (!toolResult) {
      // shouldn't happen given the mode checks above — guard anyway
      throw new Error("internal: missing tool result");
    }

    // 5) Persist the tool outcome on the model step we just inserted.
    const ref = await store.blobs.putJson(toolResult.output);
    const updatedOutcome: Outcome = {
      status: toolResult.is_error ? "error" : "ok",
      tool_result_ref: ref,
      is_error: toolResult.is_error ?? false,
      summary: toolResult.summary,
    };
    store.db
      .prepare("UPDATE steps SET outcome_json = ?, status = ? WHERE step_id = ?")
      .run(
        JSON.stringify(updatedOutcome),
        toolResult.is_error ? "error" : "ok",
        modelStep.step_id,
      );

    if (toolResult.is_error && opts.mode === "live") {
      // Stop on the first live tool error — caller probably wants to see why.
      setRunStatus(store, fork.run_id, "error");
      updateRunTotals(store, fork.run_id);
      return {
        iterations_run: iteration + 1,
        steps_added: stepsAdded,
        terminal_reason: "tool_error",
        final_step_id: lastStepId,
      };
    }
  }

  // Fell through: hit the max iteration cap.
  setRunStatus(store, fork.run_id, "in_progress");
  updateRunTotals(store, fork.run_id);
  return {
    iterations_run: max,
    steps_added: stepsAdded,
    terminal_reason: "max_iterations",
    final_step_id: lastStepId,
  };
}

interface AssembledHistory {
  history: ConversationMessage[];
  systemPrompt?: string;
}

async function assembleHistory(
  store: Store,
  priorStep: Step,
): Promise<AssembledHistory> {
  const ref = resolveSnapshotBlobRef(store, priorStep.context_snapshot_id);
  const snap = await store.blobs.tryGetString(ref);
  if (!snap) return { history: [] };
  let parsed: ContextSnapshot;
  try {
    parsed = JSON.parse(snap) as ContextSnapshot;
  } catch {
    return { history: [] };
  }

  const history: ConversationMessage[] = [];
  let systemPrompt: string | undefined;
  for (const c of parsed.components) {
    if (c.type === "system_prompt") {
      systemPrompt = await store.blobs.tryGetString(c.content_ref);
    } else if (c.type === "conversation_history") {
      for (const m of c.messages) history.push(m);
    }
  }

  // Append the prior step's *own* turn. The history we just read is the
  // context the prior step SAW; we need to also include what the prior
  // step DID so the next call sees the assistant's reply too.
  const priorAction = priorStep.action;
  let assistantText = "";
  if (priorAction.kind === "message" && priorAction.text) {
    assistantText = priorAction.text;
  } else if (priorAction.kind === "tool_call") {
    assistantText = `[tool_call: ${priorAction.tool_name ?? "?"}]`;
  }
  if (assistantText) {
    const aref = await store.blobs.putString(assistantText);
    history.push({ role: "assistant", content_ref: aref });
  }

  // For tool_call steps, also feed the result back as a "tool" role.
  if (priorAction.kind === "tool_call" && priorStep.outcome.tool_result_ref) {
    history.push({
      role: "tool",
      content_ref: priorStep.outcome.tool_result_ref,
    });
  }

  return { history, systemPrompt };
}

async function persistModelStep(
  store: Store,
  runId: string,
  prior: Step,
  result: ContinuationCallResult,
): Promise<Step> {
  // The new step's context = prior step's context + assistant turn + maybe tool result.
  const { history, systemPrompt } = await assembleHistory(store, prior);
  const components: ContextComponent[] = [];
  if (systemPrompt) {
    components.push({
      type: "system_prompt",
      content_ref: await store.blobs.putString(systemPrompt),
    });
  }
  if (history.length > 0) {
    components.push({ type: "conversation_history", messages: history });
  }
  const snapshot: ContextSnapshot = { id: hashJson(components), components };
  const blobRef = await store.blobs.putJson(snapshot);
  recordContextSnapshot(store, snapshot.id, blobRef, snapshot.components.length);

  const decisionRef = await store.blobs.putJson(result.decision_content);
  const { cost_cents, approx } = costCents(result.model, {
    input: result.tokens.input,
    output: result.tokens.output,
    cached_read: result.tokens.cached_read,
    cache_creation: result.tokens.cache_creation,
  });
  const tags = ["continuation"];
  if (approx) tags.push("cost:approx");

  const step: Step = {
    step_id: `stp_${randomUUID()}`,
    run_id: runId,
    parent_step_id: prior.step_id,
    sequence: prior.sequence + 1,
    timestamp: new Date().toISOString(),
    model: result.model,
    context_snapshot_id: snapshot.id,
    decision_ref: decisionRef,
    action: result.action,
    outcome: { status: "pending" },
    tokens: result.tokens,
    latency_ms: result.latency_ms,
    cost_cents,
    tags,
    status: "in_progress",
  };
  insertStep(store, step);
  return step;
}

async function persistErrorStep(
  store: Store,
  runId: string,
  prior: Step,
  err: { kind: string; message: string },
): Promise<Step> {
  const components: ContextComponent[] = [];
  const snapshot: ContextSnapshot = { id: hashJson(components), components };
  const blobRef = await store.blobs.putJson(snapshot);
  recordContextSnapshot(store, snapshot.id, blobRef, 0);
  const decisionRef = await store.blobs.putJson({ error: err });
  const step: Step = {
    step_id: `stp_${randomUUID()}`,
    run_id: runId,
    parent_step_id: prior.step_id,
    sequence: prior.sequence + 1,
    timestamp: new Date().toISOString(),
    model: "continuation",
    context_snapshot_id: snapshot.id,
    decision_ref: decisionRef,
    action: { kind: "none" },
    outcome: {
      status: "error",
      is_error: true,
      summary: err.message.slice(0, 200),
    },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: ["continuation", "error", err.kind],
    status: "error",
  };
  insertStep(store, step);
  return step;
}

async function tagStep(
  store: Store,
  stepId: string,
  tag: string,
): Promise<void> {
  const row = store.db
    .prepare("SELECT tags FROM steps WHERE step_id = ?")
    .get(stepId) as { tags: string } | undefined;
  if (!row) return;
  const tags = JSON.parse(row.tags) as string[];
  if (!tags.includes(tag)) tags.push(tag);
  store.db
    .prepare("UPDATE steps SET tags = ? WHERE step_id = ?")
    .run(JSON.stringify(tags), stepId);
}

function buildToolIndex(
  store: Store,
  originRunId: string,
): Map<string, { result: unknown; is_error: boolean; summary?: string }> {
  const out = new Map<
    string,
    { result: unknown; is_error: boolean; summary?: string }
  >();
  const steps = listSteps(store, originRunId);
  for (const s of steps) {
    if (s.action.kind !== "tool_call" || !s.action.tool_name) continue;
    if (!s.outcome.tool_result_ref) continue;
    const sig = toolSignature({
      tool_name: s.action.tool_name,
      tool_input: s.action.tool_input,
    });
    out.set(sig, {
      result: { __ref: s.outcome.tool_result_ref },
      is_error: s.outcome.is_error ?? false,
      summary: s.outcome.summary,
    });
  }
  return out;
}

function toolSignature(call: { tool_name: string; tool_input: unknown }): string {
  return `${call.tool_name}::${hashJson(call.tool_input ?? null)}`;
}

/**
 * Helper: simulate-mode tool results store a `__ref` pointer rather than
 * the inline bytes (so we don't double-store). Resolve it back to a real
 * value when downstream code needs the actual result.
 */
export async function resolveSimulatedResult(
  store: Store,
  result: unknown,
): Promise<unknown> {
  if (
    result &&
    typeof result === "object" &&
    "__ref" in result &&
    typeof (result as { __ref: string }).__ref === "string"
  ) {
    const ref = (result as { __ref: string }).__ref;
    const text = await store.blobs.tryGetString(ref);
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}
