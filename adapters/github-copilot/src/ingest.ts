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
  RESERVED_SEQUENCE_BASE,
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
import { readEvents } from "./parser.ts";
import { workspaceCwd } from "./discover.ts";
import { CopilotShapeProbe } from "./shape_probe.ts";
import {
  agentDisplayNameOf,
  contentTextOf,
  interactionIdOf,
  normalizeUsage,
  outputTokensOf,
  sessionIdOf,
  squadIdentityOfText,
  subagentIdOf,
  subagentNameOf,
  subagentRoleOf,
  toolCallIdOf,
  toolInputOf,
  toolNameOf,
  turnIdOf,
  type CopilotEvent,
} from "./types.ts";

const SOURCE_RUNTIME = "github-copilot" as const;
/** v0.6 provider identity: GitHub is the serving/billing provider for
 *  every Copilot session regardless of the underlying model; the model
 *  field carries the model. First non-proxy producer of the column. */
const PROVIDER = "github";
const ADAPTER_AUTHOR = "meter/github-copilot";

/** Session-level events that mean "the conversation is at rest" — the
 *  session infers `ok` when the file ends on one of these. */
const SESSION_AT_REST_EVENTS = new Set([
  "assistant.message",
  "assistant.turn_end",
  "subagent.completed",
  "session.info",
  "session.end",
  // Real Copilot CLI (≥1.0) closes every session with a shutdown event
  // carrying the session-total token breakdown.
  "session.shutdown",
  "session.usage_checkpoint",
]);
/** A session whose newest event is older than this and not at rest is
 *  inferred `abandoned` (crashed / killed mid-turn). Mirrors the design
 *  doc's staleness-window requirement for run-status inference. */
const STALE_SESSION_MS = 30 * 60_000;
/** Combined old+new size above which str_replace-style inputs get
 *  whole-block line counts instead of a real diff — diffLines is
 *  O(n*m) in lines and session files are untrusted input. */
