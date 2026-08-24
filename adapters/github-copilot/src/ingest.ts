import { basename, dirname } from "node:path";
import { stat } from "node:fs/promises";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  FileChange,
  Outcome,
  Run,
  Step,
} from "@meterbility/shared";
import {
  deterministicStepId,
  diffLines,
  hashJson,
  redactString,
} from "@meterbility/shared";
import { costCents } from "@meterbility/spec";
import {
  getIngestOffset,
  getRun,
  getRunBySessionId,
  insertAnnotation,
  insertFileChange,
  insertRun,
  insertStep,
  recordContextSnapshot,
  setIngestOffset,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import { readEvents, endOffset, type ParsedEvent } from "./parser.ts";
import { workspaceCwd } from "./discover.ts";
import { CopilotShapeProbe } from "./shape_probe.ts";
import {
  contentTextOf,
  normalizeUsage,
  sessionIdOf,
  subagentIdOf,
  subagentNameOf,
  subagentRoleOf,
  toolCallIdOf,
  toolInputOf,
  toolNameOf,
  type CopilotEvent,
} from "./types.ts";

const SOURCE_RUNTIME = "github-copilot" as const;
/** v0.6 provider identity: GitHub is the serving/billing provider for
 *  every Copilot session regardless of the underlying model; the model
 *  field carries the model. First non-proxy producer of the column. */
const PROVIDER = "github";
const ADAPTER_AUTHOR = "meter/github-copilot";

/** Tool names whose execution mutates files → partial_diff FileChange
 *  rows (fact/partial tier — events.jsonl carries tool inputs, not
 *  before/after file bytes). Exact vocabulary is a Phase 0 question;
 *  unknown mutating tools simply produce no row (never a crash). */
const MUTATING_TOOLS = new Map<string, "create" | "modify" | "delete">([
  ["create", "create"],
  ["write", "create"],
  ["write_file", "create"],
  ["edit", "modify"],
  ["edit_file", "modify"],
  ["str_replace", "modify"],
  ["str_replace_editor", "modify"],
  ["apply_patch", "modify"],
  ["insert", "modify"],
  ["delete_file", "delete"],
]);

export interface CopilotIngestResult {
  run_id: string;
  child_run_ids: string[];
  steps_added: number;
  file_changes_added: number;
  bytes_read: number;
  status: "ok" | "empty";
}

export interface CopilotIngestOptions {
  /** Override cwd attribution (defaults to workspace.yaml, then "(github-copilot)"). */
  cwd?: string;
}

/** In-memory build state for one run (parent or carved child). */
interface RunCtx {
  runId: string;
  isChild: boolean;
  title?: string;
  tags: string[];
  steps: Step[];
  fileChanges: FileChange[];
  seq: number;
  prevStepId?: string;
  history: ConversationMessage[];
  startedAt?: string;
  lastTs?: string;
  currentModel: string;
  /** Index into steps of the last assistant-origin step since turn_start. */
  turnAssistantIdx?: number;
  sawTurnStart: boolean;
  completed: boolean;
  sawError: boolean;
  lastEventType?: string;
  dispatch?: { parentCtx: RunCtx; stepIdx: number };
  parentRunId?: string;
  parentRunStepId?: string;
}

interface PendingTool {
  ctx: RunCtx;
  stepIdx: number;
  startTs?: string;
}

/**
 * Ingest one Copilot CLI session (events.jsonl). The whole carve —
 * parent run, carved child runs, dispatch steps, child steps, file
 * rows, ingest offset — commits in ONE better-sqlite3 transaction
 * (eng review 4A): a crash mid-carve leaves no partial fleet, and the
 * 1.5s live poll never observes half-state. Blob writes happen before
 * the transaction; orphaned blobs on failure are harmless (content-
 * addressed, `meter db gc` scope).
 *
 * Idempotent: every run/step/file-change id is deterministic, so
 * re-carving the whole file (the offset is only a change detector)
 * upserts in place. Byte-identical-DB verification is the M2 gate.
 *
 * Sub-agent carving is CORRELATION-ONLY (eng review T1): events route
 * to children by id/parentId ancestry. When the file carries no event
 * ids at all, no children are carved — the session stays one parent
 * run with `sub_agent_dispatch` steps + agent tags, because inferred
 * attribution must never be presented as recorded attribution. Events
 * whose parentId matches nothing land on the parent tagged
 * `copilot:unrouted` (eng review 1A) — never dropped.
 */
export async function ingestCopilotSession(
  store: Store,
  path: string,
  opts: CopilotIngestOptions = {},
): Promise<CopilotIngestResult> {
  const knownOffset = getIngestOffset(store, SOURCE_RUNTIME, path);
  const fileStat = await stat(path);
  if (fileStat.size <= knownOffset) {
    return {
      run_id: "",
      child_run_ids: [],
      steps_added: 0,
      file_changes_added: 0,
      bytes_read: 0,
      status: "empty",
    };
  }

  const parsed = await readEvents(path);
  if (parsed.length === 0) {
    return {
      run_id: "",
      child_run_ids: [],
      steps_added: 0,
      file_changes_added: 0,
      bytes_read: 0,
      status: "empty",
    };
  }

  const probe = new CopilotShapeProbe();
  for (const p of parsed) probe.probe(p.event);

  const sessionDir = dirname(path);
  const sessionId =
    parsed.map((p) => sessionIdOf(p.event)).find((s) => s !== undefined) ??
    basename(sessionDir);
  const cwd =
    opts.cwd ?? (await workspaceCwd(sessionDir)) ?? "(github-copilot)";

  // ── Pass 1: pure in-memory carve (async — blob writes happen here) ──
  const existing = getRunBySessionId(store, sessionId);
  const parentRunId =
    existing?.run_id ?? `run_${hashJson([SOURCE_RUNTIME, sessionId])}`;

  const parent: RunCtx = {
    runId: parentRunId,
    isChild: false,
    tags: ["copilot"],
    steps: [],
    fileChanges: [],
    seq: 0,
    history: [],
    currentModel: "unknown",
    sawTurnStart: false,
    completed: false,
    sawError: false,
  };

  const eventIndex = new Map<string, CopilotEvent>();
  for (const { event } of parsed) {
    if (typeof event.id === "string") eventIndex.set(event.id, event);
  }
  const hasCorrelationIds = eventIndex.size > 0;

  const childByStartEventId = new Map<string, RunCtx>();
  const childBySubagentId = new Map<string, RunCtx>();
  /** Memoized event-id → owning ctx (null = walks cleanly to root). */
  const ownerMemo = new Map<string, RunCtx | null>();
  const pendingTools = new Map<string, PendingTool>();
  const snapshots = new Map<string, { blob_ref: string; components: number }>();
  const compactionEventIds: string[] = [];

  const putJson = async (value: unknown): Promise<string> =>
    store.blobs.putJson(value);

  const snapshotFor = async (ctx: RunCtx): Promise<string> => {
    const components: ContextComponent[] = [
      { type: "conversation_history", messages: [...ctx.history] },
    ];
    const snap: ContextSnapshot = { id: hashJson(components), components };
    if (!snapshots.has(snap.id)) {
      const ref = await putJson(snap);
      snapshots.set(snap.id, { blob_ref: ref, components: components.length });
    }
    return snap.id;
  };

  /**
   * Resolve which run an event belongs to by walking its parentId
   * ancestry. Returns the owning ctx, or parent with `unrouted` when
   * the chain references an id we have never seen (drift/truncation).
   */
  const routeEvent = (event: CopilotEvent): { ctx: RunCtx; unrouted: boolean } => {
    if (!hasCorrelationIds) return { ctx: parent, unrouted: false };
    const sid = subagentIdOf(event);
    if (sid) {
      const bySid = childBySubagentId.get(sid);
      if (bySid) return { ctx: bySid, unrouted: false };
    }
    const visited: string[] = [];
    let cursor = event.parentId ?? undefined;
    let result: RunCtx | null = null;
    let unrouted = false;
    while (typeof cursor === "string") {
      const memo = ownerMemo.get(cursor);
      if (memo !== undefined) {
        result = memo;
        break;
      }
      const child = childByStartEventId.get(cursor);
      if (child) {
        result = child;
        break;
      }
      visited.push(cursor);
      const parentEvent = eventIndex.get(cursor);
      if (!parentEvent) {
        // Chain references an event we never parsed — drift, truncation,
        // or a missed subagent.started. Never drop: parent + tag (1A).
        unrouted = true;
        result = null;
        break;
      }
      cursor = parentEvent.parentId ?? undefined;
    }
    for (const id of visited) ownerMemo.set(id, result);
    return { ctx: result ?? parent, unrouted };
  };

  const zeroTokens = () => ({
    input: 0,
    output: 0,
    cached_read: 0,
    cache_creation: 0,
    cache_creation_1h: 0,
  });

  const addStep = async (
    ctx: RunCtx,
    event: CopilotEvent,
    idKey: string,
    action: Action,
    outcome: Outcome,
    extraTags: string[] = [],
  ): Promise<number> => {
    const decisionRef = await putJson({
      type: event.type ?? "<missing>",
      action,
    });
    const snapId = await snapshotFor(ctx);
    const stepId = deterministicStepId(ctx.runId, idKey);
    const step: Step = {
      step_id: stepId,
      run_id: ctx.runId,
      parent_step_id: ctx.prevStepId,
      sequence: ctx.seq,
      timestamp: event.timestamp ?? ctx.lastTs ?? new Date().toISOString(),
      model: ctx.currentModel,
      context_snapshot_id: snapId,
      decision_ref: decisionRef,
      action,
      outcome,
      tokens: zeroTokens(),
      latency_ms: 0,
      cost_cents: 0,
      tags: extraTags,
      status:
        outcome.status === "error"
          ? "error"
          : outcome.status === "pending"
            ? "in_progress"
            : "ok",
      provider: PROVIDER,
    };
    ctx.steps.push(step);
    ctx.prevStepId = stepId;
    ctx.seq += 1;
    return ctx.steps.length - 1;
  };

  const noteActivity = (ctx: RunCtx, event: CopilotEvent): void => {
    const ts = event.timestamp;
    if (ts) {
      if (!ctx.startedAt || ts < ctx.startedAt) ctx.startedAt = ts;
      if (!ctx.lastTs || ts > ctx.lastTs) ctx.lastTs = ts;
    }
    ctx.lastEventType = event.type;
  };

  for (const { event, offset } of parsed) {
    const type = event.type ?? "";
    const { ctx, unrouted } = routeEvent(event);
    const unroutedTags = unrouted ? ["copilot:unrouted"] : [];
    if (unrouted) probe.noteUnrouted(type || "<missing>");
    noteActivity(ctx, event);
    const idKey = event.id ?? `off_${offset}`;

    switch (true) {
      case type === "session.start": {
        const model = event.data?.model ?? event.data?.modelId;
        if (typeof model === "string") ctx.currentModel = model;
        break;
      }
      case type === "session.model_change": {
        const model = event.data?.model ?? event.data?.modelId;
        if (typeof model === "string") ctx.currentModel = model;
        break;
      }
      case type === "session.error": {
        ctx.sawError = true;
        break;
      }
      case type.startsWith("session.compaction"): {
        compactionEventIds.push(idKey);
        break;
      }
      case type === "user.message": {
        const text = contentTextOf(event) ?? "";
        const ref = await putJson({ role: "user", text });
        const idx = await addStep(
          ctx,
          event,
          idKey,
          { kind: "message", text },
          { status: "ok" },
          ["role:user", ...unroutedTags],
        );
        ctx.history.push({
          role: "user",
          content_ref: ref,
          step_ref: ctx.steps[idx]!.step_id,
        });
        break;
      }
      case type === "assistant.turn_start": {
        ctx.sawTurnStart = true;
        ctx.turnAssistantIdx = undefined;
        const model = event.data?.model ?? event.data?.modelId;
        if (typeof model === "string") ctx.currentModel = model;
        break;
      }
      case type === "assistant.message": {
        const text = contentTextOf(event) ?? "";
        const ref = await putJson({ role: "assistant", text });
        const idx = await addStep(
          ctx,
          event,
          idKey,
          { kind: "message", text },
          { status: "ok" },
          unroutedTags,
        );
        ctx.turnAssistantIdx = idx;
        ctx.history.push({
          role: "assistant",
          content_ref: ref,
          step_ref: ctx.steps[idx]!.step_id,
        });
        break;
      }
      case type === "assistant.turn_end": {
        const usage = normalizeUsage(event.data?.usage);
        if (!usage) break;
        let idx = ctx.turnAssistantIdx;
        if (idx === undefined) {
          // A turn that produced only tool executions (or nothing we
          // stepped) still burned tokens — carry them on a synthetic
          // usage step rather than losing them.
          idx = await addStep(
            ctx,
            event,
            `turn_${idKey}`,
            { kind: "none" },
            { status: "ok" },
            ["turn_usage", ...unroutedTags],
          );
        }
        const step = ctx.steps[idx]!;
        step.tokens = {
          input: usage.input,
          output: usage.output,
          cached_read: usage.cached_read,
          cache_creation: 0,
          cache_creation_1h: 0,
        };
        const priced = costCents(step.model, {
          input: usage.input,
          output: usage.output,
          cached_read: usage.cached_read,
          cache_creation: 0,
        });
        step.cost_cents = priced.cost_cents;
        // v0.6 cost honesty: unpriced models render "unpriced", never
        // $0.00; approx keeps the historical tag. Only tag when the
        // turn actually carried usage (it did — we're here).
        if (priced.unpriced) step.tags.push("cost:unpriced");
        else if (priced.approx) step.tags.push("cost:approx");
        if (usage.premium_requests > 0) {
          // Premium-request → cents multiplier is an open question
          // (design doc OQ3); record the count honestly, price later.
          step.tags.push(`premium_requests:${usage.premium_requests}`);
        }
        ctx.turnAssistantIdx = undefined;
        break;
      }
      case type === "tool.execution_start": {
        const toolName = toolNameOf(event) ?? "unknown";
        const rawInput = toolInputOf(event);
        const callId = toolCallIdOf(event) ?? idKey;
        const redactedInput = redactToolInput(rawInput);
        const idx = await addStep(
          ctx,
          event,
          idKey,
          {
            kind: "tool_call",
            tool_name: toolName,
            tool_use_id: callId,
            tool_input: redactedInput,
          },
          { status: "pending" },
          unroutedTags,
        );
        pendingTools.set(callId, { ctx, stepIdx: idx, startTs: event.timestamp });
        maybeFileChange(ctx, ctx.steps[idx]!, toolName, rawInput, callId);
        break;
      }
      case type === "tool.execution_complete": {
        const callId = toolCallIdOf(event);
        let pending = callId ? pendingTools.get(callId) : undefined;
        if (!pending) {
          // No correlation on the completion — resolve the ctx's oldest
          // unresolved tool step so a lone drift doesn't strand it.
          pending = [...pendingTools.values()].find(
            (p) => p.ctx === ctx && p.ctx.steps[p.stepIdx]!.outcome.status === "pending",
          );
        }
        if (!pending) break;
        if (callId) pendingTools.delete(callId);
        else {
          for (const [k, v] of pendingTools) {
            if (v === pending) {
              pendingTools.delete(k);
              break;
            }
          }
        }
        const step = pending.ctx.steps[pending.stepIdx]!;
        const isError =
          event.data?.success === false || event.data?.isError === true ||
          event.data?.error !== undefined;
        const resultPayload = event.data?.result ?? event.data?.output ?? event.data?.error;
        const resultRef =
          resultPayload !== undefined ? await putJson(resultPayload) : undefined;
        step.outcome = {
          status: isError ? "error" : "ok",
          is_error: isError,
          tool_result_ref: resultRef,
          summary: summarize(resultPayload),
        };
        step.status = isError ? "error" : "ok";
        if (pending.startTs && event.timestamp) {
          const ms = Date.parse(event.timestamp) - Date.parse(pending.startTs);
          if (Number.isFinite(ms) && ms >= 0) step.latency_ms = ms;
        }
        break;
      }
      case type === "subagent.started": {
        const name = subagentNameOf(event) ?? "subagent";
        const role = subagentRoleOf(event);
        const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const dispatchIdx = await addStep(
          ctx,
          event,
          idKey,
          {
            kind: "sub_agent_dispatch",
            sub_agent: name,
            tool_input: event.data?.description ?? undefined,
          },
          { status: "pending" },
          [`agent:${slug}`, ...unroutedTags],
        );
        if (!hasCorrelationIds || typeof event.id !== "string") {
          // Correlation-only carving (T1): without ids we cannot route
          // the child's events, so no child run exists — the dispatch
          // step and tags are the honest record.
          ctx.steps[dispatchIdx]!.outcome = { status: "ok" };
          ctx.steps[dispatchIdx]!.status = "ok";
          break;
        }
        const child: RunCtx = {
          runId: `run_${hashJson([sessionId, event.id])}`,
          isChild: true,
          title: name + (role ? ` — ${role}` : ""),
          tags: ["copilot", `agent:${slug}`, ...(role ? [`role:${slugify(role)}`] : [])],
          steps: [],
          fileChanges: [],
          seq: 0,
          history: [],
          currentModel: ctx.currentModel,
          sawTurnStart: false,
          completed: false,
          sawError: false,
          startedAt: event.timestamp,
          dispatch: { parentCtx: ctx, stepIdx: dispatchIdx },
          parentRunId: ctx.runId,
          parentRunStepId: ctx.steps[dispatchIdx]!.step_id,
        };
        childByStartEventId.set(event.id, child);
        const sid = subagentIdOf(event);
        if (sid) childBySubagentId.set(sid, child);
        ownerMemo.set(event.id, child);
        break;
      }
      case type === "subagent.completed": {
        // The completion may correlate by subagentId or by ancestry.
        const sid = subagentIdOf(event);
        const child =
          (sid ? childBySubagentId.get(sid) : undefined) ??
          (ctx.isChild ? ctx : undefined);
        if (!child) break;
        child.completed = true;
        noteActivity(child, event);
        if (child.dispatch) {
          const dispatchStep =
            child.dispatch.parentCtx.steps[child.dispatch.stepIdx]!;
          dispatchStep.outcome = {
            status: "ok",
            summary: summarize(event.data?.result),
          };
          dispatchStep.status = "ok";
        }
        break;
      }
      default: {
        // session.resume / session.info / tool.user_requested / unknown
        // types: activity noted (timestamps), no step. Unknown types
        // already produced a probe warning.
        break;
      }
    }
  }

  const children = [...new Set(childByStartEventId.values())];
  const allCtx = [parent, ...children];

  // Terminal-status inference per run.
  const parentStatus = inferStatus(parent);
  const parentTerminal = parentStatus === "ok" || parentStatus === "error";
  const statusOf = (ctx: RunCtx): Run["status"] => {
    if (!ctx.isChild) return parentStatus;
    if (ctx.completed) return ctx.sawError ? "error" : "ok";
    // Orphan child: abandoned once the parent session is over, still
    // in_progress while the parent is live (live tail case).
    return parentTerminal ? "abandoned" : "in_progress";
  };

  probe.report(sessionId);

  // ── Pass 2: one transaction — the whole carve commits or none of it ──
  const project = upsertProjectByCwd(store, cwd);
  const agent = upsertAgent(store, project.project_id, SOURCE_RUNTIME);
  let stepsAdded = 0;
  let fileChangesAdded = 0;

  const commit = store.db.transaction(() => {
    for (const ctx of allCtx) {
      const already = getRun(store, ctx.runId);
      if (!already) {
        const run: Run = {
          run_id: ctx.runId,
          agent_id: agent.agent_id,
          project_id: project.project_id,
          // Children get a derived session id (unique per child) so
          // getRunBySessionId(sessionId) always resolves the PARENT.
          source_session_id: ctx.isChild
            ? `${sessionId}:${ctx.runId.slice(4, 16)}`
            : sessionId,
          source_runtime: SOURCE_RUNTIME,
          title: ctx.title ?? titleOf(ctx),
          status: "in_progress",
          started_at: ctx.startedAt ?? new Date().toISOString(),
          cwd,
          tokens_total_input: 0,
          tokens_total_output: 0,
          tokens_total_cached: 0,
          cost_cents: 0,
          step_count: 0,
          tags: ctx.tags,
          provider: PROVIDER,
          parent_run_id: ctx.parentRunId,
          parent_run_step_id: ctx.parentRunStepId,
        };
        insertRun(store, run);
      }
    }
    for (const [snapId, s] of snapshots) {
      recordContextSnapshot(store, snapId, s.blob_ref, s.components);
    }
    for (const ctx of allCtx) {
      for (const step of ctx.steps) {
        insertStep(store, step);
        stepsAdded += 1;
      }
      for (const fc of ctx.fileChanges) {
        try {
          insertFileChange(store, fc);
          fileChangesAdded += 1;
        } catch (err) {
          const msg = (err as Error).message ?? "";
          if (!msg.includes("UNIQUE constraint failed")) throw err;
        }
      }
      setRunStatus(store, ctx.runId, statusOf(ctx), ctx.lastTs);
      updateRunTotals(store, ctx.runId);
    }
    // Compaction markers — idempotent via a note that carries the
    // event key; re-carves skip ones already recorded.
    for (const key of compactionEventIds) {
      const note = `copilot:${key}`;
      const exists = store.db
        .prepare(
          "SELECT 1 FROM annotations WHERE target_kind='run' AND target_id=? AND kind='context_compaction' AND note=?",
        )
        .get(parent.runId, note);
      if (!exists) {
        insertAnnotation(store, {
          targetKind: "run",
          targetId: parent.runId,
          author: ADAPTER_AUTHOR,
          kind: "context_compaction",
          note,
        });
      }
    }
    setIngestOffset(store, SOURCE_RUNTIME, path, endOffset(parsed, fileStat.size));
  });
  commit();

  return {
    run_id: parent.runId,
    child_run_ids: children.map((c) => c.runId),
    steps_added: stepsAdded,
    file_changes_added: fileChangesAdded,
    bytes_read: fileStat.size - knownOffset,
    status: "ok",
  };
}

function titleOf(ctx: RunCtx): string | undefined {
  const firstUser = ctx.steps.find(
    (s) => s.action.kind === "message" && s.tags.includes("role:user"),
  );
  const text = firstUser?.action.text;
  if (!text) return undefined;
  return text.split("\n")[0]!.slice(0, 80);
}

function inferStatus(ctx: RunCtx): Run["status"] {
  if (ctx.sawError && ctx.lastEventType === "session.error") return "error";
  switch (ctx.lastEventType) {
    case "assistant.message":
    case "assistant.turn_end":
    case "subagent.completed":
    case "session.info":
      return "ok";
    case "session.error":
      return "error";
    default:
      return "in_progress";
  }
}

function summarize(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  const text =
    typeof payload === "string" ? payload : safeStringify(payload) ?? "";
  if (!text) return undefined;
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function safeStringify(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/** Redact tool inputs before they land in steps.action_json (matches
 *  the v0.5.1 inline-capture convention). Structure survives; string
 *  payloads run through redactString. */
function redactToolInput(input: unknown): unknown {
  if (input === undefined || input === null) return undefined;
  const raw = safeStringify(input);
  if (raw === undefined) return undefined;
  const { text } = redactString(raw);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Emit a fact/partial-tier FileChange row for a mutating tool call.
 *  events.jsonl carries tool INPUTS, not file bytes, so every row is
 *  partial_diff with no blob refs; patch_text is derived from
 *  old/new-string style inputs when present. */
function maybeFileChange(
  ctx: RunCtx,
  step: Step,
  toolName: string,
  rawInput: unknown,
  callId: string,
): void {
  const op = MUTATING_TOOLS.get(toolName.toLowerCase());
  if (!op) return;
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const path = firstString(
    input.path,
    input.file_path,
    input.filePath,
    input.filename,
    input.target,
  );
  if (!path) return;

  let patchText: string | undefined;
  let linesAdded = 0;
  let linesRemoved = 0;
  const oldStr = firstString(input.old_str, input.oldText, input.old_string);
  const newStr = firstString(input.new_str, input.newText, input.new_string);
  const createContent = firstString(input.file_text, input.content, input.text);
  if (oldStr !== undefined && newStr !== undefined) {
    const d = diffLines(oldStr, newStr);
    patchText = d.unified || undefined;
    linesAdded = d.stats.added;
    linesRemoved = d.stats.removed;
  } else if (op === "create" && createContent !== undefined) {
    linesAdded = createContent.split(/\r?\n/).length;
  }
  if (patchText) {
    patchText = redactString(patchText).text;
  }

  const fc: FileChange = {
    file_change_id: `fc_${hashJson([step.step_id, path, callId])}`,
    run_id: ctx.runId,
    step_id: step.step_id,
    sequence: 0,
    tool_call_id: callId,
    derived_from: "tool_call",
    path: toRelative(path),
    op,
    partial_diff: true,
    gitignored: false,
    bom: false,
    patch_text: patchText,
    patch_format: patchText ? "unified" : undefined,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    source_tool_name: toolName,
    source_tool_input: redactToolInput(rawInput),
    redacted: false,
    created_at: step.timestamp,
  };
  ctx.fileChanges.push(fc);
}

function toRelative(p: string): string {
  // FileChange.path is repo-relative by contract; without the repo root
  // (events carry absolute or already-relative paths) we strip a
  // leading slash rather than guess. M2 aligns this with the shared
  // repo-relative helper when the duplication cluster moves to shared.
  return p.startsWith("/") ? p.slice(1) : p;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
