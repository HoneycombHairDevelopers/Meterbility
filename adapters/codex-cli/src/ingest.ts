import { readFile } from "node:fs/promises";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  FileChange,
  Outcome,
  Run,
  Step,
  TokenUsage,
} from "@meterbility/shared";
import { hashJson, redactString } from "@meterbility/shared";
import { costCents } from "@meterbility/spec";
import {
  getIngestOffset,
  getRunBySessionId,
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
import {
  endOffset,
  parseBuffer,
  type ParsedCodexRecord,
} from "./parser.ts";
import {
  isCustomToolCall,
  isCustomToolCallOutput,
  isFunctionCall,
  isFunctionCallOutput,
  isMessage,
  isResponseItem,
  isTurnContext,
  textOfMessage,
  type CodexPatchApplyEndPayload,
  type CodexResponseItemCustomToolCall,
  type CodexSessionMetaPayload,
  type CodexTokenCountInfo,
} from "./types.ts";

const SOURCE_RUNTIME = "codex-cli" as const;

export interface CodexIngestResult {
  run_id: string;
  steps_added: number;
  bytes_read: number;
  status: "ok" | "empty";
}

/**
 * Ingest a Codex Desktop / Codex CLI rollout file.
 *
 * Coverage (verified against real rollouts, 2026-08-04):
 * - Steps: assistant `response_item.message`, `function_call`, and
 *   `custom_tool_call` (freeform apply_patch). Outputs join on call_id.
 * - Tokens: `event_msg/token_count` — `last_token_usage` is the
 *   per-request delta {input, cached_input, output, reasoning_output}.
 *   `cached_input_tokens` is a SUBSET of `input_tokens`, so steps store
 *   input = input − cached (schema semantics: `tokens.input` is uncached,
 *   matching the Anthropic-normalized columns the cache lane reads).
 * - Model: `turn_context.payload.model` (real id, per-turn). session_meta
 *   only has the provider string — never a model id.
 * - Latency: `task_complete.duration_ms` for the turn's terminal step;
 *   `Wall time: N seconds` parsed from tool outputs for tool steps.
 * - File changes: `event_msg/patch_apply_end` — structured changes map
 *   (adds carry full content; updates carry a unified diff only, stored
 *   as partial_diff rows with patch_text).
 *
 * Steps use deterministic ids derived from (run_id, record offset) so
 * re-ingest is a no-op via insertStep's upsert; file_change rows use
 * deterministic ids plus an existence guard (plain INSERT would throw).
 */
export async function ingestCodexSession(
  store: Store,
  path: string,
): Promise<CodexIngestResult> {
  const offset = getIngestOffset(store, SOURCE_RUNTIME, path);
  // Parse-once: one read of the file feeds both the tail check and the
  // full rebuild — a live tick was previously re-reading the whole file
  // twice.
  const buf = await readFile(path);
  const tail = parseBuffer(buf, offset);
  if (tail.length === 0) {
    return { run_id: "", steps_added: 0, bytes_read: 0, status: "empty" };
  }
  const fullSize = buf.length;

  const all = offset === 0 ? tail : parseBuffer(buf, 0);
  const meta = inferMeta(all);
  const sessionId = meta.id;

  const existing = sessionId
    ? getRunBySessionId(store, sessionId)
    : undefined;

  // Idle-tail gate: a tail that carries no step material (no
  // response_item, no turn_context, no token_count / patch_apply_end /
  // task_complete event) can't change any step, cost, or file-change
  // row — advance the offset and skip the O(n) rebuild. Live ticks on
  // chatter-only appends (agent_message streams etc.) hit this path.
  if (offset > 0 && !tail.some(isMaterialRecord)) {
    setIngestOffset(store, SOURCE_RUNTIME, path, endOffset(tail, fullSize));
    return {
      run_id: existing?.run_id ?? "",
      steps_added: 0,
      bytes_read: fullSize - offset,
      status: "ok",
    };
  }

  const project = upsertProjectByCwd(store, meta.cwd ?? "(unknown)");
  const agent = upsertAgent(store, project.project_id, "codex-cli");

  const runId = existing
    ? existing.run_id
    : `run_${hashJson(["codex", sessionId || path])}`;

  const built = await buildSteps(all, runId, store, meta);

  const hasUsage = built.steps.some(
    (s) => s.tokens.input + s.tokens.output + s.tokens.cached_read > 0,
  );
  if (!existing) {
    const tags = ["codex"];
    if (!hasUsage) tags.push("cost:approx");
    if (meta.parent_thread_id) tags.push("codex:subagent");
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
      tags,
    };
    insertRun(store, run);
  } else if (hasUsage) {
    // A run first ingested before its token_count events landed was
    // tagged cost:approx at creation — drop the tag once real usage
    // shows up in the rebuild.
    const row = store.db
      .prepare(`SELECT tags FROM runs WHERE run_id = ?`)
      .get(runId) as { tags: string } | undefined;
    if (row) {
      try {
        const tags = JSON.parse(row.tags) as string[];
        if (tags.includes("cost:approx")) {
          store.db
            .prepare(`UPDATE runs SET tags = ? WHERE run_id = ?`)
            .run(
              JSON.stringify(tags.filter((t) => t !== "cost:approx")),
              runId,
            );
        }
      } catch {
        // Malformed tags — leave untouched.
      }
    }
  }

  for (const step of built.steps) {
    insertStep(store, step);
  }
  for (const fc of built.fileChanges) {
    const exists = store.db
      .prepare(`SELECT 1 FROM file_change WHERE file_change_id = ?`)
      .get(fc.file_change_id);
    if (!exists) insertFileChange(store, fc);
  }

  const last = lastTimestamp(all);
  setRunStatus(store, runId, finalStatus(all), last);
  updateRunTotals(store, runId);

  setIngestOffset(store, SOURCE_RUNTIME, path, endOffset(tail, fullSize));

  return {
    run_id: runId,
    steps_added: built.steps.length,
    bytes_read: fullSize - offset,
    status: "ok",
  };
}

