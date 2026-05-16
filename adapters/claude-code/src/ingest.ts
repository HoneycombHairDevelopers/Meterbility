import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  Action,
  ContextComponent,
  ContextSnapshot,
  ConversationMessage,
  Outcome,
  Run,
  Step,
  TokenUsage,
} from "@spool/shared";
import { hashJson } from "@spool/shared";
import { costCents } from "@spool/spec";
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
} from "@spool/collector";
import type { Store } from "@spool/collector";
import { readSessionFromOffset, endOffset, type ParsedRecord } from "./parser.ts";
import {
  isAssistant,
  isUser,
  type ClaudeAssistantRecord,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeRecord,
  type ClaudeUserRecord,
} from "./types.ts";
import { extractFileChanges, type BackupReader } from "./file_changes.ts";

const SOURCE_RUNTIME = "claude-code" as const;

export interface IngestResult {
  run_id: string;
  steps_added: number;
  /** v0.3 — count of FileChange rows captured this ingest. */
  file_changes_added: number;
  bytes_read: number;
  status: "ok" | "empty";
}

export interface IngestOptions {
  /**
   * v0.3 — override the file-history backup reader. Production code
   * uses the default (`fsBackupReader`); tests inject an in-memory
   * map so they don't need to touch ~/.claude.
   */
  readBackup?: BackupReader;
}

/**
 * Ingest one Claude Code session JSONL file. Idempotent: on repeated
 * calls only records past the last byte offset are processed, and step
 * inserts use INSERT OR REPLACE keyed on (run_id, sequence) to absorb any
 * mid-line append that grew between reads.
 *
 * The mapping is straightforward — each assistant record becomes one
 * Step; the next user record (if it carries a tool_result) becomes that
 * Step's Outcome. Conversation history references resolve via parentUuid
 * chains, replayed in canonical order.
 */
