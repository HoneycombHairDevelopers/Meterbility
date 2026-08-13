import type { FileChange, Run, Step } from "@meterbility/shared";
import { hashJson, redactString } from "@meterbility/shared";
import {
  getRunBySessionId,
  insertAnnotation,
  insertFileChange,
  insertStep,
  recordContextSnapshot,
  updateRunTotals,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import {
  CHECKPOINT_SEQUENCE_BASE,
  SEQUENCE_REBUILD_OFFSET,
  nextSequenceInBand,
} from "./bands.ts";
import type { CursorDb } from "./parser.ts";

/**
 * Cursor extras — supplementary audit evidence beyond the three main
 * channels (bubble walk, hooks, Admin API):
 *
 * 1. Checkpoint edit scripts (`checkpointId:<composerId>:<uuid>`):
 *    Cursor's restore snapshots — absolute file URIs plus line-range →
 *    replacement-lines edit scripts relative to the checkpoint baseline
 *    (V0), and an isNewlyCreated flag. Ingested as FALLBACK evidence
 *    only: paths already covered by tool-attributed file_change rows
 *    are skipped, so checkpoints add the files nothing else captured
 *    (e.g. toolFormerData pruned by retention) without double-counting.
 *
 * 2. aiCodeTrackingLines (ItemTable): Cursor's own per-line
 *    AI-authorship ledger. The composer-attributed subset is summarized
 *    into a run annotation — "N AI-authored lines across M files" with
 *    a per-file breakdown — the closest thing any vendor offers to a
 *    native provenance ledger. (The ledger is a global rolling window;
 *    counts are a floor, not a total.)
 *
 * Checkpoint steps live at CHECKPOINT_SEQUENCE_BASE inside the
 * reconciliation-protected band [100k, 1M) — same contract as the hook
 * (100k) and admin (200k) planes; see ingest.ts.
 */

// Re-exported for back-compat (tests import it from here); canonical
// definition lives in bands.ts.
export { CHECKPOINT_SEQUENCE_BASE } from "./bands.ts";
const TRACKING_AUTHOR = "meter/cursor-tracking";

interface CheckpointFileEntry {
  uri?: { path?: string; external?: string };
  isNewlyCreated?: boolean;
  originalModelDiffWrtV0?: Array<{
    original?: { startLineNumber?: number; endLineNumberExclusive?: number };
    modified?: string[];
  }>;
}

interface CheckpointPayload {
  files?: CheckpointFileEntry[];
}

export interface CursorExtrasResult {
  checkpoint_rows: number;
  ai_lines?: { lines: number; files: number };
}

export async function ingestCursorExtras(
  store: Store,
  cursor: CursorDb,
  composerId: string,
  aiSummary?: Map<string, Map<string, number>>,
): Promise<CursorExtrasResult> {
  const run = getRunBySessionId(store, composerId);
  if (!run) return { checkpoint_rows: 0 };

  const checkpointRows = await ingestCheckpoints(store, cursor, composerId, run);
  const ai = aiSummary?.get(composerId);
  if (ai && ai.size > 0) upsertTrackingAnnotation(store, run, ai);

  if (checkpointRows > 0) updateRunTotals(store, run.run_id);
  return {
    checkpoint_rows: checkpointRows,
    ai_lines: ai
      ? {
          lines: [...ai.values()].reduce((a, b) => a + b, 0),
          files: ai.size,
        }
      : undefined,
  };
}

/**
 * Parse the global aiCodeTrackingLines ledger ONCE per pull; returns
 * composerId → (fileName → line count) for composer-attributed entries.
 * Tab-completion entries carry no composerId and are ignored.
 */
export function readAiTrackingSummary(
  cursor: CursorDb,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const raw = cursor.getItemTable("aiCodeTrackingLines");
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed as Array<{
    metadata?: { composerId?: string; fileName?: string; source?: string };
  }>) {
    const meta = entry?.metadata;
    if (!meta || meta.source !== "composer") continue;
    const composerId = meta.composerId;
    if (!composerId) continue;
    const file = meta.fileName || "(unknown)";
    let files = out.get(composerId);
    if (!files) {
      files = new Map();
      out.set(composerId, files);
    }
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  return out;
}

async function ingestCheckpoints(
  store: Store,
  cursor: CursorDb,
  composerId: string,
  run: Run,
): Promise<number> {
  // Path canonicalization is impossible without a real workspace cwd —
  // checkpoint URIs are absolute, tool rows are repo-relative, so every
  // comparison would mismatch and double-count. Skip entirely.
  if (run.cwd === undefined || run.cwd === "(cursor)") return 0;

  const keys = cursor.listKeysByPrefix(`checkpointId:${composerId}:`);
  if (keys.length === 0) return 0;

  // Fallback semantics: only add paths no tool-attributed channel
  // captured. NULL-safe: hook/sentinel rows may carry no tool name.
  const coveredByTools = new Set(
    (
      store.db
        .prepare(
          `SELECT DISTINCT path FROM file_change
           WHERE run_id = ? AND COALESCE(source_tool_name, '') != 'cursor-checkpoint'`,
        )
        .all(run.run_id) as Array<{ path: string }>
    ).map((r) => r.path),
  );

  // Supersede: checkpoint rows are fallback evidence. When a later
  // ingest captures the same path through a real tool channel, the
  // checkpoint row is redundant double-counting — delete it.
  store.db
    .prepare(
      `DELETE FROM file_change
       WHERE run_id = ? AND source_tool_name = 'cursor-checkpoint'
         AND path IN (
           SELECT DISTINCT path FROM file_change
           WHERE run_id = ? AND COALESCE(source_tool_name, '') != 'cursor-checkpoint'
         )`,
    )
    .run(run.run_id, run.run_id);

  // Covered set = tool-attributed paths + surviving checkpoint paths.
  const covered = new Set(coveredByTools);
  for (const r of store.db
    .prepare(
      `SELECT DISTINCT path FROM file_change
       WHERE run_id = ? AND source_tool_name = 'cursor-checkpoint'`,
    )
    .all(run.run_id) as Array<{ path: string }>) {
    covered.add(r.path);
  }

  let inserted = 0;
  for (const key of keys) {
    const checkpointUuid = key.slice(key.lastIndexOf(":") + 1);
    const raw = cursor.getRawKV(key);
    if (!raw) continue;
    let payload: CheckpointPayload;
    try {
      payload = JSON.parse(raw) as CheckpointPayload;
    } catch {
      continue;
    }
    const files = payload.files ?? [];
    if (files.length === 0) continue;

    let stepId: string | undefined;
    let seq = 0;
    for (const f of files) {
      const absPath = f.uri?.path ?? f.uri?.external;
      if (!absPath) continue;
      const relPath = toRepoRelative(absPath, run.cwd ?? "");
      if (covered.has(relPath)) continue;

      const fcId = `fc_${hashJson([run.run_id, "ckpt", checkpointUuid, relPath])}`;
      const exists = store.db
        .prepare(`SELECT 1 FROM file_change WHERE file_change_id = ?`)
        .get(fcId);
      if (exists) continue;

      // One synthetic step per checkpoint, created lazily on the first
      // uncovered file.
      stepId ??= await ensureCheckpointStep(store, run, checkpointUuid);

      const script = f.originalModelDiffWrtV0 ?? [];
      // Inline patch text bypasses the blob pipeline's redaction —
      // apply the same pass as the other inline writers before it hits
      // SQLite.
      const patchRedaction = redactString(renderEditScript(script));
      const patchText = patchRedaction.text;
      const linesAdded = script.reduce(
        (n, s) => n + (s.modified?.length ?? 0),
        0,
      );
      const linesRemoved = script.reduce((n, s) => {
        const start = s.original?.startLineNumber ?? 0;
        const end = s.original?.endLineNumberExclusive ?? start;
        return n + Math.max(0, end - start);
      }, 0);

      const fc: Omit<FileChange, "created_at"> = {
        file_change_id: fcId,
        run_id: run.run_id,
        step_id: stepId,
        sequence: seq,
        derived_from: "tool_call",
        path: relPath,
        op: f.isNewlyCreated ? "create" : "modify",
        partial_diff: true,
        gitignored: false,
        patch_text: patchText.length > 0 ? patchText : undefined,
        patch_format: patchText.length > 0 ? "unified" : undefined,
        bom: false,
        redacted: patchRedaction.redactions.length > 0,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        source_tool_name: "cursor-checkpoint",
        normalizer_notes:
          "fallback evidence from Cursor checkpoint (edit script wrt checkpoint baseline V0)",
      };
      insertFileChange(store, fc);
      covered.add(relPath);
      inserted += 1;
      seq += 1;
    }
  }
  return inserted;
}

async function ensureCheckpointStep(
  store: Store,
  run: Run,
  checkpointUuid: string,
): Promise<string> {
  const stepId = `stp_${hashJson([run.run_id, "ckpt", checkpointUuid])}`;
  const exists = store.db
    .prepare(`SELECT 1 FROM steps WHERE step_id = ?`)
    .get(stepId);
  if (exists) return stepId;

  const sequence = nextSequenceInBand(
    store,
    run.run_id,
    CHECKPOINT_SEQUENCE_BASE,
    SEQUENCE_REBUILD_OFFSET,
  );

  const snapshotId = hashJson(["cursor-ckpt-snapshot", stepId]);
  const snapshotRef = await store.blobs.putJson({ id: snapshotId, components: [] });
  recordContextSnapshot(store, snapshotId, snapshotRef, 0);
  const decisionRef = await store.blobs.putJson({
    source: "cursor-checkpoint",
    checkpoint_uuid: checkpointUuid,
  });

  const step: Step = {
    step_id: stepId,
    run_id: run.run_id,
    sequence,
    timestamp: new Date().toISOString(),
    model: "cursor",
    context_snapshot_id: snapshotId,
    decision_ref: decisionRef,
    action: {
      kind: "none",
      text: `[cursor checkpoint ${checkpointUuid.slice(0, 8)}] fallback file evidence`,
    },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: ["cursor", "cursor-checkpoint"],
    status: "ok",
  };
  insertStep(store, step);
  return stepId;
}

/** Idempotent per run: one annotation row, note refreshed on change. */
function upsertTrackingAnnotation(
  store: Store,
  run: Run,
  files: Map<string, number>,
): void {
  const total = [...files.values()].reduce((a, b) => a + b, 0);
  const breakdown = [...files.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([f, n]) => `${f}:${n}`)
    .join(", ");
  const note =
    `AI-authored lines (Cursor tracking ledger): ${total} across ${files.size} file(s) — ${breakdown}` +
    (files.size > 10 ? ", …" : "");

  const existing = store.db
    .prepare(
      `SELECT annotation_id, note FROM annotations WHERE target_id = ? AND author = ? AND target_kind = 'run'`,
    )
    .get(run.run_id, TRACKING_AUTHOR) as
    | { annotation_id: string; note: string | null }
    | undefined;
  if (existing) {
    if (existing.note !== note) {
      store.db
        .prepare(`UPDATE annotations SET note = ? WHERE annotation_id = ?`)
        .run(note, existing.annotation_id);
    }
    return;
  }
  insertAnnotation(store, {
    targetKind: "run",
    targetId: run.run_id,
    author: TRACKING_AUTHOR,
    note,
  });
}

function renderEditScript(
  script: Array<{
    original?: { startLineNumber?: number; endLineNumberExclusive?: number };
    modified?: string[];
  }>,
): string {
  const hunks: string[] = [];
  for (const s of script) {
    const start = s.original?.startLineNumber ?? 0;
    const end = s.original?.endLineNumberExclusive ?? start;
    const removed = Math.max(0, end - start);
    const added = s.modified?.length ?? 0;
    hunks.push(`@@ -${start},${removed} +${start},${added} @@`);
    for (const line of s.modified ?? []) hunks.push(`+${line}`);
  }
  return hunks.join("\n");
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