/**
 * True when the record can affect steps, tokens, cost, latency, status,
 * or file changes — the idle-tail gate skips rebuilds whose appended
 * tail is all immaterial chatter.
 */
function isMaterialRecord(r: ParsedCodexRecord): boolean {
  if (isResponseItem(r.record) || isTurnContext(r.record)) return true;
  if (r.record.type !== "event_msg") return false;
  const t = r.record.payload.type;
  return t === "token_count" || t === "patch_apply_end" || t === "task_complete";
}

function inferMeta(records: ParsedCodexRecord[]): CodexSessionMetaPayload {
  for (const r of records) {
    if (r.record.type === "session_meta") return r.record.payload;
  }
  return { id: "", timestamp: new Date().toISOString() };
}

function inferTitle(records: ParsedCodexRecord[]): string | undefined {
  let fallback: string | undefined;
  for (const r of records) {
    if (!isResponseItem(r.record)) continue;
    if (!isMessage(r.record.payload)) continue;
    if (r.record.payload.role !== "user") continue;
    const text = textOfMessage(r.record.payload);
    if (text.trim().length === 0) continue;
    const firstLine = text.split("\n")[0]!.slice(0, 80);
    fallback ??= firstLine;
    // Codex injects AGENTS.md / environment context as synthetic user
    // messages ahead of the real prompt — skip them for the title.
    if (
      text.startsWith("# AGENTS.md") ||
      text.startsWith("<user_instructions>") ||
      text.startsWith("<environment_context>")
    ) {
      continue;
    }
    return firstLine;
  }
  return fallback;
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

interface UsageDelta {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

interface BuiltSteps {
  steps: Step[];
  fileChanges: Array<
    Omit<FileChange, "created_at"> & { file_change_id: string }
  >;
}

async function buildSteps(
  records: ParsedCodexRecord[],
  runId: string,
  store: Store,
  meta: CodexSessionMetaPayload,
): Promise<BuiltSteps> {
  const systemPromptText = meta.base_instructions?.text;
  let systemPromptRef: string | undefined;
  if (systemPromptText) {
    systemPromptRef = await store.blobs.putString(systemPromptText);
  }

  // ---- Pre-pass: index outputs, usage deltas, latency, and patches. ----

  // Outputs (function_call_output + custom_tool_call_output) by call_id.
  const outputByCallId = new Map<string, string>();
  for (const r of records) {
    if (!isResponseItem(r.record)) continue;
    const p = r.record.payload;
    if (
      (isFunctionCallOutput(p) || isCustomToolCallOutput(p)) &&
      p.call_id !== undefined
    ) {
      outputByCallId.set(p.call_id, p.output ?? "");
    }
  }

  // Step-producing record indices, in order (assistant messages + tool
  // calls). token_count / task_complete events anchor to the nearest
  // PRECEDING one.
  const isStepRecord = (r: ParsedCodexRecord): boolean => {
    if (!isResponseItem(r.record)) return false;
    const p = r.record.payload;
    return (
      (isMessage(p) && p.role === "assistant") ||
      isFunctionCall(p) ||
      isCustomToolCall(p)
    );
  };

  // usage deltas + turn latency keyed by record index of the anchor step.
  const usageByAnchor = new Map<number, UsageDelta>();
  const latencyByAnchor = new Map<number, number>();
  {
    let lastStepIdx = -1;
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      if (isStepRecord(r)) {
        lastStepIdx = i;
        continue;
      }
      if (r.record.type !== "event_msg") continue;
      const p = r.record.payload;
      if (p.type === "token_count" && lastStepIdx >= 0) {
        const info = p.info as CodexTokenCountInfo | null | undefined;
        const lastUsage = info?.last_token_usage;
        if (!lastUsage) continue; // rate-limit-only refresh
        const prev = usageByAnchor.get(lastStepIdx) ?? {
          input: 0,
          cached: 0,
          output: 0,
          reasoning: 0,
        };
        prev.input += lastUsage.input_tokens ?? 0;
        prev.cached += lastUsage.cached_input_tokens ?? 0;
        prev.output += lastUsage.output_tokens ?? 0;
        prev.reasoning += lastUsage.reasoning_output_tokens ?? 0;
        usageByAnchor.set(lastStepIdx, prev);
      } else if (p.type === "task_complete" && lastStepIdx >= 0) {
        const dur = typeof p.duration_ms === "number" ? p.duration_ms : undefined;
        if (dur !== undefined) latencyByAnchor.set(lastStepIdx, dur);
      }
    }
  }

  // ---- Main walk. ----
  const history: ConversationMessage[] = [];
  const steps: Step[] = [];
  const fileChanges: BuiltSteps["fileChanges"] = [];
  const stepIdByCallId = new Map<string, string>();
  const rawPatchInputByCallId = new Map<string, string>();
  const cwd = meta.cwd ?? "";
  // Per-step sequence counter spanning ALL patch events: two events
  // falling back onto the same step (e.g. both with unmatched call_ids)
  // must not both start at 0 — that collided on UNIQUE(step_id,
  // sequence) and crash-looped the ingest before setIngestOffset.
  const fcSeqByStep = new Map<string, number>();
  let sequence = 0;
  let prevStepId: string | undefined;
  // Real model id from turn_context; older CLIs never emit it. The
  // provider string in session_meta is NOT a model id — do not fall back
  // to it (it would silently price at the wrong row).
  let currentModel = "codex-unknown";

  const snapshotFor = async (): Promise<{ id: string }> => {
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
    return snapshot;
  };

  const tokensFor = (idx: number): { tokens: TokenUsage; hasUsage: boolean } => {
    const delta = usageByAnchor.get(idx);
    if (!delta) {
      return {
        tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
        hasUsage: false,
      };
    }
    return {
      tokens: {
        // Uncached input — cached_input_tokens is a subset of input_tokens.
        input: Math.max(0, delta.input - delta.cached),
        output: delta.output,
        cached_read: delta.cached,
        cache_creation: 0, // OpenAI bills no cache-write tier.
        reasoning: delta.reasoning > 0 ? delta.reasoning : undefined,
      },
      hasUsage: true,
    };
  };

  const priceStep = (
    tokens: TokenUsage,
    hasUsage: boolean,
  ): { cost: number; tags: string[] } => {
    if (!hasUsage) return { cost: 0, tags: ["cost:approx", "codex"] };
    const { cost_cents, approx } = costCents(currentModel, {
      input: tokens.input,
      output: tokens.output,
      cached_read: tokens.cached_read,
      cache_creation: 0,
    });
    return {
      cost: cost_cents,
      tags: approx ? ["cost:approx", "codex"] : ["codex"],
    };
  };

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;

    if (isTurnContext(r.record)) {
      if (typeof r.record.payload.model === "string") {
        currentModel = r.record.payload.model;
      }
      continue;
    }

    // ---- File changes from patch_apply_end (shape pinned 2026-08-04),
    // handled inline in the walk: stepIdByCallId already holds every
    // PRIOR call at this point, and prevStepId is the nearest prior
    // step — so an orphan event (unmatched call_id) attaches to the
    // step it followed, not the last step of the whole session.
    if (
      r.record.type === "event_msg" &&
      r.record.payload.type === "patch_apply_end"
    ) {
      const patch = r.record.payload as CodexPatchApplyEndPayload;
      const stepId = patch.call_id
        ? stepIdByCallId.get(patch.call_id)
        : undefined;
      // Without a joinable step there is nothing to attribute to; the
      // fallback step is the nearest prior one (patch events follow
      // their call).
      const targetStepId = stepId ?? prevStepId;
      if (!targetStepId || !patch.changes) continue;
      const rawInput = patch.call_id
        ? rawPatchInputByCallId.get(patch.call_id)
        : undefined;
      // Inline capture bypasses the blob pipeline's redaction — apply the
      // same pass to the raw V4A patch text and unified diffs.
      const inputRedaction =
        rawInput !== undefined ? redactString(rawInput) : undefined;
      const redactedInput = inputRedaction?.text;
      const inputWasRedacted = (inputRedaction?.redactions.length ?? 0) > 0;

      for (const [absPath, change] of Object.entries(patch.changes)) {
        const seq = fcSeqByStep.get(targetStepId) ?? 0;
        fcSeqByStep.set(targetStepId, seq + 1);
        const relPath = toRepoRelative(absPath, cwd);
        const isAdd = change.type === "add";
        const isDelete = change.type === "delete";
        const movePath = change.move_path ?? undefined;
        const op: FileChange["op"] = isAdd
          ? "create"
          : isDelete
            ? "delete"
            : movePath
              ? "rename"
              : "modify";
        const diffCounts = change.unified_diff
          ? countDiffLines(change.unified_diff)
          : undefined;

        const fcId = `fc_${hashJson([targetStepId, relPath, seq])}`;
        if (isAdd && typeof change.content === "string") {
          const afterRef = await store.blobs.putString(change.content);
          fileChanges.push({
            file_change_id: fcId,
            run_id: runId,
            step_id: targetStepId,
            sequence: seq,
            tool_call_id: patch.call_id,
            derived_from: "tool_call",
            path: relPath,
            op: "create",
            after_blob_ref: afterRef,
            partial_diff: false,
            gitignored: false,
            size_after: Buffer.byteLength(change.content, "utf-8"),
            line_count_after: countLines(change.content),
            lines_added: countLines(change.content),
            lines_removed: 0,
            bom: false,
            redacted: inputWasRedacted,
            source_tool_name: "apply_patch",
            source_tool_input: redactedInput,
          });
        } else {
          // Updates/deletes/renames carry no before-content in the rollout —
          // record the FACT of the change as a partial_diff row with the
          // unified diff cached as patch_text.
          const patchRedaction = change.unified_diff
            ? redactString(change.unified_diff)
            : undefined;
          fileChanges.push({
            file_change_id: fcId,
            run_id: runId,
            step_id: targetStepId,
            sequence: seq,
            tool_call_id: patch.call_id,
            derived_from: "tool_call",
            path: movePath ? toRepoRelative(movePath, cwd) : relPath,
            old_path: movePath ? relPath : undefined,
            op,
            partial_diff: true,
            gitignored: false,
            patch_text: patchRedaction?.text,
            patch_format: change.unified_diff ? "unified" : undefined,
            lines_added: diffCounts?.added ?? 0,
            lines_removed: diffCounts?.removed ?? 0,
            bom: false,
            redacted:
              inputWasRedacted ||
              (patchRedaction?.redactions.length ?? 0) > 0,
            source_tool_name: "apply_patch",
            source_tool_input: redactedInput,
          });
        }
      }
      continue;
    }

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
      const snapshot = await snapshotFor();
      const stepId = `stp_${hashJson([runId, r.offset])}`;
      const { tokens, hasUsage } = tokensFor(i);
      const { cost, tags } = priceStep(tokens, hasUsage);

      steps.push({
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: r.record.timestamp ?? new Date().toISOString(),
        model: currentModel,
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action,
        outcome: { status: "ok" },
        tokens,
        latency_ms: latencyByAnchor.get(i) ?? 0,
        cost_cents: cost,
        tags,
        status: "ok",
      });

      const historyRef = await store.blobs.putString(text);
      history.push({ role: "assistant", content_ref: historyRef });
      sequence += 1;
      prevStepId = steps[steps.length - 1]!.step_id;
      continue;
    }

    if (isFunctionCall(payload) || isCustomToolCall(payload)) {
      const custom = isCustomToolCall(payload);
      const toolName =
        payload.name ?? (custom ? "custom_tool" : "function");
      const toolInput = custom
        ? (payload as CodexResponseItemCustomToolCall).input
        : safeParseJson(
            (payload as { arguments?: string }).arguments,
          );
      const action: Action = {
        kind: "tool_call",
        tool_name: toolName,
        tool_use_id: payload.call_id ?? payload.id,
        tool_input: toolInput,
      };
      const decisionRef = await store.blobs.putJson(payload);

      const matchedOutput = payload.call_id
        ? outputByCallId.get(payload.call_id)
        : undefined;
      const exitCode = matchedOutput ? parseExitCode(matchedOutput) : undefined;
      const outcome: Outcome =
        matchedOutput !== undefined
          ? {
              status: exitCode !== undefined && exitCode !== 0 ? "error" : "ok",
              tool_result_ref: await store.blobs.putString(matchedOutput),
              summary: matchedOutput.split("\n")[0]?.slice(0, 200),
              is_error: exitCode !== undefined && exitCode !== 0,
            }
          : { status: "pending" };

      const snapshot = await snapshotFor();
      const stepId = `stp_${hashJson([runId, r.offset])}`;
      const { tokens, hasUsage } = tokensFor(i);
      const { cost, tags } = priceStep(tokens, hasUsage);
      const wallMs = matchedOutput ? parseWallTimeMs(matchedOutput) : undefined;

      steps.push({
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: r.record.timestamp ?? new Date().toISOString(),
        model: currentModel,
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action,
        outcome,
        tokens,
        latency_ms: wallMs ?? latencyByAnchor.get(i) ?? 0,
        cost_cents: cost,
        tags,
        status: outcome.status === "pending" ? "in_progress" : outcome.status,
      });

      if (payload.call_id) {
        stepIdByCallId.set(payload.call_id, stepId);
        if (custom && typeof (payload as CodexResponseItemCustomToolCall).input === "string") {
          rawPatchInputByCallId.set(
            payload.call_id,
            (payload as CodexResponseItemCustomToolCall).input!,
          );
        }
      }
      sequence += 1;
      prevStepId = stepId;
      continue;
    }
  }

  return { steps, fileChanges };
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

/** `Exit code: 0` (custom_tool_call_output) or `Process exited with code 0`. */
function parseExitCode(output: string): number | undefined {
  const m =
    output.match(/^Exit code:\s*(\d+)/m) ??
    output.match(/Process exited with code (\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** `Wall time: 0.2 seconds` → 200ms. */
function parseWallTimeMs(output: string): number | undefined {
  const m = output.match(/Wall time:\s*([\d.]+)\s*seconds/);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function countDiffLines(unifiedDiff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Absolute → repo-relative POSIX path. Falls back to the absolute path
 * when outside cwd (same semantics as the Claude Code adapter).
 */
function toRepoRelative(absPath: string, cwd: string): string {
  const normCwd = cwd.replace(/\/+$/, "");
  if (normCwd.length > 0) {
    if (absPath === normCwd) return "";
    if (absPath.startsWith(normCwd + "/")) {
      return absPath.slice(normCwd.length + 1).split("\\").join("/");
    }
  }
  return absPath.split("\\").join("/");
}