export async function ingestSession(
  store: Store,
  path: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const offset = getIngestOffset(store, SOURCE_RUNTIME, path);
  const records = await readSessionFromOffset(path, offset);
  if (records.length === 0) {
    return {
      run_id: "",
      steps_added: 0,
      file_changes_added: 0,
      bytes_read: 0,
      status: "empty",
    };
  }
  const fileStat = await stat(path);
  const fullSize = fileStat.size;

  const sessionId = inferSessionId(records, path);

  // We always re-read the whole file to rebuild context snapshots — context
  // depends on history before `offset`. If we already have a run for this
  // session, we keep its id; otherwise we create one.
  const allRecords = offset === 0 ? records : await readEntireFile(path);
  const existing = sessionId
    ? getRunBySessionId(store, sessionId)
    : undefined;

  const meta = inferRunMeta(allRecords);
  const project = upsertProjectByCwd(store, meta.cwd ?? "(unknown)");
  const agent = upsertAgent(store, project.project_id, "claude-code");

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
      title: meta.title,
      status: "in_progress",
      started_at: meta.started_at,
      git_branch: meta.git_branch,
      cwd: meta.cwd,
      tokens_total_input: 0,
      tokens_total_output: 0,
      tokens_total_cached: 0,
      cost_cents: 0,
      step_count: 0,
      tags: [],
    };
    insertRun(store, run);
  }

  // Populated as steps yield: maps every assistant-record uuid in a
  // grouped Step to that step's id + sequence. The file-change
  // extractor needs this to attribute FileChanges to the right Step
  // via the file-history-snapshot.messageId linkage (SPEC §3.4).
  const stepByAssistantUuid = new Map<
    string,
    { step_id: string; sequence: number }
  >();

  let stepsAdded = 0;
  const result = buildSteps({
    records: allRecords,
    runId,
    onSnapshot: async (snap) => {
      const ref = await store.blobs.putJson(snap);
      recordContextSnapshot(store, snap.id, ref, snap.components.length);
    },
    onDecisionContent: async (content) => store.blobs.putJson(content),
    onToolResult: async (content) => store.blobs.putJson(content),
    onStepBuilt: (step, assistantUuids) => {
      for (const uuid of assistantUuids) {
        stepByAssistantUuid.set(uuid, {
          step_id: step.step_id,
          sequence: step.sequence,
        });
      }
    },
  });

  for await (const step of result) {
    insertStep(store, step);
    stepsAdded += 1;
  }

  // v0.3 — extract FileChanges per modifying step. Idempotent: the
  // schema's UNIQUE(step_id, sequence) prevents double-insertion if the
  // session gets re-ingested. We catch & log per-row errors so one
  // malformed tool_input can't sink the whole ingest.
  let fileChangesAdded = 0;
  if (stepByAssistantUuid.size > 0) {
    const fileChanges = await extractFileChanges({
      records: allRecords,
      stepByAssistantUuid,
      runId,
      cwd: meta.cwd ?? "",
      sessionId: sessionId ?? "",
      blobs: store.blobs,
      readBackup: opts.readBackup,
    });
    for (const fc of fileChanges) {
      try {
        insertFileChange(store, fc);
        fileChangesAdded += 1;
      } catch (err) {
        // UNIQUE constraint failures on idempotent re-ingest are
        // expected and silent; anything else gets logged but does not
        // abort the run.
        const msg = (err as Error).message ?? "";
        if (!msg.includes("UNIQUE constraint failed")) {
          // eslint-disable-next-line no-console
          console.warn(
            `[spool] file_change insert failed for step ${fc.step_id}: ${msg}`,
          );
        }
      }
    }
  }

  // Detect terminal status. If the final record is an assistant message
  // with no tool_use blocks and no further user message, the run is
  // effectively complete.
  const lastTimestamp = lastTimestampOf(allRecords);
  const finalStatus = inferRunStatus(allRecords);
  setRunStatus(store, runId, finalStatus, lastTimestamp);
  updateRunTotals(store, runId);

  setIngestOffset(store, SOURCE_RUNTIME, path, endOffset(records, fullSize));

  return {
    run_id: runId,
    steps_added: stepsAdded,
    file_changes_added: fileChangesAdded,
    bytes_read: fullSize - offset,
    status: "ok",
  };
}

async function readEntireFile(path: string): Promise<ParsedRecord[]> {
  return readSessionFromOffset(path, 0);
}

function inferSessionId(records: ParsedRecord[], path: string): string {
  for (const r of records) {
    const sid = (r.record as ClaudeRecord).sessionId;
    if (sid) return sid;
  }
  return basename(path, ".jsonl");
}

interface RunMeta {
  started_at: string;
  title?: string;
  cwd?: string;
  git_branch?: string;
}

function inferRunMeta(records: ParsedRecord[]): RunMeta {
  let started_at = new Date().toISOString();
  let title: string | undefined;
  let cwd: string | undefined;
  let git_branch: string | undefined;
  for (const { record } of records) {
    const ts = record.timestamp;
    if (ts && (!records.length || started_at > ts)) started_at = ts;
    if (record.cwd && !cwd) cwd = record.cwd;
    if (record.gitBranch && !git_branch) git_branch = record.gitBranch;
    if (record.type === "ai-title") {
      const t = (record as unknown as { aiTitle?: string }).aiTitle;
      if (t) title = t;
    }
    if (!title && isUser(record)) {
      const msg = record.message;
      const firstText = textOfMessage(msg);
      if (firstText && firstText.trim().length > 0) {
        title = firstText.split("\n")[0]!.slice(0, 80);
      }
    }
  }
  return { started_at, title, cwd, git_branch };
}

function textOfMessage(msg: ClaudeMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function lastTimestampOf(records: ParsedRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const ts = records[i]!.record.timestamp;
    if (ts) return ts;
  }
  return undefined;
}

