import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  Outcome,
  Run,
  Step,
} from "@meterbility/shared";
import { hashJson } from "@meterbility/shared";
import {
  getIngestOffset,
  getRunBySessionId,
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
import {
  endOffset,
  readCodexSession,
  type ParsedCodexRecord,
} from "./parser.ts";
import {
  isFunctionCall,
  isFunctionCallOutput,
  isMessage,
  isResponseItem,
  textOfMessage,
  type CodexResponseItemFunctionCall,
  type CodexResponseItemFunctionCallOutput,
  type CodexResponseItemMessage,
  type CodexSessionMetaPayload,
} from "./types.ts";

const SOURCE_RUNTIME = "codex-cli" as const;

export interface CodexIngestResult {
  run_id: string;
  steps_added: number;
  bytes_read: number;
  status: "ok" | "empty";
}

/**
 * Ingest a Codex Desktop / Codex CLI rollout file. Maps each assistant
 * `response_item.message` (or `function_call`) to one Meterbility Step. The
 * preceding user message becomes the conversation history. If a
 * subsequent function_call_output matches a function_call's call_id, we
 * attach it as the Outcome.
 *
 * Codex doesn't expose token usage in the rollout JSONL, so token
 * counts are zero and steps are tagged `cost:approx`. The fork engine
 * still works — the conversation history is captured verbatim.
 */
export async function ingestCodexSession(
  store: Store,
  path: string,
): Promise<CodexIngestResult> {
  const offset = getIngestOffset(store, SOURCE_RUNTIME, path);
  const tail = await readCodexSession(path, offset);
  if (tail.length === 0) {
    return { run_id: "", steps_added: 0, bytes_read: 0, status: "empty" };
  }
  const fileStat = await stat(path);
  const fullSize = fileStat.size;

  const all = offset === 0 ? tail : await readCodexSession(path, 0);
  const meta = inferMeta(all);
  const sessionId = meta.id;

  const project = upsertProjectByCwd(store, meta.cwd ?? "(unknown)");
  const agent = upsertAgent(store, project.project_id, "codex-cli");

  const existing = sessionId
    ? getRunBySessionId(store, sessionId)
    : undefined;

  let runId: string;
  if (existing) {
    runId = existing.run_id;
  } else {
    runId = `run_${randomUUID()}`;
    const run: Run = {
      run_id: runId,
      agent_id: agent.agent_id,
      project_id: project.project_id,
      source_session_id: sessionId,
      source_runtime: SOURCE_RUNTIME,
      title: inferTitle(all),
      status: "in_progress",
      started_at: meta.timestamp ?? new Date().toISOString(),
      git_branch: meta.git?.branch,
      cwd: meta.cwd,
      tokens_total_input: 0,
      tokens_total_output: 0,
      tokens_total_cached: 0,
      cost_cents: 0,
      step_count: 0,
      tags: ["cost:approx"],
    };
    insertRun(store, run);
  }

  let stepsAdded = 0;
  for await (const step of buildSteps(all, runId, store, meta)) {
    insertStep(store, step);
    stepsAdded += 1;
  }

  const last = lastTimestamp(all);
  setRunStatus(store, runId, finalStatus(all), last);
  updateRunTotals(store, runId);

  setIngestOffset(store, SOURCE_RUNTIME, path, endOffset(tail, fullSize));

  return {
    run_id: runId,
    steps_added: stepsAdded,
    bytes_read: fullSize - offset,
    status: "ok",
  };
}

function inferMeta(records: ParsedCodexRecord[]): CodexSessionMetaPayload {
  for (const r of records) {
    if (r.record.type === "session_meta") return r.record.payload;
  }
  return { id: "", timestamp: new Date().toISOString() };
}

function inferTitle(records: ParsedCodexRecord[]): string | undefined {
  for (const r of records) {
    if (!isResponseItem(r.record)) continue;
    if (!isMessage(r.record.payload)) continue;
    if (r.record.payload.role !== "user") continue;
    const text = textOfMessage(r.record.payload);
    if (text.trim().length === 0) continue;
    return text.split("\n")[0]!.slice(0, 80);
  }
  return undefined;
}

function lastTimestamp(records: ParsedCodexRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const ts = records[i]!.record.timestamp;
    if (ts) return ts;
  }
  return undefined;
}

function finalStatus(records: ParsedCodexRecord[]): "ok" | "in_progress" {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!.record;
    if (r.type === "event_msg" && r.payload.type === "task_complete") {
      return "ok";
    }
  }
  return "in_progress";
}

