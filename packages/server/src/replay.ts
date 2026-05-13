import { randomUUID } from "node:crypto";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  ForkEdit,
  Outcome,
  Run,
  Step,
  TokenUsage,
} from "@spool/shared";
import { hashJson } from "@spool/shared";
import { costCents } from "@spool/spec";
import {
  getRun,
  getStep,
  insertRun,
  insertStep,
  listSteps,
  recordContextSnapshot,
  resolveSnapshotBlobRef,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool/collector";
import type { Store } from "@spool/collector";

/**
 * Replay engine. v0 implements two modes:
 *
 *   deterministic_prefix: walk steps 0..fork_point, recompute and persist
 *     context snapshots and decision refs from cached blobs. No external
 *     calls. The new run is a "shadow" of the original until the fork
 *     point, then live execution takes over (handled separately by the
 *     fork command).
 *
 *   fully_live: re-run from start with edit applied. Requires an
 *     Anthropic API key in ANTHROPIC_API_KEY. Not implemented in v0;
 *     reserved for v0.1.
 */

export type ReplayMode = "deterministic_prefix" | "fully_live";

export interface ReplayResult {
  run_id: string;
  prefix_steps: number;
}

/**
 * Materialize a deterministic-prefix copy of `originRunId` up to (and
 * including) `originStepId`. The resulting run shares all blob content
 * with the origin (content-addressed dedup) but has its own row in the
 * `runs` table and its own step rows. The Action and Outcome of the
 * fork-point step may be rewritten by the caller before calling
 * {@link liveSuffix}.
 */
export async function materializePrefix(
  store: Store,
  originRunId: string,
  forkStepId: string,
  edit: ForkEdit,
): Promise<ReplayResult> {
  const origin = getRun(store, originRunId);
  if (!origin) throw new Error(`unknown run: ${originRunId}`);
  const forkStep = getStep(store, forkStepId);
  if (!forkStep || forkStep.run_id !== originRunId) {
    throw new Error(
      `step ${forkStepId} does not belong to run ${originRunId}`,
    );
  }
  const allSteps = listSteps(store, originRunId);
  const prefix = allSteps.filter((s) => s.sequence <= forkStep.sequence);

  const newRunId = `run_${randomUUID()}`;
  const project = upsertProjectByCwd(store, origin.cwd ?? "(unknown)");
  const agent = upsertAgent(store, project.project_id, "fork");
  const startedAt = new Date().toISOString();

  const newRun: Run = {
    run_id: newRunId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_session_id: undefined,
    source_runtime: "fork",
    title: forkTitle(origin, edit),
    status: "in_progress",
    started_at: startedAt,
    git_branch: origin.git_branch,
    cwd: origin.cwd,
    fork_origin_run_id: originRunId,
    fork_origin_step_id: forkStepId,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: ["fork", `fork-edit:${edit.type}`],
  };
  insertRun(store, newRun);

  // Replay the prefix steps. The first N-1 are copied verbatim (different
  // step_ids, same content refs). The last step (the fork point) absorbs
  // the edit — we rewrite its context snapshot to include the edit.
  let prevId: string | undefined;
  for (const orig of prefix) {
    const isForkPoint = orig.step_id === forkStepId;
    const { step, snapshot } = isForkPoint
      ? await applyEditToStep(store, orig, edit)
      : copyStep(orig);
    step.run_id = newRunId;
    step.step_id = `stp_${randomUUID()}`;
    step.parent_step_id = prevId;
    step.fork_origin_id = isForkPoint ? orig.step_id : undefined;
    if (snapshot) {
      const ref = await store.blobs.putJson(snapshot);
      recordContextSnapshot(
        store,
        snapshot.id,
        ref,
        snapshot.components.length,
      );
      step.context_snapshot_id = snapshot.id;
    }
    if (isForkPoint) {
      // Mark the fork-point step's outcome pending — we don't yet have
      // a model response for the edited context.
      step.outcome = { status: "pending" };
      step.status = "in_progress";
    }
    insertStep(store, step);
    prevId = step.step_id;
  }

  updateRunTotals(store, newRunId);
  setRunStatus(store, newRunId, "in_progress");

  return { run_id: newRunId, prefix_steps: prefix.length };
}

function forkTitle(origin: Run, edit: ForkEdit): string {
  const base = origin.title ?? origin.run_id;
  return `Fork[${edit.type}] of ${base}`.slice(0, 120);
}

function copyStep(orig: Step): { step: Step; snapshot?: ContextSnapshot } {
  return {
    step: {
      ...orig,
      tokens: { ...orig.tokens },
      tags: [...orig.tags],
    },
  };
}

async function applyEditToStep(
  store: Store,
  step: Step,
  edit: ForkEdit,
): Promise<{ step: Step; snapshot: ContextSnapshot }> {
  const snapshot = await rewriteSnapshot(store, step.context_snapshot_id, edit);
  return { step: { ...step, tokens: { ...step.tokens }, tags: [...step.tags] }, snapshot };
}

/**
 * Read the origin step's context snapshot, apply the edit, return a new
 * snapshot. The new id is content-addressed off the rewritten components.
 */
export async function rewriteSnapshot(
  store: Store,
  snapshotId: string,
  edit: ForkEdit,
): Promise<ContextSnapshot> {
  const ref = resolveSnapshotBlobRef(store, snapshotId);
  const base = await store.blobs.getJson<ContextSnapshot>(ref);
  const components: ContextComponent[] = [];
  let injected = false;
  for (const c of base.components) {
    if (
      edit.type === "replace_system_prompt" &&
      c.type === "system_prompt"
    ) {
      const text = String(
        (edit.payload as { text?: string } | null)?.text ?? "",
      );
      const ref = await store.blobs.putString(text);
      components.push({ type: "system_prompt", content_ref: ref });
      injected = true;
    } else if (
      edit.type === "replace_user_message" &&
      c.type === "conversation_history"
    ) {
      const stepRef = (edit.payload as { step_ref?: string } | null)?.step_ref;
      const text = String(
        (edit.payload as { text?: string } | null)?.text ?? "",
      );
      const ref = await store.blobs.putString(text);
      const newHistory: ConversationMessage[] = c.messages.map((m) => {
        if (stepRef && m.step_ref === stepRef && m.role === "user") {
          return { ...m, content_ref: ref };
        }
        return m;
      });
      // If no stepRef was specified, rewrite the most recent user message.
      if (!stepRef && newHistory.length > 0) {
        for (let i = newHistory.length - 1; i >= 0; i--) {
          if (newHistory[i]!.role === "user") {
            newHistory[i] = { ...newHistory[i]!, content_ref: ref };
            break;
          }
        }
      }
      components.push({ type: "conversation_history", messages: newHistory });
    } else if (
      edit.type === "inject_message" &&
      c.type === "conversation_history"
    ) {
      const text = String(
        (edit.payload as { text?: string } | null)?.text ?? "",
      );
      const role =
        ((edit.payload as { role?: string } | null)?.role ?? "user") === "assistant"
          ? "assistant"
          : "user";
      const ref = await store.blobs.putString(text);
      components.push({
        type: "conversation_history",
        messages: [...c.messages, { role, content_ref: ref }],
      });
    } else {
      components.push(c);
    }
  }
  // For replace_system_prompt where the origin had no system_prompt
  // component, append one.
  if (edit.type === "replace_system_prompt" && !injected) {
    const text = String((edit.payload as { text?: string } | null)?.text ?? "");
    const ref = await store.blobs.putString(text);
    components.unshift({ type: "system_prompt", content_ref: ref });
  }
  // For inject_message where no history component existed, create one.
  if (
    edit.type === "inject_message" &&
    !components.some((c) => c.type === "conversation_history")
  ) {
    const text = String((edit.payload as { text?: string } | null)?.text ?? "");
    const role =
      ((edit.payload as { role?: string } | null)?.role ?? "user") === "assistant"
        ? "assistant"
        : "user";
    const ref = await store.blobs.putString(text);
    components.push({
      type: "conversation_history",
      messages: [{ role, content_ref: ref }],
    });
  }
  return { id: hashJson(components), components };
}

/**
 * Append one synthetic Step to a fork run carrying the live-suffix
 * result. Used after fork_point edit has been applied and the operator
 * has produced (or simulated) a new model response.
 */
export async function appendLiveStep(
  store: Store,
  runId: string,
  args: {
    model: string;
    action: Action;
    outcome: Outcome;
    tokens: TokenUsage;
    latency_ms: number;
    parent_step_id?: string;
    snapshot: ContextSnapshot;
    decisionContent: unknown;
  },
): Promise<Step> {
  const run = getRun(store, runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  // Use canonical run.run_id; runId may be a prefix.
  const prior = listSteps(store, run.run_id);
  const sequence = prior.length;
  const decisionRef = await store.blobs.putJson(args.decisionContent);
  const snapshotRef = await store.blobs.putJson(args.snapshot);
  recordContextSnapshot(
    store,
    args.snapshot.id,
    snapshotRef,
    args.snapshot.components.length,
  );
  const { cost_cents, approx } = costCents(args.model, {
    input: args.tokens.input,
    output: args.tokens.output,
    cached_read: args.tokens.cached_read,
    cache_creation: args.tokens.cache_creation,
  });
  const tags: string[] = ["live-suffix"];
  if (approx) tags.push("cost:approx");
  const step: Step = {
    step_id: `stp_${randomUUID()}`,
    run_id: runId,
    parent_step_id: args.parent_step_id ?? prior[prior.length - 1]?.step_id,
    sequence,
    timestamp: new Date().toISOString(),
    model: args.model,
    context_snapshot_id: args.snapshot.id,
    decision_ref: decisionRef,
    action: args.action,
    outcome: args.outcome,
    tokens: args.tokens,
    latency_ms: args.latency_ms,
    cost_cents,
    tags,
    status:
      args.outcome.status === "error"
        ? "error"
        : args.outcome.status === "pending"
          ? "in_progress"
          : "ok",
  };
  insertStep(store, step);
  updateRunTotals(store, runId);
  return step;
}