function inferRunStatus(
  records: ParsedRecord[],
): "ok" | "error" | "in_progress" {
  // Walk records to find the last user/assistant of interest.
  let lastRelevantIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const t = records[i]!.record.type;
    if (t === "assistant" || t === "user") {
      lastRelevantIdx = i;
      break;
    }
  }
  if (lastRelevantIdx < 0) return "in_progress";
  const last = records[lastRelevantIdx]!.record;

  // Case A: run ends on a user tool_result. If is_error, terminal error;
  // otherwise we don't yet have the assistant's follow-up reply, so it's
  // still mid-stream.
  if (isUser(last)) {
    const blocks = arrayContent(last.message);
    const toolResult = blocks.find((b) => b.type === "tool_result") as
      | Extract<ClaudeContentBlock, { type: "tool_result" }>
      | undefined;
    if (toolResult) {
      return toolResult.is_error ? "error" : "in_progress";
    }
    // Bare user message — operator typed something and there's no reply yet.
    return "in_progress";
  }

  // Case B: run ends on an assistant message.
  if (isAssistant(last)) {
    const blocks = arrayContent(last.message);
    const hasUnresolvedToolCall = blocks.some((b) => {
      if (b.type !== "tool_use") return false;
      // Did any subsequent user record carry the matching tool_result?
      for (let j = lastRelevantIdx + 1; j < records.length; j++) {
        const r = records[j]!.record;
        if (!isUser(r)) continue;
        const ubs = arrayContent(r.message);
        if (
          ubs.some(
            (ub) => ub.type === "tool_result" && ub.tool_use_id === b.id,
          )
        ) {
          return false;
        }
      }
      return true;
    });
    if (hasUnresolvedToolCall) return "in_progress";
    return "ok";
  }
  return "in_progress";
}

function arrayContent(msg: ClaudeMessage): ClaudeContentBlock[] {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  return msg.content;
}

interface BuildArgs {
  records: ParsedRecord[];
  runId: string;
  onSnapshot: (snap: ContextSnapshot) => Promise<void>;
  onDecisionContent: (content: ClaudeContentBlock[]) => Promise<string>;
  onToolResult: (
    content: string | ClaudeContentBlock[],
  ) => Promise<string>;
  /**
   * v0.3 — fires for each yielded Step with the list of assistant-record
   * uuids that contributed to it. The grouping logic collapses multiple
   * assistant records (per-content-block emissions sharing a requestId)
   * into one Step, so this is a 1-to-N relationship.
   */
  onStepBuilt?: (step: Step, assistantUuids: string[]) => void;
}

/**
 * Walk the records and yield one Spool Step per assistant message.
 *
 * The conversation history component of each Step's ContextSnapshot is
 * the list of prior user/assistant messages threaded by parentUuid, in
 * order. We do not attempt to reconstruct the system prompt verbatim
 * (Claude Code injects it server-side) — we capture the user/tool stream
 * which is what's most actionable to a debugging operator.
 */