async function* buildSteps(
  records: ParsedCodexRecord[],
  runId: string,
  store: Store,
  meta: CodexSessionMetaPayload,
): AsyncGenerator<Step> {
  // Pre-persist any system prompt embedded in session_meta.
  const systemPromptText = meta.base_instructions?.text;
  let systemPromptRef: string | undefined;
  if (systemPromptText) {
    systemPromptRef = await store.blobs.putString(systemPromptText);
  }

  // Walk response_items. Build a running history of user messages we've
  // seen so each assistant step's snapshot includes preceding turns.
  const history: ConversationMessage[] = [];
  let sequence = 0;
  let prevStepId: string | undefined;

  // Index function_call_output by call_id for quick outcome lookup.
  const outputByCallId = new Map<string, CodexResponseItemFunctionCallOutput>();
  for (const r of records) {
    if (!isResponseItem(r.record)) continue;
    if (isFunctionCallOutput(r.record.payload) && r.record.payload.call_id) {
      outputByCallId.set(r.record.payload.call_id, r.record.payload);
    }
  }

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (!isResponseItem(r.record)) continue;
    const payload = r.record.payload;

    if (isMessage(payload) && payload.role === "user") {
      const text = textOfMessage(payload);
      const ref = await store.blobs.putString(text);
      history.push({ role: "user", content_ref: ref });
      continue;
    }

    if (isMessage(payload) && payload.role === "assistant") {
      const text = textOfMessage(payload);
      const action: Action = parseActionFromAgentText(text);
      const decisionRef = await store.blobs.putJson(payload.content);

      const components = await snapshotComponents(
        store,
        systemPromptRef,
        history,
      );
      const snapshot: ContextSnapshot = {
        id: hashJson(components),
        components,
      };
      const snapshotBlobRef = await store.blobs.putJson(snapshot);
      recordContextSnapshot(
        store,
        snapshot.id,
        snapshotBlobRef,
        snapshot.components.length,
      );

      const stepId = `stp_${randomUUID()}`;
      const outcome: Outcome = { status: "ok" };
      const step: Step = {
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: r.record.timestamp ?? new Date().toISOString(),
        model: meta.model_provider ?? "codex-unknown",
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action,
        outcome,
        tokens: {
          input: 0,
          output: 0,
          cached_read: 0,
          cache_creation: 0,
        },
        latency_ms: 0,
        cost_cents: 0,
        tags: ["cost:approx", "codex"],
        status: "ok",
      };
      yield step;

      // Add this assistant turn to the running history.
      const historyRef = await store.blobs.putString(text);
      history.push({ role: "assistant", content_ref: historyRef });

      sequence += 1;
      prevStepId = stepId;
      continue;
    }

    if (isFunctionCall(payload)) {
      const action: Action = {
        kind: "tool_call",
        tool_name: payload.name ?? "function",
        tool_use_id: payload.call_id ?? payload.id,
        tool_input: safeParseJson(payload.arguments),
      };
      const decisionRef = await store.blobs.putJson(payload);

      const matchedOutput = payload.call_id
        ? outputByCallId.get(payload.call_id)
        : undefined;
      const outcome: Outcome = matchedOutput
        ? {
            status: "ok",
            tool_result_ref: await store.blobs.putString(
              matchedOutput.output ?? "",
            ),
            summary: matchedOutput.output?.split("\n")[0]?.slice(0, 200),
          }
        : { status: "pending" };

      const components = await snapshotComponents(
        store,
        systemPromptRef,
        history,
      );
      const snapshot: ContextSnapshot = {
        id: hashJson(components),
        components,
      };
      const snapshotBlobRef = await store.blobs.putJson(snapshot);
      recordContextSnapshot(
        store,
        snapshot.id,
        snapshotBlobRef,
        snapshot.components.length,
      );

      const stepId = `stp_${randomUUID()}`;
      yield {
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: r.record.timestamp ?? new Date().toISOString(),
        model: meta.model_provider ?? "codex-unknown",
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action,
        outcome,
        tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
        latency_ms: 0,
        cost_cents: 0,
        tags: ["cost:approx", "codex"],
        status: outcome.status === "pending" ? "in_progress" : "ok",
      };
      sequence += 1;
      prevStepId = stepId;
      continue;
    }
  }
}

async function snapshotComponents(
  store: Store,
  systemPromptRef: string | undefined,
  history: ConversationMessage[],
): Promise<ContextComponent[]> {
  const components: ContextComponent[] = [];
  if (systemPromptRef) {
    components.push({ type: "system_prompt", content_ref: systemPromptRef });
  }
  if (history.length > 0) {
    components.push({ type: "conversation_history", messages: [...history] });
  }
  return components;
}

const TOOL_CALL_RE = /\[external_agent_tool_call:\s*(\w+)\]/;

function parseActionFromAgentText(text: string): Action {
  const m = text.match(TOOL_CALL_RE);
  if (m) {
    return {
      kind: "tool_call",
      tool_name: m[1]!,
      text,
    };
  }
  return text.trim().length > 0
    ? { kind: "message", text }
    : { kind: "thinking_only" };
}

function safeParseJson(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