const DIFF_INPUT_CAP_BYTES = 512_000;

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
  // Equal size = unchanged = no-op. A SMALLER file means the CLI
  // truncated/rewrote it (compaction, session reset) — fall through and
  // re-carve the new content rather than reporting "empty" forever.
  if (fileStat.size === knownOffset) {
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

  // ── Real-shape (Copilot CLI ≥1.0) stream indices ────────────────────
  // Real files are a FLAT linked list: every event's parentId is simply
  // the previous line, so ancestry carries no routing signal. The real
  // per-agent stream key is `interactionId` (main thread + one per
  // spawned agent). The joins, all correlation-only:
  //   task tool.execution_start (toolCallId → spawn prompt/description)
  //   subagent.started/completed (same toolCallId)
  //   child's first user.message (content === spawn prompt) → binds the
  //     child's interactionId
  //   tool.execution_complete carries interactionId; execution_start
  //     does not (joined via toolCallId)
  //   assistant.turn_end carries only turnId (joined via turn_start)
  const taskDispatches = new Map<
    string,
    { prompt?: string; description?: string; ownerAtDispatch?: RunCtx }
  >();
  const childByToolCallId = new Map<string, RunCtx>();
  const childByInteraction = new Map<string, RunCtx>();
  const iidByToolCall = new Map<string, string>();
  const iidByTurnId = new Map<string, string>();
  let hasInteractionIds = false;
  for (const { event } of parsed) {
    const iid = interactionIdOf(event);
    if (!iid) continue;
    hasInteractionIds = true;
    if (event.type === "tool.execution_complete") {
      const tcid = toolCallIdOf(event);
      if (tcid && !iidByToolCall.has(tcid)) iidByToolCall.set(tcid, iid);
    }
  }
  // iidByTurnId is maintained INSIDE the main loop (turnIds restart per
  // interaction — "0", "1", … — so a whole-file pre-scan would let a
  // later stream's turn_start steal an earlier stream's turn_end; in
  // file order, a turn_end always follows its own turn_start).
  /** Memoized event-id → routing result (ctx null = walks cleanly to
   *  root). Carries the unrouted flag so every sibling on a broken
   *  chain gets the copilot:unrouted tag, not just the first walker. */
  const ownerMemo = new Map<string, { ctx: RunCtx | null; unrouted: boolean }>();
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
    // Real-shape routing: when the file carries interactionIds, they —
    // not the (flat) parentId chain — decide stream membership. An iid
    // not bound to any child is the main thread: parent, cleanly.
    if (hasInteractionIds) {
      const type = event.type ?? "";
      // subagent.* lifecycle events are handled by their own cases and
      // must not join through the task call's (main-thread) completion.
      if (!type.startsWith("subagent.")) {
        const iid = interactionIdOf(event);
        if (iid) {
          return { ctx: childByInteraction.get(iid) ?? parent, unrouted: false };
        }
        if (type === "tool.execution_start") {
          const tcid = toolCallIdOf(event);
          const jid = tcid ? iidByToolCall.get(tcid) : undefined;
          if (jid) {
            return { ctx: childByInteraction.get(jid) ?? parent, unrouted: false };
          }
        }
        if (type === "assistant.turn_end") {
          const tid = turnIdOf(event);
          const jid = tid ? iidByTurnId.get(tid) : undefined;
          if (jid) {
            return { ctx: childByInteraction.get(jid) ?? parent, unrouted: false };
          }
        }
      }
      // session.*, subagent.*, and anything iid-less: the parent owns it.
      // No unrouted tag — a flat chain is the real format's normal shape.
      return { ctx: parent, unrouted: false };
    }
    const sid = subagentIdOf(event);
    if (sid) {
      const bySid = childBySubagentId.get(sid);
      if (bySid) return { ctx: bySid, unrouted: false };
    }
    const visited = new Set<string>();
    let cursor = event.parentId ?? undefined;
    let result: RunCtx | null = null;
    let unrouted = false;
    while (typeof cursor === "string") {
      if (visited.has(cursor)) {
        // Cyclic parentId chain (self-referential or A→B→A) — corrupted
        // or adversarial file. Treat like a broken chain: parent + tag.
        // Without this check the walk spins forever on the event loop.
        unrouted = true;
        result = null;
        break;
      }
      const memo = ownerMemo.get(cursor);
      if (memo !== undefined) {
        result = memo.ctx;
        unrouted = memo.unrouted;
        break;
      }
      const child = childByStartEventId.get(cursor);
      if (child) {
        result = child;
        break;
      }
      visited.add(cursor);
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
    for (const id of visited) ownerMemo.set(id, { ctx: result, unrouted });
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
    // Bind a child's interaction stream BEFORE routing: the child's
    // first user.message is the spawn prompt verbatim (real shape), so
    // an exact content match against a recorded task dispatch claims
    // this interactionId for that child — including for this event.
    if (hasInteractionIds && type === "user.message") {
      const iid = interactionIdOf(event);
      if (iid && !childByInteraction.has(iid)) {
        const text = contentTextOf(event);
        if (text) {
          for (const [tcid, d] of taskDispatches) {
            if (d.prompt !== undefined && d.prompt === text) {
              const boundChild = childByToolCallId.get(tcid);
              if (boundChild) childByInteraction.set(iid, boundChild);
              break;
            }
          }
        }
      }
    }
    if (hasInteractionIds && type === "assistant.turn_start") {
      const tid = turnIdOf(event);
      const iid = interactionIdOf(event);
      if (tid && iid) iidByTurnId.set(tid, iid);
    }
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
        // Real events carry the serving model per message — more precise
        // than the session-level model_change stream.
        const msgModel = event.data?.model ?? event.data?.modelId;
        if (typeof msgModel === "string") ctx.currentModel = msgModel;
        const idx = await addStep(
          ctx,
          event,
          idKey,
          { kind: "message", text },
          { status: "ok" },
          unroutedTags,
        );
        // Real events carry per-message output token counts — the only
        // per-stream token signal in real files (turn_end has none).
        // Output-only is a cost FLOOR: tag it so nobody reads it as the
        // full spend.
        const outTok = outputTokensOf(event);
        if (outTok !== undefined) {
          const step = ctx.steps[idx]!;
          step.tokens.output = outTok;
          const priced = costCents(step.model, {
            input: 0,
            output: outTok,
            cached_read: 0,
            cache_creation: 0,
          });
          step.cost_cents = priced.cost_cents;
          if (priced.unpriced) step.tags.push("cost:unpriced");
          else step.tags.push("cost:approx", "tokens:output-only");
        }
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
        // Key scoped by owning run: Copilot may scope call ids per
        // agent subprocess, so two agents can legally reuse "call_1" —
        // a bare-callId key would silently attribute one agent's result
        // to the other's step (codex adversarial finding).
        pendingTools.set(`${ctx.runId}\u001f${callId}`, {
          ctx,
          stepIdx: idx,
          startTs: event.timestamp,
        });
        // Real-shape squad dispatch: the `task` tool call carries the
        // spawn prompt (identity source) and its toolCallId is the join
        // key for the subagent.started/completed pair that follows.
        if (toolName === "task") {
          const args =
            rawInput && typeof rawInput === "object"
              ? (rawInput as Record<string, unknown>)
              : {};
          taskDispatches.set(callId, {
            prompt: typeof args.prompt === "string" ? args.prompt : undefined,
            description:
              typeof args.description === "string" ? args.description : undefined,
            ownerAtDispatch: ctx,
          });
        }
        maybeFileChange(ctx, ctx.steps[idx]!, toolName, rawInput, callId, cwd);
        break;
      }
      case type === "tool.execution_complete": {
        const callId = toolCallIdOf(event);
        // Resolve in the completion's own routed run first; a bare
        // cross-run callId match is never trusted (see the scoped-key
        // note on tool.execution_start).
        let pendingKey = callId ? `${ctx.runId}\u001f${callId}` : undefined;
        let pending = pendingKey ? pendingTools.get(pendingKey) : undefined;
        if (!pending) {
          // No correlation on the completion (or it routed to a ctx that
          // never started this callId) — resolve the ctx's oldest
          // unresolved tool step so a lone drift doesn't strand it.
          pendingKey = undefined;
          pending = [...pendingTools.values()].find(
            (p) => p.ctx === ctx && p.ctx.steps[p.stepIdx]!.outcome.status === "pending",
          );
        }
        if (!pending) break;
        if (pendingKey) pendingTools.delete(pendingKey);
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
        // Real shape: the durable identity lives in the task dispatch's
        // spawn prompt ("You are Frontend, the UI engineer …"), joined
        // by toolCallId; the event's own agentName is a generic wrapper
        // ("task"). Prefer prompt identity, then display name, then the
        // legacy field/prompt fallbacks.
        const tcid = toolCallIdOf(event);
        const dispatch = tcid ? taskDispatches.get(tcid) : undefined;
        const promptIdentity = dispatch?.prompt
          ? squadIdentityOfText(dispatch.prompt)
          : {};
        const displayName = agentDisplayNameOf(event);
        const legacyName = subagentNameOf(event);
        const name =
          promptIdentity.name ??
          (legacyName && legacyName !== "task" ? legacyName : undefined) ??
          displayName ??
          legacyName ??
          "subagent";
        const role = promptIdentity.role ?? subagentRoleOf(event);
        const slug = slugify(name);
        // The dispatching run is whoever issued the matching task tool
        // call (correlation-only); routed ctx is the fallback.
        const dispatchCtx = dispatch?.ownerAtDispatch ?? ctx;
        const dispatchIdx = await addStep(
          dispatchCtx,
          event,
          idKey,
          {
            kind: "sub_agent_dispatch",
            sub_agent: name,
            tool_input:
              dispatch?.description ?? event.data?.description ?? undefined,
          },
          { status: "pending" },
          [`agent:${slug}`, ...unroutedTags],
        );
        if (!hasCorrelationIds || typeof event.id !== "string") {
          // Correlation-only carving (T1): without ids we cannot route
          // the child's events, so no child run exists — the dispatch
          // step and tags are the honest record.
          dispatchCtx.steps[dispatchIdx]!.outcome = { status: "ok" };
          dispatchCtx.steps[dispatchIdx]!.status = "ok";
          break;
        }
        const agentModel = event.data?.model;
        const child: RunCtx = {
          runId: `run_${hashJson([sessionId, event.id])}`,
          isChild: true,
          title: name + (role ? ` — ${role}` : ""),
          tags: ["copilot", `agent:${slug}`, ...(role ? [`role:${slugify(role)}`] : [])],
          steps: [],
          fileChanges: [],
          seq: 0,
          history: [],
          currentModel:
            typeof agentModel === "string" ? agentModel : dispatchCtx.currentModel,
          sawTurnStart: false,
          completed: false,
          sawError: false,
          startedAt: event.timestamp,
          dispatch: { parentCtx: dispatchCtx, stepIdx: dispatchIdx },
          parentRunId: dispatchCtx.runId,
          parentRunStepId: dispatchCtx.steps[dispatchIdx]!.step_id,
        };
        childByStartEventId.set(event.id, child);
        if (tcid) childByToolCallId.set(tcid, child);
        const sid = subagentIdOf(event);
        if (sid) childBySubagentId.set(sid, child);
        ownerMemo.set(event.id, { ctx: child, unrouted: false });
        break;
      }
      case type === "subagent.completed": {
        // Real shape correlates by toolCallId; older/synthetic shapes by
        // subagentId or ancestry.
        const tcid = toolCallIdOf(event);
        const sid = subagentIdOf(event);
        const child =
          (tcid ? childByToolCallId.get(tcid) : undefined) ??
          (sid ? childBySubagentId.get(sid) : undefined) ??
          (ctx.isChild ? ctx : undefined);
        if (!child) break;
        child.completed = true;
        noteActivity(child, event);
        // Real completions carry the agent's aggregate accounting —
        // token total (unsplit), tool-call count, wall duration. Tags,
        // not run totals: per-message outputTokens already sum honestly
        // and an unsplit aggregate would double-count against them.
        const totalTokens = event.data?.totalTokens;
        if (typeof totalTokens === "number" && totalTokens > 0) {
          child.tags.push(`agent_total_tokens:${totalTokens}`);
        }
        if (child.dispatch) {
          const dispatchStep =
            child.dispatch.parentCtx.steps[child.dispatch.stepIdx]!;
          dispatchStep.outcome = {
            status: "ok",
            summary: summarize(event.data?.result),
          };
          dispatchStep.status = "ok";
          const durationMs = event.data?.durationMs;
          if (typeof durationMs === "number" && durationMs > 0) {
            dispatchStep.latency_ms = durationMs;
          }
        }
        break;
      }
      case type === "session.shutdown": {
        // Session-total token breakdown (input/cache_read/cache_write/
        // output). Output tokens are already counted per-message on
        // their own steps; the INPUT side is counted nowhere else, so a
        // synthetic step carries it (tagged — inputs include the whole
        // fleet's requests, so it lives on the parent as session-level
        // accounting, not per-agent attribution).
        const td = event.data?.tokenDetails as
          | Record<string, { tokenCount?: number } | undefined>
          | undefined;
        const n = (k: string): number => {
          const v = td?.[k]?.tokenCount;
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
        };
        const input = n("input");
        const cachedRead = n("cache_read");
        const cacheWrite = n("cache_write");
        if (input + cachedRead + cacheWrite > 0) {
          const idx = await addStep(
            ctx,
            event,
            idKey,
            { kind: "none" },
            { status: "ok" },
            ["session_input_totals", ...unroutedTags],
          );
          const step = ctx.steps[idx]!;
          step.tokens = {
            input,
            output: 0,
            cached_read: cachedRead,
            cache_creation: cacheWrite,
            cache_creation_1h: 0,
          };
          const priced = costCents(step.model, {
            input,
            output: 0,
            cached_read: cachedRead,
            cache_creation: cacheWrite,
          });
          step.cost_cents = priced.cost_cents;
          if (priced.unpriced) step.tags.push("cost:unpriced");
          else step.tags.push("cost:approx");
        }
        const premium = event.data?.totalPremiumRequests;
        if (typeof premium === "number" && premium > 0) {
          ctx.tags.push(`premium_requests:${premium}`);
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

  // Terminal-status inference. Terminality is a SESSION-level property:
  // the last event in the whole file (regardless of which run it routed
  // to) plus a staleness window — a parent that went quiet after
  // dispatching agents is not "done" while its children still stream,
  // and a session whose last event is a child's completion must not
  // leave the parent in_progress forever. The staleness window covers
  // sessions that died mid-turn (crash, kill): once the file has been
  // silent past the window, non-terminal runs resolve to abandoned
  // instead of polluting the fleet as in_progress forever.
  const lastParsed = parsed[parsed.length - 1]!.event;
  const sessionLastType = lastParsed.type ?? "";
  const sessionLastTs = parent.lastTs ?? lastParsed.timestamp;
  const lastMs = sessionLastTs ? Date.parse(sessionLastTs) : NaN;
  const sessionStale =
    Number.isFinite(lastMs) && Date.now() - lastMs > STALE_SESSION_MS;
  const parentStatus: Run["status"] = (() => {
    if (parent.sawError && sessionLastType === "session.error") return "error";
    if (SESSION_AT_REST_EVENTS.has(sessionLastType)) return "ok";
    return sessionStale ? "abandoned" : "in_progress";
  })();
  // session.shutdown anywhere in the file is an authoritative end: the
  // CLI wrote its final accounting. Observed live (squad session 4):
  // the session can shut down "routine" while dispatched agents never
  // received a subagent.completed — those agents were cut off, and
  // waiting out the staleness window would report them in_progress for
  // 30 minutes after the session provably ended. A --resume append
  // re-carves the whole file and re-derives every status, so marking
  // abandoned here stays self-healing.
  const sessionShutdown = parsed.some(
    (p) => p.event.type === "session.shutdown",
  );
  const statusOf = (ctx: RunCtx): Run["status"] => {
    if (!ctx.isChild) return parentStatus;
    if (ctx.completed) return ctx.sawError ? "error" : "ok";
    if (sessionShutdown) return "abandoned";
    // No subagent.completed recorded: still in flight while the session
    // shows recent activity (live tail), abandoned once it goes stale.
    return sessionStale ? "abandoned" : "in_progress";
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
      } else {
        // Re-carve of a known run: title/tags/lineage are carve-derived
        // and can gain information as the live file grows (first user
        // message arrives after run creation, an agent's role parses on
        // a later tick) — or CORRECT itself when a better routing join
        // becomes available (a chain-shaped carve heals into siblings).
        // Steps upsert below; refresh the metadata too.
        store.db
          .prepare(
            "UPDATE runs SET title = ?, tags = ?, parent_run_id = ?, parent_run_step_id = ? WHERE run_id = ?",
          )
          .run(
            ctx.title ?? titleOf(ctx) ?? already.title ?? null,
            JSON.stringify(ctx.tags),
            ctx.parentRunId ?? null,
            ctx.parentRunStepId ?? null,
            ctx.runId,
          );
      }
    }
    for (const [snapId, s] of snapshots) {
      recordContextSnapshot(store, snapId, s.blob_ref, s.components);
    }
    for (const ctx of allCtx) {
      // Routing can legitimately change across re-carves of a growing
      // file (a torn subagent.started completes and its events move
      // from the parent to a freshly carved child; a rewritten file
      // shrinks). Deterministic ids include the run id, so relocated
      // steps get NEW ids — the stale rows under the old run must go,
      // or tokens/cost double-count. This MUST run BEFORE the upserts:
      // insertStep's (run_id, sequence) conflict arm reuses the
      // existing row's step_id, so a post-insert sweep would delete
      // rows that just absorbed new content. The reserved band
      // (hook/admin/checkpoint steps) is never ours to delete.
      const keepIds = JSON.stringify(ctx.steps.map((s) => s.step_id));
      store.db
        .prepare(
          `DELETE FROM file_change WHERE step_id IN (
             SELECT step_id FROM steps
             WHERE run_id = ? AND sequence < ?
               AND step_id NOT IN (SELECT value FROM json_each(?)))`,
        )
        .run(ctx.runId, RESERVED_SEQUENCE_BASE, keepIds);
      store.db
        .prepare(
          `DELETE FROM steps
           WHERE run_id = ? AND sequence < ?
             AND step_id NOT IN (SELECT value FROM json_each(?))`,
        )
        .run(ctx.runId, RESERVED_SEQUENCE_BASE, keepIds);
      for (const step of ctx.steps) {
        insertStep(store, step);
        stepsAdded += 1;
      }
      for (const fc of ctx.fileChanges) {
        try {
          insertFileChange(store, fc);
          fileChangesAdded += 1;
        } catch (err) {
          const code = (err as { code?: string }).code ?? "";
          if (
            code !== "SQLITE_CONSTRAINT_UNIQUE" &&
            code !== "SQLITE_CONSTRAINT_PRIMARYKEY"
          )
            throw err;
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
    // Watermark = the byte size we read, NOT endOffset(parsed): a
    // trailing torn line would leave endOffset short of the size and
    // force a full re-carve on every poll tick forever. When the torn
    // line completes, the file grows past this watermark and the
    // re-carve fires as intended.
    setIngestOffset(store, SOURCE_RUNTIME, path, fileStat.size);
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
 *  payloads run through redactString. `redacted` reports whether any
 *  replacement actually happened — consumers surface it honestly
 *  (FileChange.redacted). */
function redactToolInputVerbose(input: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (input === undefined || input === null)
    return { value: undefined, redacted: false };
  const raw = safeStringify(input);
  if (raw === undefined) return { value: undefined, redacted: false };
  const { text, redactions } = redactString(raw);
  const redacted = redactions.length > 0;
  try {
    return { value: JSON.parse(text), redacted };
  } catch {
    return { value: text, redacted };
  }
}

function redactToolInput(input: unknown): unknown {
  return redactToolInputVerbose(input).value;
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
  cwd?: string,
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
  let redacted = false;
  const oldStr = firstString(input.old_str, input.oldText, input.old_string);
  const newStr = firstString(input.new_str, input.newText, input.new_string);
  const createContent = firstString(input.file_text, input.content, input.text);
  if (oldStr !== undefined && newStr !== undefined) {
    if (oldStr.length + newStr.length <= DIFF_INPUT_CAP_BYTES) {
      const d = diffLines(oldStr, newStr);
      patchText = d.unified || undefined;
      linesAdded = d.stats.added;
      linesRemoved = d.stats.removed;
    } else {
      // diffLines allocates an O(n*m) table; untrusted session files
      // must not be able to exhaust memory / block the live poll with
      // one giant str_replace. Above the cap: whole-block line counts,
      // no patch text — the row stays honest via partial_diff.
      linesAdded = newStr.split(/\r?\n/).length;
      linesRemoved = oldStr.split(/\r?\n/).length;
    }
  } else if (op === "create" && createContent !== undefined) {
    linesAdded = createContent.split(/\r?\n/).length;
  }
  if (patchText) {
    const r = redactString(patchText);
    patchText = r.text;
    redacted ||= r.redactions.length > 0;
  }
  const redactedInput = redactToolInputVerbose(rawInput);
  redacted ||= redactedInput.redacted;

  const fc: FileChange = {
    file_change_id: `fc_${hashJson([step.step_id, path, callId])}`,
    run_id: ctx.runId,
    step_id: step.step_id,
    sequence: 0,
    tool_call_id: callId,
    derived_from: "tool_call",
    path: toRelative(path, cwd),
    op,
    partial_diff: true,
    gitignored: false,
    bom: false,
    patch_text: patchText,
    patch_format: patchText ? "unified" : undefined,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    source_tool_name: toolName,
    source_tool_input: redactedInput.value,
    redacted,
    created_at: step.timestamp,
  };
  ctx.fileChanges.push(fc);
}

function toRelative(p: string, cwd?: string): string {
  // FileChange.path is repo-relative by contract. When the session's
  // workspace cwd is known (workspace.yaml), absolute paths under it
  // relativize properly ("/repo/src/x.ts" → "src/x.ts"); otherwise we
  // strip a leading slash rather than guess a root.
  if (cwd && cwd.startsWith("/")) {
    const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (p.startsWith(root)) return p.slice(root.length);
    if (p === cwd || p === root) return ".";
  }
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