async function* buildSteps(args: BuildArgs): AsyncGenerator<Step> {
  const {
    records,
    runId,
    onSnapshot,
    onDecisionContent,
    onToolResult,
    onStepBuilt,
  } = args;

  // Index records by uuid so parentUuid lookups are O(1).
  const byUuid = new Map<string, ParsedRecord>();
  for (const r of records) {
    const uuid = r.record.uuid;
    if (uuid) byUuid.set(uuid, r);
  }

  // Pre-store every user message body once so we can reference it cheaply.
  const userMessageRefs = new Map<string, ConversationMessage>();
  for (const r of records) {
    if (!isUser(r.record)) continue;
    const blocks = arrayContent(r.record.message);
    const ref = await onDecisionContent(blocks);
    userMessageRefs.set(r.record.uuid ?? `anon_${r.offset}`, {
      role: "user",
      content_ref: ref,
    });
  }

  // Claude Code emits one JSONL record per content block (thinking,
  // tool_use, text) but every record from the same API call shares a
  // `requestId` and carries identical usage. We collapse those into one
  // logical Step so token totals match the Anthropic invoice.
  const groups: { recs: ClaudeAssistantRecord[]; firstIdx: number }[] = [];
  const groupIdxByKey = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (!isAssistant(r.record)) continue;
    const key = r.record.requestId ?? r.record.uuid ?? `anon_${i}`;
    const idx = groupIdxByKey.get(key);
    if (idx === undefined) {
      groupIdxByKey.set(key, groups.length);
      groups.push({ recs: [r.record], firstIdx: i });
    } else {
      groups[idx]!.recs.push(r.record);
    }
  }

  let sequence = 0;
  let prevStepId: string | undefined;

  for (const group of groups) {
    const lastRecord = group.recs[group.recs.length - 1]!;
    const firstRecord = group.recs[0]!;
    // Use the first record's parent for history threading — the chain
    // sits one step earlier than the assistant's first block.
    const history = buildHistoryChain(firstRecord, byUuid, userMessageRefs);

    const components: ContextComponent[] = [
      { type: "conversation_history", messages: history },
    ];
    const snapshot: ContextSnapshot = {
      id: hashJson(components),
      components,
    };
    await onSnapshot(snapshot);

    // Combined content blocks for this logical step.
    const allBlocks: ClaudeContentBlock[] = [];
    for (const rec of group.recs) {
      for (const b of arrayContent(rec.message)) allBlocks.push(b);
    }
    const decisionRef = await onDecisionContent(allBlocks);
    const { action, thinking_only } = blocksToAction(allBlocks);

    const outcome: Outcome = { status: "pending" };
    if (action.kind === "tool_call" && action.tool_use_id) {
      const match = findToolResult(
        records,
        group.firstIdx + group.recs.length,
        action.tool_use_id,
        byUuid,
      );
      if (match) {
        const ref = await onToolResult(match.content);
        outcome.status = match.is_error ? "error" : "ok";
        outcome.tool_result_ref = ref;
        outcome.is_error = match.is_error ?? false;
        outcome.summary = match.summary;
      }
    } else if (action.kind === "message" || thinking_only) {
      outcome.status = "ok";
    }

    // Usage lives identically on every record from the same call, but
    // be defensive: take the maximum across the group so a missing field
    // on one record doesn't zero out tokens.
    const tokens = mergeTokens(group.recs.map((r) => r.message));
    const model = group.recs.find((r) => r.message.model)?.message.model ?? "unknown";
    const { cost_cents, approx } = costCents(model, {
      input: tokens.input,
      output: tokens.output,
      cached_read: tokens.cached_read,
      cache_creation: tokens.cache_creation,
      cache_creation_1h: tokens.cache_creation_1h,
    });

    const tags: string[] = [];
    if (approx) tags.push("cost:approx");
    if (thinking_only) tags.push("thinking_only");

    const stepId = `stp_${randomUUID()}`;
    const step: Step = {
      step_id: stepId,
      run_id: runId,
      parent_step_id: prevStepId,
      sequence,
      timestamp: lastRecord.timestamp ?? new Date().toISOString(),
      model,
      context_snapshot_id: snapshot.id,
      decision_ref: decisionRef,
      action,
      outcome,
      tokens,
      latency_ms: 0,
      cost_cents,
      tags,
      status:
        outcome.status === "error"
          ? "error"
          : outcome.status === "pending"
            ? "in_progress"
            : "ok",
    };
    prevStepId = stepId;
    sequence += 1;
    if (onStepBuilt) {
      const uuids = group.recs
        .map((r) => r.uuid)
        .filter((u): u is string => typeof u === "string");
      onStepBuilt(step, uuids);
    }
    yield step;
  }
}

