import { randomUUID } from "node:crypto";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  Outcome,
  Run,
  Step,
  TokenUsage,
} from "@meterbility/shared";
import { hashJson } from "@meterbility/shared";
import {
  getRunBySessionId,
  insertRun,
  insertStep,
  recordContextSnapshot,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import { CursorDb, isMeaningfulComposer } from "./parser.ts";
import {
  bubbleText,
  isAssistantBubble,
  isUserBubble,
  type CursorBubble,
  type CursorComposerData,
} from "./types.ts";

const SOURCE_RUNTIME = "cursor" as const;

export interface CursorIngestResult {
  workspace_id?: string;
  composers_seen: number;
  composers_ingested: number;
  steps_added: number;
  status: "ok" | "no_db" | "no_composers";
  reason?: string;
}

export interface IngestCursorOptions {
  /** Override the path to Cursor's global state.vscdb. */
  dbPath?: string;
  /** Restrict to one composer id. */
  composerId?: string;
  /** Skip composers older than this (epoch ms). */
  sinceMs?: number;
  /** Only ingest the N newest composers. */
  limit?: number;
  /** Project cwd to attribute the run to (defaults to "(cursor)"). */
  cwd?: string;
}

/**
 * Ingest Cursor composer conversations from the global state.vscdb.
 *
 * Each composer becomes one Meterbility Run. Each bubble becomes one Step:
 *   - user bubbles (type=1) become "message" steps with the user text
 *     as the action.
 *   - assistant bubbles (type=2) become either tool_call steps (when
 *     `toolFormerData` is present) or message steps (when `text` is
 *     non-empty).
 *
 * Cursor doesn't expose system prompts in the SQLite (they're injected
 * server-side), and per-step token usage is sparse. We capture what we
 * can and tag steps with `cost:approx` where cost is a wild estimate.
 */
export async function ingestCursorGlobal(
  store: Store,
  opts: IngestCursorOptions = {},
): Promise<CursorIngestResult> {
  const { dbPath } = await import("./discover.ts").then((m) => ({
    dbPath: opts.dbPath ?? m.defaultGlobalDbPath(),
  }));

  let cursor: CursorDb;
  try {
    cursor = new CursorDb(dbPath);
  } catch (err) {
    return {
      composers_seen: 0,
      composers_ingested: 0,
      steps_added: 0,
      status: "no_db",
      reason: `cannot open ${dbPath}: ${(err as Error).message}`,
    };
  }
  try {
    if (!cursor.hasCursorDiskKV()) {
      return {
        composers_seen: 0,
        composers_ingested: 0,
        steps_added: 0,
        status: "no_db",
        reason: "cursorDiskKV table missing — schema may have changed",
      };
    }

    let composers = cursor.listComposers().filter(isMeaningfulComposer);
    if (opts.composerId) {
      composers = composers.filter((c) => c.composerId === opts.composerId);
    }
    if (opts.sinceMs !== undefined) {
      composers = composers.filter(
        (c) =>
          (c.lastUpdatedAt ?? c.createdAt ?? 0) >= opts.sinceMs!,
      );
    }
    composers.sort(
      (a, b) =>
        (b.lastUpdatedAt ?? b.createdAt ?? 0) -
        (a.lastUpdatedAt ?? a.createdAt ?? 0),
    );
    if (opts.limit) composers = composers.slice(0, opts.limit);

    if (composers.length === 0) {
      return {
        composers_seen: 0,
        composers_ingested: 0,
        steps_added: 0,
        status: "no_composers",
        reason: "no Cursor composers matched the filter",
      };
    }

    const cwd = opts.cwd ?? "(cursor)";
    const project = upsertProjectByCwd(store, cwd, "cursor");
    const agent = upsertAgent(store, project.project_id, "cursor");

    let composersIngested = 0;
    let stepsAdded = 0;
    for (const comp of composers) {
      const result = await ingestOneComposer(store, cursor, comp, {
        projectId: project.project_id,
        agentId: agent.agent_id,
        cwd,
      });
      composersIngested += 1;
      stepsAdded += result.steps_added;
    }

    return {
      composers_seen: composers.length,
      composers_ingested: composersIngested,
      steps_added: stepsAdded,
      status: "ok",
    };
  } finally {
    cursor.close();
  }
}

interface ComposerIngestArgs {
  projectId: string;
  agentId: string;
  cwd: string;
}

async function ingestOneComposer(
  store: Store,
  cursor: CursorDb,
  comp: CursorComposerData,
  args: ComposerIngestArgs,
): Promise<{ steps_added: number }> {
  const sessionId = comp.composerId;
  const existing = getRunBySessionId(store, sessionId);
  let runId: string;
  if (existing) {
    runId = existing.run_id;
  } else {
    runId = `run_${randomUUID()}`;
    const run: Run = {
      run_id: runId,
      agent_id: args.agentId,
      project_id: args.projectId,
      source_session_id: sessionId,
      source_runtime: SOURCE_RUNTIME,
      title: comp.name ?? comp.subtitle,
      status: composerStatus(comp),
      started_at: epochMsToIso(comp.createdAt) ?? new Date().toISOString(),
      ended_at: epochMsToIso(comp.lastUpdatedAt),
      git_branch: undefined,
      cwd: args.cwd,
      tokens_total_input: 0,
      tokens_total_output: 0,
      tokens_total_cached: 0,
      cost_cents: 0,
      step_count: 0,
      tags: ["cost:approx", "cursor", `mode:${comp.unifiedMode ?? "?"}`],
    };
    insertRun(store, run);
  }

  // History accumulates as we walk bubbles in order. Each assistant step
  // sees all prior user/assistant bubbles in its context snapshot.
  const history: ConversationMessage[] = [];
  let sequence = existing ? (existing.step_count ?? 0) : 0;
  let prevStepId: string | undefined;
  let stepsAdded = 0;

  for (const bubble of cursor.iterBubbles(comp)) {
    const text = bubbleText(bubble);

    if (isUserBubble(bubble)) {
      // User bubbles become history entries. We *also* persist them as
      // Steps so the operator can scrub through user turns in the
      // inspector — Meterbility's mental model is "one Step per turn,"
      // regardless of speaker.
      const ref = await store.blobs.putString(text);
      history.push({ role: "user", content_ref: ref });

      const components = await snapshotComponents(history);
      const snapshot: ContextSnapshot = {
        id: hashJson(components),
        components,
      };
      const blobRef = await store.blobs.putJson(snapshot);
      recordContextSnapshot(store, snapshot.id, blobRef, snapshot.components.length);

      const decisionRef = await store.blobs.putString(text);
      const stepId = `stp_${randomUUID()}`;
      const step: Step = {
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: bubble.createdAt ?? new Date().toISOString(),
        model: "user",
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action: { kind: "message", text },
        outcome: { status: "ok" },
        tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
        latency_ms: 0,
        cost_cents: 0,
        tags: ["cursor", "user-turn"],
        status: "ok",
      };
      insertStep(store, step);
      prevStepId = stepId;
      sequence += 1;
      stepsAdded += 1;
      continue;
    }

    if (isAssistantBubble(bubble)) {
      const components = await snapshotComponents(history);
      const snapshot: ContextSnapshot = {
        id: hashJson(components),
        components,
      };
      const blobRef = await store.blobs.putJson(snapshot);
      recordContextSnapshot(store, snapshot.id, blobRef, snapshot.components.length);

      const action = bubbleToAction(bubble, text);
      const outcome = await bubbleToOutcome(store, bubble);

      const decisionRef = await store.blobs.putJson({
        text,
        thinking: bubble.allThinkingBlocks,
        codeBlocks: bubble.codeBlocks,
        toolFormer: bubble.toolFormerData,
      });

      const tokens: TokenUsage = {
        input: bubble.tokenCount?.inputTokens ?? 0,
        output: bubble.tokenCount?.outputTokens ?? 0,
        cached_read: 0,
        cache_creation: 0,
      };

      const stepId = `stp_${randomUUID()}`;
      const step: Step = {
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: bubble.createdAt ?? new Date().toISOString(),
        model: modelFromComposer(comp) ?? "cursor",
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action,
        outcome,
        tokens,
        latency_ms: 0,
        cost_cents: 0,
        tags: ["cost:approx", "cursor"],
        status:
          outcome.status === "error"
            ? "error"
            : outcome.status === "pending"
              ? "in_progress"
              : "ok",
      };
      insertStep(store, step);
      prevStepId = stepId;
      sequence += 1;
      stepsAdded += 1;

      // Append a synthetic assistant entry to history so subsequent
      // bubbles see the prior turn.
      const assistantText =
        text || (bubble.toolFormerData?.name ? `[${bubble.toolFormerData.name}]` : "");
      const aref = await store.blobs.putString(assistantText);
      history.push({ role: "assistant", content_ref: aref });
      continue;
    }
  }

  setRunStatus(store, runId, composerStatus(comp), epochMsToIso(comp.lastUpdatedAt));
  updateRunTotals(store, runId);
  return { steps_added: stepsAdded };
}

async function snapshotComponents(
  history: ConversationMessage[],
): Promise<ContextComponent[]> {
  if (history.length === 0) return [];
  return [{ type: "conversation_history", messages: [...history] }];
}

function bubbleToAction(bubble: CursorBubble, text: string): Action {
  const tf = bubble.toolFormerData;
  if (tf?.name) {
    return {
      kind: "tool_call",
      tool_name: tf.name,
      tool_use_id: tf.toolCallId ?? tf.modelCallId,
      tool_input: parseMaybeJson(tf.params) ?? parseMaybeJson(tf.rawArgs),
    };
  }
  if (text && text.trim().length > 0) {
    return { kind: "message", text };
  }
  if (bubble.allThinkingBlocks && bubble.allThinkingBlocks.length > 0) {
    return { kind: "thinking_only" };
  }
  return { kind: "none" };
}

async function bubbleToOutcome(
  store: Store,
  bubble: CursorBubble,
): Promise<Outcome> {
  const tf = bubble.toolFormerData;
  if (!tf) return { status: "ok" };
  if (tf.status === "errored") {
    const ref = tf.result
      ? await store.blobs.putJson(tf.result)
      : undefined;
    return {
      status: "error",
      is_error: true,
      tool_result_ref: ref,
      summary:
        typeof tf.result === "string"
          ? tf.result.slice(0, 200)
          : "tool errored",
    };
  }
  if (tf.status === "completed" && tf.result !== undefined) {
    const ref = await store.blobs.putJson(tf.result);
    return {
      status: "ok",
      tool_result_ref: ref,
      summary:
        typeof tf.result === "string"
          ? tf.result.split("\n")[0]?.slice(0, 200)
          : undefined,
    };
  }
  if (tf.status === "pending") return { status: "pending" };
  return { status: "ok" };
}

function composerStatus(c: CursorComposerData): Run["status"] {
  switch (c.status) {
    case "completed":
      return "ok";
    case "error":
    case "errored":
      return "error";
    case "abandoned":
      return "abandoned";
    default:
      return "in_progress";
  }
}

function modelFromComposer(c: CursorComposerData): string | undefined {
  const cfg = c.modelConfig;
  if (cfg && typeof cfg === "object") {
    const m = (cfg as { model?: string; name?: string }).model ??
      (cfg as { name?: string }).name;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function epochMsToIso(ms?: number): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}
