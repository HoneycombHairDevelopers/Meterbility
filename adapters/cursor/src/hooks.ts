import type { FileChange, Run, Step } from "@meterbility/shared";
import { hashJson } from "@meterbility/shared";
import {
  getRunBySessionId,
  insertFileChange,
  insertRun,
  insertStep,
  recordContextSnapshot,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";

/**
 * Cursor Hooks capture (Cursor ≥1.7) — the durable file-attribution
 * plane for Cursor. Unlike the state.vscdb extraction (which races
 * Cursor's aggressive retention pruning), hook events arrive in real
 * time and carry `conversation_id` — the composerId — so everything
 * lands on the same Run the DB adapter builds.
 *
 * Events handled (payloads per Cursor's hooks documentation):
 * - afterFileEdit:       { file_path, edits: [{old_string, new_string}] }
 * - beforeShellExecution:{ command, cwd } — informational capture; the
 *                         CLI answers {"permission":"allow"} so capture
 *                         NEVER blocks the user's agent.
 * - stop:                { status: "completed"|"aborted"|"error" }
 *
 * All events carry: conversation_id, generation_id, hook_event_name,
 * workspace_roots.
 *
 * Hook-created steps use a high sequence base (100000+) so they never
 * collide with the DB adapter's bubble sequences (UNIQUE(run_id,
 * sequence)); both planes coexist on the run.
 */

export interface CursorHookPayload {
  conversation_id?: string;
  generation_id?: string;
  hook_event_name?: string;
  workspace_roots?: string[];
  // afterFileEdit
  file_path?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
  // beforeShellExecution
  command?: string;
  cwd?: string;
  // stop
  status?: string;
}

export interface CursorHookResult {
  handled: boolean;
  run_id?: string;
  step_id?: string;
  file_changes: number;
  /** JSON the hook process must print to stdout (before* events only). */
  response?: Record<string, unknown>;
}

/**
 * Hook-plane steps occupy [HOOK_SEQUENCE_BASE, SEQUENCE_REBUILD_OFFSET)
 * — far above any real bubble walk, far below the DB adapter's rebuild
 * offset — so DB-side reconciliation (bounded trims/offsets in
 * ingest.ts) never touches them.
 */
export const HOOK_SEQUENCE_BASE = 100_000;

export async function handleCursorHookEvent(
  store: Store,
  payload: CursorHookPayload,
): Promise<CursorHookResult> {
  const event = payload.hook_event_name;
  const conversationId = payload.conversation_id;
  if (!event || !conversationId) {
    return { handled: false, file_changes: 0 };
  }

  const cwd =
    payload.workspace_roots?.[0] ?? payload.cwd ?? "(cursor)";

  switch (event) {
    case "afterFileEdit":
      return handleAfterFileEdit(store, payload, conversationId, cwd);
    case "beforeShellExecution": {
      const res = await handleShell(store, payload, conversationId, cwd);
      // NEVER block the agent — capture is an observer.
      return { ...res, response: { continue: true, permission: "allow" } };
    }
    case "stop": {
      const run = getRunBySessionId(store, conversationId);
      if (run) {
        const status =
          payload.status === "error"
            ? "error"
            : payload.status === "aborted"
              ? "abandoned"
              : "ok";
        setRunStatus(store, run.run_id, status, new Date().toISOString());
      }
      return { handled: true, run_id: run?.run_id, file_changes: 0 };
    }
    default:
      return { handled: false, file_changes: 0 };
  }
}

/** Find-or-create the run for this conversation (composer). */
function ensureRun(
  store: Store,
  conversationId: string,
  cwd: string,
): Run {
  const existing = getRunBySessionId(store, conversationId);
  if (existing) return existing;
  const project = upsertProjectByCwd(store, cwd, "cursor");
  const agent = upsertAgent(store, project.project_id, "cursor");
  const run: Run = {
    run_id: `run_${hashJson(["cursor-hook", conversationId])}`,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_session_id: conversationId,
    source_runtime: "cursor",
    title: undefined,
    status: "in_progress",
    started_at: new Date().toISOString(),
    cwd,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: ["cursor", "cursor-hook"],
  };
  insertRun(store, run);
  return run;
}

function hookStepCount(store: Store, runId: string): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND sequence >= ?`,
    )
    .get(runId, HOOK_SEQUENCE_BASE) as { n: number };
  return row.n;
}

async function insertHookStep(
  store: Store,
  run: Run,
  args: {
    generationId: string | undefined;
    toolName: string;
    toolInput: unknown;
    anchor: string;
  },
): Promise<Step> {
  const stepId = `stp_${hashJson([run.run_id, "hook", args.anchor])}`;
  const existing = store.db
    .prepare(`SELECT sequence FROM steps WHERE step_id = ?`)
    .get(stepId) as { sequence: number } | undefined;
  const sequence = existing
    ? existing.sequence
    : HOOK_SEQUENCE_BASE + hookStepCount(store, run.run_id);

  const snapshotId = hashJson(["cursor-hook-snapshot", stepId]);
  const snapshotRef = await store.blobs.putJson({ id: snapshotId, components: [] });
  recordContextSnapshot(store, snapshotId, snapshotRef, 0);
  const decisionRef = await store.blobs.putJson(args.toolInput);

  const step: Step = {
    step_id: stepId,
    run_id: run.run_id,
    sequence,
    timestamp: new Date().toISOString(),
    model: "cursor",
    context_snapshot_id: snapshotId,
    decision_ref: decisionRef,
    action: {
      kind: "tool_call",
      tool_name: args.toolName,
      tool_use_id: args.generationId,
      tool_input: args.toolInput,
    },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: ["cursor", "cursor-hook"],
    status: "ok",
  };
  insertStep(store, step);
  updateRunTotals(store, run.run_id);
  return step;
}

async function handleAfterFileEdit(
  store: Store,
  payload: CursorHookPayload,
  conversationId: string,
  cwd: string,
): Promise<CursorHookResult> {
  const filePath = payload.file_path;
  if (!filePath) return { handled: false, file_changes: 0 };
  const edits = payload.edits ?? [];
  const run = ensureRun(store, conversationId, cwd);
  const relPath = toRepoRelative(filePath, cwd);
  const anchor = `${payload.generation_id ?? "nogen"}:${relPath}`;

  const step = await insertHookStep(store, run, {
    generationId: payload.generation_id,
    toolName: "afterFileEdit",
    toolInput: { file_path: relPath, edits: edits.length },
    anchor,
  });

  let inserted = 0;
  let seq = 0;
  for (const edit of edits) {
    const oldStr = edit.old_string ?? "";
    const newStr = edit.new_string ?? "";
    const fcId = `fc_${hashJson([run.run_id, anchor, seq])}`;
    const exists = store.db
      .prepare(`SELECT 1 FROM file_change WHERE file_change_id = ?`)
      .get(fcId);
    if (!exists) {
      const fc: Omit<FileChange, "created_at"> = {
        file_change_id: fcId,
        run_id: run.run_id,
        step_id: step.step_id,
        sequence: seq,
        tool_call_id: payload.generation_id,
        derived_from: "tool_call",
        path: relPath,
        op: "modify",
        partial_diff: true,
        gitignored: false,
        patch_text: editPatchText(oldStr, newStr),
        patch_format: "unified",
        lines_added: countLines(newStr),
        lines_removed: countLines(oldStr),
        source_tool_name: "afterFileEdit",
      };
      insertFileChange(store, fc);
      inserted += 1;
    }
    seq += 1;
  }

  return {
    handled: true,
    run_id: run.run_id,
    step_id: step.step_id,
    file_changes: inserted,
  };
}

async function handleShell(
  store: Store,
  payload: CursorHookPayload,
  conversationId: string,
  cwd: string,
): Promise<CursorHookResult> {
  const run = ensureRun(store, conversationId, cwd);
  const anchor = `${payload.generation_id ?? "nogen"}:shell:${hashJson([payload.command ?? ""])}`;
  const step = await insertHookStep(store, run, {
    generationId: payload.generation_id,
    toolName: "beforeShellExecution",
    toolInput: { command: payload.command, cwd: payload.cwd },
    anchor,
  });
  return {
    handled: true,
    run_id: run.run_id,
    step_id: step.step_id,
    file_changes: 0,
  };
}

function editPatchText(oldStr: string, newStr: string): string {
  const minus = oldStr.length
    ? oldStr
        .split("\n")
        .map((l) => `-${l}`)
        .join("\n")
    : "";
  const plus = newStr.length
    ? newStr
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")
    : "";
  return ["@@ afterFileEdit @@", minus, plus].filter((s) => s.length > 0).join("\n");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function toRepoRelative(absPath: string, cwd: string): string {
  const normCwd = cwd.replace(/\/+$/, "");
  if (normCwd.length > 0 && normCwd !== "(cursor)") {
    if (absPath === normCwd) return "";
    if (absPath.startsWith(normCwd + "/")) {
      return absPath.slice(normCwd.length + 1).split("\\").join("/");
    }
  }
  return absPath.split("\\").join("/");
}
