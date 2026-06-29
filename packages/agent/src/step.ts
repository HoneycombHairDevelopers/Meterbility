import { randomUUID } from "node:crypto";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  Outcome,
  Step,
  TokenUsage,
} from "@meterbility/shared";
import { hashJson } from "@meterbility/shared";
import { costCents } from "@meterbility/spec";
import { insertStep, recordContextSnapshot } from "@meterbility/collector";
import type { MeterbilityTracer } from "./tracer.ts";
import type {
  RecordDecisionOptions,
  RecordOutcomeOptions,
  RecordTokensOptions,
  StartStepOptions,
} from "./types.ts";

/**
 * One Step builder, returned by tracer.startStep().
 *
 * The capture surface is imperative on purpose: most agent frameworks
 * already have an event-loop-shaped flow ("call model, get reply, run
 * tool, get result"), and forcing them into a different shape costs more
 * than it earns.
 *
 * Internally a MeterbilityStep buffers up the context snapshot, decision,
 * action, outcome, and tokens; persists once `end()` is called. That
 * keeps async I/O off the agent's critical path until the step is over.
 */
export interface StepInit {
  tracer: MeterbilityTracer;
  sequence: number;
  parent_step_id?: string;
  startedAtMs: number;
  options: StartStepOptions;
}

export class MeterbilityStep {
  readonly step_id = `stp_${randomUUID()}`;
  readonly sequence: number;
  readonly parent_step_id?: string;
  private tracer: MeterbilityTracer;
  private model: string;
  private startedAtMs: number;
  private startedAtIso = new Date().toISOString();
  private context: ContextComponent[];
  private decisionContent?: unknown;
  private action: Action = { kind: "none" };
  private outcome: Outcome = { status: "pending" };
  private tokens: TokenUsage = {
    input: 0,
    output: 0,
    cached_read: 0,
    cache_creation: 0,
  };
  private explicitLatency?: number;
  private tags: string[] = [];
  private ended = false;

  private startOptions: StartStepOptions;

  constructor(init: StepInit) {
    this.tracer = init.tracer;
    this.sequence = init.sequence;
    this.parent_step_id = init.parent_step_id;
    this.startedAtMs = init.startedAtMs;
    this.model = init.options.model;
    this.startOptions = init.options;
    this.context = []; // built at end() so content blobs can be persisted first
    if (init.options.tags) this.tags.push(...init.options.tags);
  }

  recordDecision(opts: RecordDecisionOptions): this {
    this.decisionContent = opts.decision;
    this.action = opts.action;
    return this;
  }

  recordAction(action: Action): this {
    this.action = action;
    return this;
  }

  recordToolCall(name: string, input: unknown, id?: string): this {
    this.action = {
      kind: "tool_call",
      tool_name: name,
      tool_use_id: id,
      tool_input: input,
    };
    return this;
  }

  recordMessage(text: string): this {
    this.action = { kind: "message", text };
    return this;
  }

  recordOutcome(opts: RecordOutcomeOptions): this {
    this.outcome = opts.outcome;
    return this;
  }

  recordToolResult(
    content: unknown,
    opts?: { isError?: boolean; summary?: string },
  ): this {
    this.outcome = {
      status: opts?.isError ? "error" : "ok",
      is_error: opts?.isError === true,
      summary: opts?.summary,
    };
    (this as { _pendingToolResult?: unknown })._pendingToolResult = content;
    return this;
  }

  recordTokens(opts: RecordTokensOptions): this {
    this.tokens = opts.tokens;
    if (opts.latency_ms !== undefined) this.explicitLatency = opts.latency_ms;
    return this;
  }

  tag(tag: string): this {
    if (!this.tags.includes(tag)) this.tags.push(tag);
    return this;
  }

  /**
   * Persist the step. Idempotent on re-call. Returns the Step row.
   */
  async end(): Promise<Step> {
    if (this.ended) {
      throw new Error("MeterbilityStep.end() called twice");
    }
    this.ended = true;

    // Persist any content blobs referenced by the context. Each
    // content_ref in the snapshot is the actual blob sha256, so the
    // step can be replayed by reading the blob back.
    this.context = await buildContextComponents(
      this.tracer.store,
      this.startOptions,
    );

    // Persist context snapshot.
    const snapshot: ContextSnapshot = {
      id: hashJson(this.context),
      components: this.context,
    };
    const snapBlobRef = await this.tracer.store.blobs.putJson(snapshot);
    recordContextSnapshot(
      this.tracer.store,
      snapshot.id,
      snapBlobRef,
      snapshot.components.length,
    );

    // Persist decision blob (caller's raw model output, JSON-shaped).
    const decisionRef = await this.tracer.store.blobs.putJson(
      this.decisionContent ?? null,
    );

    // Persist tool result if recordToolResult was called.
    const pending = (this as { _pendingToolResult?: unknown })
      ._pendingToolResult;
    if (pending !== undefined) {
      const ref = await this.tracer.store.blobs.putJson(pending);
      this.outcome = { ...this.outcome, tool_result_ref: ref };
    }

    const latency_ms =
      this.explicitLatency !== undefined
        ? this.explicitLatency
        : Date.now() - this.startedAtMs;

    const { cost_cents, approx } = costCents(this.model, {
      input: this.tokens.input,
      output: this.tokens.output,
      cached_read: this.tokens.cached_read,
      cache_creation: this.tokens.cache_creation,
      cache_creation_1h: this.tokens.cache_creation_1h,
    });
    if (approx && !this.tags.includes("cost:approx")) {
      this.tags.push("cost:approx");
    }

    const status: Step["status"] =
      this.outcome.status === "error"
        ? "error"
        : this.outcome.status === "pending"
          ? "in_progress"
          : "ok";

    const step: Step = {
      step_id: this.step_id,
      run_id: this.tracer.run_id,
      parent_step_id: this.parent_step_id,
      sequence: this.sequence,
      timestamp: this.startedAtIso,
      model: this.model,
      context_snapshot_id: snapshot.id,
      decision_ref: decisionRef,
      action: this.action,
      outcome: this.outcome,
      tokens: this.tokens,
      latency_ms,
      cost_cents,
      tags: this.tags,
      status,
    };
    insertStep(this.tracer.store, step);
    this.tracer._stepCompleted(status);
    this.tracer._refreshTotals();
    return step;
  }
}

async function buildContextComponents(
  store: import("@meterbility/collector").Store,
  opts: StartStepOptions,
): Promise<ContextComponent[]> {
  const components: ContextComponent[] = [];
  if (opts.systemPrompt !== undefined) {
    const content_ref = await store.blobs.putString(opts.systemPrompt);
    components.push({ type: "system_prompt", content_ref });
  }
  if (opts.toolDefinitions !== undefined) {
    const content_ref = await store.blobs.putJson(opts.toolDefinitions);
    components.push({ type: "tool_definitions", content_ref });
  }
  if (opts.history && opts.history.length > 0) {
    const messages: ConversationMessage[] = [];
    for (const m of opts.history) {
      messages.push({
        role: m.role,
        content_ref: await store.blobs.putString(m.content),
      });
    }
    components.push({ type: "conversation_history", messages });
  }
  if (opts.retrievedDocs && opts.retrievedDocs.length > 0) {
    const docs = [];
    for (const d of opts.retrievedDocs) {
      docs.push({
        source: d.source,
        content_ref: await store.blobs.putString(d.content),
      });
    }
    components.push({ type: "retrieved_documents", docs });
  }
  if (opts.extraComponents) components.push(...opts.extraComponents);
  return components;
}