function mergeTokens(messages: ClaudeMessage[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cached_read = 0;
  // Track 5m and 1h cache writes separately so cost can apply the right
  // rate (1.25× input vs 2× input). Anthropic exposes the breakdown
  // under `usage.cache_creation`. If only the legacy total is present
  // we conservatively bucket it as 5m to preserve back-compat with the
  // old single-rate behavior.
  let cache_creation_5m = 0;
  let cache_creation_1h = 0;
  for (const m of messages) {
    const u = m.usage;
    if (!u) continue;
    input = Math.max(input, u.input_tokens ?? 0);
    output = Math.max(output, u.output_tokens ?? 0);
    cached_read = Math.max(cached_read, u.cache_read_input_tokens ?? 0);
    const cc = u.cache_creation;
    if (cc) {
      cache_creation_5m = Math.max(
        cache_creation_5m,
        cc.ephemeral_5m_input_tokens ?? 0,
      );
      cache_creation_1h = Math.max(
        cache_creation_1h,
        cc.ephemeral_1h_input_tokens ?? 0,
      );
    } else if (u.cache_creation_input_tokens !== undefined) {
      // Legacy field — bucket as 5m (the cheaper assumption).
      cache_creation_5m = Math.max(
        cache_creation_5m,
        u.cache_creation_input_tokens,
      );
    }
  }
  return {
    input,
    output,
    cached_read,
    cache_creation: cache_creation_5m,
    cache_creation_1h,
  };
}

function buildHistoryChain(
  start: ClaudeAssistantRecord,
  byUuid: Map<string, ParsedRecord>,
  userMessageRefs: Map<string, ConversationMessage>,
): ConversationMessage[] {
  const chain: ConversationMessage[] = [];
  let cursor: string | undefined = start.parentUuid ?? undefined;
  while (cursor) {
    const rec = byUuid.get(cursor);
    if (!rec) break;
    if (isUser(rec.record)) {
      const ref = userMessageRefs.get(rec.record.uuid ?? "");
      if (ref) chain.push(ref);
    }
    cursor = rec.record.parentUuid ?? undefined;
  }
  chain.reverse();
  return chain;
}

interface MatchedToolResult {
  content: string | ClaudeContentBlock[];
  is_error?: boolean;
  summary?: string;
}

function findToolResult(
  records: ParsedRecord[],
  fromIndex: number,
  toolUseId: string,
  _byUuid: Map<string, ParsedRecord>,
): MatchedToolResult | undefined {
  for (let i = fromIndex; i < records.length; i++) {
    const r = records[i]!;
    if (!isUser(r.record)) continue;
    const blocks = arrayContent(r.record.message);
    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
        return {
          content: b.content,
          is_error: b.is_error,
          summary: summarizeToolResult(b.content),
        };
      }
    }
  }
  return undefined;
}

function summarizeToolResult(
  content: string | ClaudeContentBlock[],
): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
  if (!text) return undefined;
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function blocksToAction(blocks: ClaudeContentBlock[]): {
  action: Action;
  thinking_only: boolean;
} {
  const toolUse = blocks.find((b) => b.type === "tool_use") as
    | Extract<ClaudeContentBlock, { type: "tool_use" }>
    | undefined;
  if (toolUse) {
    return {
      action: {
        kind: "tool_call",
        tool_name: toolUse.name,
        tool_use_id: toolUse.id,
        tool_input: toolUse.input,
      },
      thinking_only: false,
    };
  }
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const onlyThinking =
    blocks.length > 0 && blocks.every((b) => b.type === "thinking");
  if (text.trim().length > 0) {
    return { action: { kind: "message", text }, thinking_only: false };
  }
  if (onlyThinking) {
    return { action: { kind: "thinking_only" }, thinking_only: true };
  }
  return { action: { kind: "none" }, thinking_only: false };
}

function mapTokens(msg: ClaudeMessage): TokenUsage {
  const u = msg.usage ?? { input_tokens: 0, output_tokens: 0 };
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cached_read: u.cache_read_input_tokens ?? 0,
    cache_creation: u.cache_creation_input_tokens ?? 0,
  };
}
