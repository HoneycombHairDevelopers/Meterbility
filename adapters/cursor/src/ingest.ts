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
import { costCents } from "@meterbility/spec";
import {
  DETERMINISTIC_STEP_ID_RE,
  deterministicStepId,
  hashJson,
} from "@meterbility/shared";
import {
  deleteStepsFromSequence,
  getRunBySessionId,
  insertRun,
  insertStep,
  listStepIdsBySequence,
  migrateStepId,
  offsetStepSequences,
  recordContextSnapshot,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import { HOOK_SEQUENCE_BASE, SEQUENCE_REBUILD_OFFSET } from "./bands.ts";
import { extractCursorFileChanges } from "./file_changes.ts";
import { ingestCursorExtras, readAiTrackingSummary } from "./extras.ts";
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
  /** Composers whose ingest threw and rolled back; retried next run. */
  composers_failed?: number;
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
  /**
   * Override per-composer workspace resolution; when unset, each
   * composer's cwd is resolved via composerHeaders/workspace.json,
   * falling back to "(cursor)" for ephemeral windows.
   */
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
 * server-side), and per-step token usage is sparse. Steps with local
 * token data are priced via costCents and tagged `cost:approx`; the
 * Admin API usage puller supersedes those estimates with `cost:actual`
 * (billed) or `cost:value` (subscription-included) when configured.
 *
 * Each composer's run attributes to its workspace: cwd resolves per
 * composer via composerHeaders → workspace.json (memoized per pull),
 * falling back to "(cursor)" only for ephemeral windows.
 *
 * This is one of three capture planes (bubble walk here, hooks, Admin
 * API) plus the extras pass (checkpoint fallback + AI-lines ledger).
 * Walk reconciliation (shift rebuilds, tail trims) is bounded below
 * RESERVED_SEQUENCE_BASE, so synthetic band steps always survive it.
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

    // Per-composer cwd: composerHeaders.workspaceId → workspace.json
    // folder. Falls back to the "(cursor)" placeholder only for
    // ephemeral windows with no workspace — this is what lets the file
    // sentinel and project grouping work for Cursor runs.
    const { workspaceCwdById } = await import("./discover.ts");
    // Memoized per pull: each workspace's cwd resolution hits disk
    // (workspace.json), and many composers share a workspace.
    const wsCwdCache = new Map<string, string | undefined>();
    const resolveWorkspaceCwd = async (
      wsId: string,
    ): Promise<string | undefined> => {
      if (wsCwdCache.has(wsId)) return wsCwdCache.get(wsId);
      const cwd = await workspaceCwdById(wsId);
      wsCwdCache.set(wsId, cwd);
      return cwd;
    };
    const projectCache = new Map<
      string,
      { projectId: string; agentId: string }
    >();
    const resolveProject = (cwd: string) => {
      let hit = projectCache.get(cwd);
      if (!hit) {
        const project = upsertProjectByCwd(store, cwd, "cursor");
        const agent = upsertAgent(store, project.project_id, "cursor");
        hit = { projectId: project.project_id, agentId: agent.agent_id };
        projectCache.set(cwd, hit);
      }
      return hit;
    };

    // Cursor's own per-line AI-authorship ledger — parsed once per pull
    // (it's one large ItemTable row), summarized per composer below.
    const aiSummary = readAiTrackingSummary(cursor);

    let composersIngested = 0;
    let composersFailed = 0;
    let stepsAdded = 0;
    for (const comp of composers) {
      try {
        let cwd = opts.cwd;
        if (!cwd) {
          const wsId = cursor.workspaceIdForComposer(comp.composerId);
          cwd = wsId ? await resolveWorkspaceCwd(wsId) : undefined;
        }
        cwd ??= "(cursor)";
        const { projectId, agentId } = resolveProject(cwd);
        const result = await ingestOneComposer(store, cursor, comp, {
          projectId,
          agentId,
          cwd,
        });
        composersIngested += 1;
        stepsAdded += result.steps_added;
        // Supplementary evidence (checkpoint fallback rows + AI-lines
        // annotation). Best-effort: extras must never fail an ingest.
        try {
          await ingestCursorExtras(store, cursor, comp.composerId, aiSummary);
        } catch {
          // ignore — extras are additive
        }
      } catch {
        // One poisoned composer (schema drift, torn concurrent write)
        // must not starve every other conversation on every tick — the
        // step-table transaction rolled back; the next ingest retries.
        composersFailed += 1;
      }
    }

    return {
      composers_seen: composers.length,
      composers_ingested: composersIngested,
      ...(composersFailed > 0 ? { composers_failed: composersFailed } : {}),
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
  // Re-read the envelope and materialize every bubble inside ONE read
  // transaction — Cursor commits between bare per-bubble SELECTs, so
  // without the snapshot the walk can observe a conversation state
  // that never existed (half old turn order, half new).
  const snapshot = cursor.readComposerSnapshot(comp);
  comp = snapshot.composer;
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

  // Cursor's db is trusted verbatim — dedupe headers so a repeated
  // bubbleId can never occupy two walk slots (which would corrupt the
  // sequence <-> id mapping and force perpetual rebuilds).
  const bubblesById = new Map<string, CursorBubble>();
  for (const b of snapshot.bubbles) {
    if (!bubblesById.has(b.bubbleId)) bubblesById.set(b.bubbleId, b);
  }

  // Only user/assistant bubbles become steps; drop the rest up front so
  // a bubble's index in this array equals its step sequence.
  const bubbles = [...bubblesById.values()].filter(
    (b) => isUserBubble(b) || isAssistantBubble(b),
  );

  // Torn-read guards: Cursor flushes composer headers before bubble
  // rows, and each bubble is a separate SELECT, so the walk can see
  // fewer bubbles than the headers claim — or none that classify as
  // user/assistant, if Cursor drifts the type encoding. Reconciling an
  // existing run against such a partial view would delete real steps
  // and cascade away file_change children that cannot be re-derived.
  // Skip; the next ingest sees the flushed rows. Trade-off: a composer
  // whose bubble rows Cursor permanently dropped stops updating —
  // stale, never destructive.
  const uniqueHeaderCount = new Set(
    (comp.fullConversationHeadersOnly ?? []).map((h) => h.bubbleId),
  ).size;
  if (
    existing &&
    uniqueHeaderCount > 0 &&
    (bubblesById.size < uniqueHeaderCount || bubbles.length === 0)
  ) {
    return { steps_added: 0 };
  }

  // Reconcile against rows from prior ingests. The walk always restarts
  // from bubble zero, so sequence does too — deterministic step ids make
  // insertStep's ON CONFLICT(step_id) upsert a no-op for unchanged
  // bubbles, and legacy rows (pre-deterministic random ids) get renamed
  // to their deterministic id first (see legacyMigrations below), after
  // which the same identity upsert covers them too. If the turn
  // order shifted (checkpoint restore, edited turn), relocating rows
  // would collide inside the upsert — detect that here and vacate the
  // sequence range in the commit phase below.
  // Reconciliation only concerns the bubble-walk range — hook-plane
  // steps (sequence >= HOOK_SEQUENCE_BASE, written by meter cursor-hook)
  // are a separate capture channel and must be invisible to shift
  // detection, migration, counting, and trims.
  const existingIdBySeq = new Map<number, string>();
  if (existing) {
    for (const [seq, id] of listStepIdsBySequence(store, runId)) {
      if (seq < HOOK_SEQUENCE_BASE) existingIdBySeq.set(seq, id);
    }
  }
  const preIds = new Set(existingIdBySeq.values());
  let shifted = false;
  if (existingIdBySeq.size > 0) {
    const seqById = new Map<string, number>();
    for (const [seq, id] of existingIdBySeq) seqById.set(id, seq);
    shifted = bubbles.some((b, i) => {
      const computed = deterministicStepId(runId, b.bubbleId);
      const at = seqById.get(computed);
      if (at !== undefined && at !== i) return true;
      // A deterministic-format id stored at this sequence that isn't
      // this bubble's id means the turn here was replaced (rewind plus
      // new message) — without a rebuild, the (run_id, sequence) clause
      // would graft the new turn onto the old turn's id. Legacy ids
      // (random UUIDs, hyphenated) never match the format and never
      // trigger a rebuild — the quiet path migrates them to
      // deterministic ids instead (legacyMigrations below).
      const stored = existingIdBySeq.get(i);
      return (
        stored !== undefined &&
        stored !== computed &&
        DETERMINISTIC_STEP_ID_RE.test(stored)
      );
    });
  }
  // Legacy-id migration: rows written by the pre-deterministic adapter
  // carry random ids, which shift detection can't recognize — a later
  // reorder would rewrite them positionally (children grafted onto the
  // wrong turn) or strand them in the offset range and trim them
  // (children cascade-deleted). On a quiet ingest the positional
  // invariant still holds — stored sequence i IS bubble i — so this is
  // the one moment the legacy row's true identity is known. Rewrite it
  // to the deterministic id (children and parent links follow inside
  // the commit transaction below); every subsequent ingest then matches
  // the row by identity, and shift detection covers it.
  const legacyMigrations: Array<{ oldId: string; newId: string }> = [];
  const migratedSeqs = new Set<number>();
  if (!shifted && existingIdBySeq.size > 0) {
    bubbles.forEach((b, i) => {
      const stored = existingIdBySeq.get(i);
      if (stored !== undefined && !DETERMINISTIC_STEP_ID_RE.test(stored)) {
        legacyMigrations.push({ oldId: stored, newId: deterministicStepId(runId, b.bubbleId) });
        migratedSeqs.add(i);
      }
    });
    // Migrated rows are renames of pre-existing steps, not new ones.
    for (const m of legacyMigrations) preIds.add(m.newId);
  }

  // When shifted, the commit phase vacates every stored sequence, so the
  // (run_id, sequence) clause never fires and the computed id survives.
  // A migrated sequence keeps the computed id too — by commit time the
  // stored row has been renamed to exactly that id.
  const survivingIdAt = (seq: number, computedId: string): string =>
    shifted || migratedSeqs.has(seq)
      ? computedId
      : existingIdBySeq.get(seq) ?? computedId;

  // Phase 1 — build every step. Blob and snapshot writes happen here
  // (content-addressed, harmless if a crash strands them); step-table
  // writes are deferred to the atomic commit phase below.
  //
  // History accumulates as we walk bubbles in order. Each assistant step
  // sees all prior user/assistant bubbles in its context snapshot.
  const history: ConversationMessage[] = [];
  const steps: Step[] = [];
  const pendingFileChanges: Array<{ bubble: CursorBubble; stepId: string }> =
    [];
  let sequence = 0;
  let prevStepId: string | undefined;
  let stepsAdded = 0;

  for (const bubble of bubbles) {
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
      const stepId = deterministicStepId(runId, bubble.bubbleId);
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
      steps.push(step);
      // Chain onto whichever id will actually survive the commit phase
      // (migrated rows take the computed id; anything else keeps its
      // stored id), and only count genuinely new rows.
      prevStepId = survivingIdAt(sequence, stepId);
      if (!preIds.has(prevStepId)) stepsAdded += 1;
      sequence += 1;
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
      const model = modelFromComposer(comp) ?? "cursor";
      // Price whatever local token data exists. The model is usually the
      // literal "default" (Cursor never persists the served model
      // locally), so this stays cost:approx — but a real dollar estimate
      // beats a hardcoded zero, and Admin API data supersedes it when
      // the usage puller is configured.
      const priced =
        tokens.input + tokens.output > 0
          ? costCents(model, {
              input: tokens.input,
              output: tokens.output,
              cached_read: 0,
              cache_creation: 0,
            })
          : undefined;

      const stepId = deterministicStepId(runId, bubble.bubbleId);
      const step: Step = {
        step_id: stepId,
        run_id: runId,
        parent_step_id: prevStepId,
        sequence,
        timestamp: bubble.createdAt ?? new Date().toISOString(),
        model,
        context_snapshot_id: snapshot.id,
        decision_ref: decisionRef,
        action,
        outcome,
        tokens,
        latency_ms: 0,
        cost_cents: priced?.cost_cents ?? 0,
        tags: ["cost:approx", "cursor"],
        status:
          outcome.status === "error"
            ? "error"
            : outcome.status === "pending"
              ? "in_progress"
              : "ok",
      };
      steps.push(step);
      prevStepId = survivingIdAt(sequence, stepId);
      if (!preIds.has(prevStepId)) stepsAdded += 1;
      // File-change extraction runs AFTER the commit phase (needs the
      // step rows to exist for the FK) against whichever id survives.
      if (bubble.toolFormerData) {
        pendingFileChanges.push({ bubble, stepId: prevStepId });
      }
      sequence += 1;

      // Append a synthetic assistant entry to history so subsequent
      // bubbles see the prior turn.
      const assistantText =
        text || (bubble.toolFormerData?.name ? `[${bubble.toolFormerData.name}]` : "");
      const aref = await store.blobs.putString(assistantText);
      history.push({ role: "assistant", content_ref: aref });
      continue;
    }
  }

  // Partial classification drift: some fetched bubbles no longer
  // classify as user/assistant (per-row schema drift or a torn row).
  // If reconciliation would be destructive — a shift rebuild or a tail
  // trim — don't trust the reduced view; skip and let a later ingest
  // (or an adapter fix) see the full conversation. Composers with a
  // legitimately unclassifiable bubble type still ingest normally as
  // long as no destructive action is pending.
  if (
    existing &&
    bubbles.length < bubblesById.size &&
    (shifted || sequence < existingIdBySeq.size)
  ) {
    return { steps_added: 0 };
  }

  // Phase 2 — commit every step-table write atomically. A crash must
  // never leave the run half-rebuilt, and concurrent readers (the live
  // server shares this SQLite file) see the old state or the new state,
  // never a partial one.
  const commit = store.db.transaction(() => {
    if (legacyMigrations.length > 0) {
      // steps.step_id is a parent key (file_change.step_id references
      // it; foreign_keys is ON with immediate enforcement). Renaming
      // the parent while children point at the old id — or repointing
      // children first, at a not-yet-existing id — would each fail
      // mid-flight; defer enforcement to COMMIT so the rename and the
      // child repoint land together. The pragma is transaction-scoped
      // and resets itself when this transaction ends.
      store.db.pragma("defer_foreign_keys = ON");
      for (const m of legacyMigrations) {
        migrateStepId(store, runId, m.oldId, m.newId);
      }
    }
    if (shifted) {
      // Vacate every stored sequence instead of deleting: the upsert
      // below relocates surviving bubbles (same deterministic id) back
      // into place, so file_change children stay attached. Offset rows
      // left unmatched are bubbles that vanished from the source; the
      // trim below removes them.
      offsetStepSequences(store, runId, SEQUENCE_REBUILD_OFFSET, HOOK_SEQUENCE_BASE);
    }
    for (const step of steps) insertStep(store, step);
    // A rewound composer (checkpoint restore) has fewer bubbles than the
    // run has steps — trim the stale tail (and any unmatched offset
    // rows) so totals mirror the source. Bounded below HOOK_SEQUENCE_BASE
    // so hook-captured steps (the real-time plane, sequence 100000+)
    // survive DB-side reconciliation; offset strays are trimmed by the
    // second, unbounded-from-the-rebuild-offset call.
    deleteStepsFromSequence(store, runId, sequence, HOOK_SEQUENCE_BASE);
    deleteStepsFromSequence(store, runId, SEQUENCE_REBUILD_OFFSET);
    // Status ping-pong guard: the hook plane seals runs in real time
    // (stop → ok/error/abandoned) while the composer row often still
    // looks in_progress. Never let a DB re-ingest reopen a sealed run —
    // only apply "in_progress" when the run is new or already open —
    // and never null-out an ended_at that a prior pass set.
    const newStatus = composerStatus(comp);
    if (
      newStatus !== "in_progress" ||
      !existing ||
      existing.status === "in_progress"
    ) {
      setRunStatus(
        store,
        runId,
        newStatus,
        epochMsToIso(comp.lastUpdatedAt) ?? existing?.ended_at,
      );
    }
    updateRunTotals(store, runId);
  });
  commit();

  // File-change extraction (blob writes are async, and the rows FK onto
  // the just-committed steps). Idempotent per (run, bubble, path).
  for (const p of pendingFileChanges) {
    await extractCursorFileChanges(
      store,
      cursor,
      comp.composerId,
      p.bubble,
      runId,
      p.stepId,
    );
  }
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
