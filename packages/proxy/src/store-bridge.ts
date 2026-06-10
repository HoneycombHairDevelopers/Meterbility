import { randomUUID } from "node:crypto";
import {
  type Store,
  insertRun,
  insertStep,
  recordContextSnapshot,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool-ai/collector";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  Outcome,
  Run,
  Step,
  TokenUsage,
} from "@spool-ai/shared";
import { hashJson } from "@spool-ai/shared";
import { costCents } from "@spool-ai/spec";

/**
 * Thin write layer between captured exchanges and the Spool store.
 * Mirrors the same insert pipeline `@spool-ai/agent`'s SpoolStep uses:
 *
 *   1. Persist context blobs (system prompt, tool defs, history msgs).
 *   2. Hash + insert the snapshot row.
 *   3. Persist the decision blob.
 *   4. Insert the Step row.
 *   5. Bump Run totals.
 *
 * The proxy doesn't call this for every Step itself — instead it lets
 * the server.ts caller resolve the Run via RunGrouper, then calls
 * `ensureRun()` once on first sighting and `appendStep()` per request.
 */

export interface ProjectAgentSpec {
  project: string;
  agent: string;
}

export function ensureRun(
  store: Store,
  spec: ProjectAgentSpec,
  run_id: string,
  opts: {
    title?: string;
    cwd?: string;
    git_branch?: string;
  } = {},
): void {
  const project = upsertProjectByCwd(store, spec.project, spec.project);
  const agent = upsertAgent(store, project.project_id, spec.agent);
  const run: Run = {
    run_id,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "proxy",
    title: opts.title ?? "(proxy capture)",
    status: "in_progress",
    started_at: new Date().toISOString(),
    git_branch: opts.git_branch,
    cwd: opts.cwd ?? spec.project,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: ["source:proxy"],
  };
  insertRun(store, run);
}

export interface AppendStepArgs {
  run_id: string;
  sequence: number;
  parent_step_id?: string;
  model: string;
  systemPrompt?: string;
  toolDefinitions?: unknown;
  history: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  decisionJson: string;
  action: Action;
  tokens: TokenUsage;
  latency_ms: number;
  outcome: Outcome;
}

export async function appendStep(
  store: Store,
  args: AppendStepArgs,
): Promise<Step> {
  const components: ContextComponent[] = [];
  if (args.systemPrompt !== undefined) {
    components.push({
      type: "system_prompt",
      content_ref: await store.blobs.putString(args.systemPrompt),
    });
  }
  if (args.toolDefinitions !== undefined) {
    components.push({
      type: "tool_definitions",
      content_ref: await store.blobs.putJson(args.toolDefinitions),
    });
  }
  if (args.history.length > 0) {
    const messages: ConversationMessage[] = [];
    for (const m of args.history) {
      messages.push({
        role: m.role,
        content_ref: await store.blobs.putString(m.content),
      });
    }
    components.push({ type: "conversation_history", messages });
  }

  const snapshot: ContextSnapshot = {
    id: hashJson(components),
    components,
  };
  const snapBlobRef = await store.blobs.putJson(snapshot);
  recordContextSnapshot(
    store,
    snapshot.id,
    snapBlobRef,
    snapshot.components.length,
  );

  const decisionRef = await store.blobs.putString(args.decisionJson);

  const { cost_cents, approx } = costCents(args.model, {
    input: args.tokens.input,
    output: args.tokens.output,
    cached_read: args.tokens.cached_read,
    cache_creation: args.tokens.cache_creation,
    cache_creation_1h: args.tokens.cache_creation_1h,
  });

  const tags = ["source:proxy"];
  if (approx) tags.push("cost:approx");

  const step: Step = {
    step_id: `stp_${randomUUID()}`,
    run_id: args.run_id,
    parent_step_id: args.parent_step_id,
    sequence: args.sequence,
    timestamp: new Date().toISOString(),
    model: args.model,
    context_snapshot_id: snapshot.id,
    decision_ref: decisionRef,
    action: args.action,
    outcome: args.outcome,
    tokens: args.tokens,
    latency_ms: args.latency_ms,
    cost_cents,
    tags,
    status: args.outcome.status === "error" ? "error" : "ok",
  };
  insertStep(store, step);
  updateRunTotals(store, args.run_id);
  return step;
}

/**
 * After a tool call's result arrives in a *subsequent* request's
 * `pendingToolResults`, retro-attach it to the original step's outcome
 * by overwriting the row with the tool_result_ref filled in.
 *
 * SQLite's `INSERT OR REPLACE` semantics in `insertStep` make this
 * cheap — we just rebuild the Step with the new outcome.
 */
export async function attachToolResult(
  store: Store,
  step: Step,
  toolResultText: string,
  isError: boolean,
): Promise<void> {
  const tool_result_ref = await store.blobs.putString(toolResultText);
  const outcome: Outcome = {
    status: isError ? "error" : "ok",
    is_error: isError,
    tool_result_ref,
    summary: toolResultText.slice(0, 200),
  };
  insertStep(store, {
    ...step,
    outcome,
    status: isError ? "error" : "ok",
  });
}

export function sealRun(store: Store, run_id: string, status: Run["status"]): void {
  setRunStatus(store, run_id, status, new Date().toISOString());
  updateRunTotals(store, run_id);
}
