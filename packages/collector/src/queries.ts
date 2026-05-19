import { randomUUID } from "node:crypto";
import type {
  Action,
  Annotation,
  AnnotationVerdict,
  BaselineTree,
  FileChange,
  FileChangeSource,
  FileEncoding,
  FileOp,
  ForkEdit,
  LineEndings,
  Outcome,
  PatchFormat,
  ProbeState,
  Project,
  Run,
  Step,
  StepStatus,
  TokenUsage,
} from "@spool/shared";
import type { Store } from "./store.ts";

interface RunRow {
  run_id: string;
  agent_id: string;
  project_id: string;
  source_session_id: string | null;
  source_runtime: string;
  title: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  git_branch: string | null;
  cwd: string | null;
  fork_origin_run_id: string | null;
  fork_origin_step_id: string | null;
  tokens_total_input: number;
  tokens_total_output: number;
  tokens_total_cached: number;
  cost_cents: number;
  step_count: number;
  tags: string;
  // v0.3 — Track A + Track B. Both nullable: most runs have neither.
  baseline_tree_id: string | null;
  probe_state: string | null;
}

interface StepRow {
  step_id: string;
  run_id: string;
  parent_step_id: string | null;
  fork_origin_id: string | null;
  sequence: number;
  timestamp: string;
  model: string;
  context_snapshot_id: string;
  decision_ref: string;
  action_json: string;
  outcome_json: string;
  tokens_input: number;
  tokens_output: number;
  tokens_cached_read: number;
  tokens_cache_creation: number;
  tokens_cache_creation_1h: number;
  tokens_reasoning: number | null;
  latency_ms: number;
  cost_cents: number;
  status: string;
  tags: string;
}

function rowToRun(row: RunRow): Run {
  return {
    run_id: row.run_id,
    agent_id: row.agent_id,
    project_id: row.project_id,
    source_session_id: row.source_session_id ?? undefined,
    source_runtime: row.source_runtime as Run["source_runtime"],
    title: row.title ?? undefined,
    status: row.status as StepStatus,
    started_at: row.started_at,
    ended_at: row.ended_at ?? undefined,
    git_branch: row.git_branch ?? undefined,
    cwd: row.cwd ?? undefined,
    fork_origin_run_id: row.fork_origin_run_id ?? undefined,
    fork_origin_step_id: row.fork_origin_step_id ?? undefined,
    tokens_total_input: row.tokens_total_input,
    tokens_total_output: row.tokens_total_output,
    tokens_total_cached: row.tokens_total_cached,
    cost_cents: row.cost_cents,
    step_count: row.step_count,
    tags: JSON.parse(row.tags) as string[],
    baseline_tree_id: row.baseline_tree_id ?? undefined,
    probe_state:
      row.probe_state === "paused" || row.probe_state === "resumed"
        ? row.probe_state
        : undefined,
  };
}

function rowToStep(row: StepRow): Step {
  return {
    step_id: row.step_id,
    run_id: row.run_id,
    parent_step_id: row.parent_step_id ?? undefined,
    fork_origin_id: row.fork_origin_id ?? undefined,
    sequence: row.sequence,
    timestamp: row.timestamp,
    model: row.model,
    context_snapshot_id: row.context_snapshot_id,
    decision_ref: row.decision_ref,
    action: JSON.parse(row.action_json) as Action,
    outcome: JSON.parse(row.outcome_json) as Outcome,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      cached_read: row.tokens_cached_read,
      cache_creation: row.tokens_cache_creation,
      cache_creation_1h: row.tokens_cache_creation_1h ?? 0,
      reasoning: row.tokens_reasoning ?? undefined,
    },
    latency_ms: row.latency_ms,
    cost_cents: row.cost_cents,
    tags: JSON.parse(row.tags) as string[],
    status: row.status as StepStatus,
  };
}

export function upsertProjectByCwd(
  store: Store,
  cwd: string,
  name?: string,
): Project {
  const existing = store.db
    .prepare("SELECT * FROM projects WHERE cwd = ?")
    .get(cwd) as Project | undefined;
  if (existing) return existing;
  const project: Project = {
    project_id: `prj_${randomUUID()}`,
    cwd,
    name: name ?? cwd.split("/").pop() ?? cwd,
    created_at: new Date().toISOString(),
  };
  store.db
    .prepare(
      "INSERT INTO projects(project_id, name, cwd, created_at) VALUES (?,?,?,?)",
    )
    .run(project.project_id, project.name, project.cwd, project.created_at);
  return project;
}

export function upsertAgent(
  store: Store,
  projectId: string,
  name: string,
): { agent_id: string; project_id: string; name: string; created_at: string } {
  const existing = store.db
    .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ?")
    .get(projectId, name) as
    | { agent_id: string; project_id: string; name: string; created_at: string }
    | undefined;
  if (existing) return existing;
  const agent = {
    agent_id: `agt_${randomUUID()}`,
    project_id: projectId,
    name,
    created_at: new Date().toISOString(),
  };
  store.db
    .prepare("INSERT INTO agents(agent_id, project_id, name, created_at) VALUES (?,?,?,?)")
    .run(agent.agent_id, agent.project_id, agent.name, agent.created_at);
  return agent;
}

export function insertRun(store: Store, run: Run): void {
  store.db
    .prepare(
      `INSERT INTO runs(
        run_id, agent_id, project_id, source_session_id, source_runtime,
        title, status, started_at, ended_at, git_branch, cwd,
        fork_origin_run_id, fork_origin_step_id,
        tokens_total_input, tokens_total_output, tokens_total_cached,
        cost_cents, step_count, tags,
        baseline_tree_id, probe_state
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      run.run_id,
      run.agent_id,
      run.project_id,
      run.source_session_id ?? null,
      run.source_runtime,
      run.title ?? null,
      run.status,
      run.started_at,
      run.ended_at ?? null,
      run.git_branch ?? null,
      run.cwd ?? null,
      run.fork_origin_run_id ?? null,
      run.fork_origin_step_id ?? null,
      run.tokens_total_input,
      run.tokens_total_output,
      run.tokens_total_cached,
      run.cost_cents,
      run.step_count,
      JSON.stringify(run.tags ?? []),
      run.baseline_tree_id ?? null,
      run.probe_state ?? null,
    );
}

export function updateRunTotals(store: Store, runId: string): void {
  store.db
    .prepare(
      `UPDATE runs SET
         step_count = (SELECT COUNT(*) FROM steps WHERE run_id = runs.run_id),
         tokens_total_input = COALESCE(
           (SELECT SUM(tokens_input) FROM steps WHERE run_id = runs.run_id), 0),
         tokens_total_output = COALESCE(
           (SELECT SUM(tokens_output) FROM steps WHERE run_id = runs.run_id), 0),
         tokens_total_cached = COALESCE(
           (SELECT SUM(tokens_cached_read + tokens_cache_creation + tokens_cache_creation_1h)
              FROM steps WHERE run_id = runs.run_id), 0),
         cost_cents = COALESCE(
           (SELECT SUM(cost_cents) FROM steps WHERE run_id = runs.run_id), 0)
       WHERE run_id = ?`,
    )
    .run(runId);
}

export function setRunStatus(
  store: Store,
  runId: string,
  status: StepStatus,
  endedAt?: string,
): void {
  store.db
    .prepare("UPDATE runs SET status = ?, ended_at = ? WHERE run_id = ?")
    .run(status, endedAt ?? null, runId);
}

export function insertStep(store: Store, step: Step): void {
  store.db
    .prepare(
      `INSERT OR REPLACE INTO steps(
        step_id, run_id, parent_step_id, fork_origin_id, sequence, timestamp,
        model, context_snapshot_id, decision_ref, action_json, outcome_json,
        tokens_input, tokens_output, tokens_cached_read, tokens_cache_creation,
        tokens_cache_creation_1h, tokens_reasoning, latency_ms, cost_cents,
        status, tags
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      step.step_id,
      step.run_id,
      step.parent_step_id ?? null,
      step.fork_origin_id ?? null,
      step.sequence,
      step.timestamp,
      step.model,
      step.context_snapshot_id,
      step.decision_ref,
      JSON.stringify(step.action),
      JSON.stringify(step.outcome),
      step.tokens.input,
      step.tokens.output,
      step.tokens.cached_read,
      step.tokens.cache_creation,
      step.tokens.cache_creation_1h ?? 0,
      step.tokens.reasoning ?? null,
      step.latency_ms,
      step.cost_cents,
      step.status,
      JSON.stringify(step.tags ?? []),
    );
}

export function recordContextSnapshot(
  store: Store,
  snapshotId: string,
  blobRef: string,
  componentCount: number,
): void {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO context_snapshots(snapshot_id, blob_ref, component_count, created_at)
       VALUES (?,?,?,?)`,
    )
    .run(snapshotId, blobRef, componentCount, new Date().toISOString());
}

/** Translate a logical snapshot_id (hash of components) into the blob_ref
 *  under which the serialized snapshot is stored. Falls back to using the
 *  snapshot_id itself if no mapping is recorded — handy for round-tripped
 *  traces where the two hashes happen to coincide. */
export function resolveSnapshotBlobRef(
  store: Store,
  snapshotId: string,
): string {
  const row = store.db
    .prepare("SELECT blob_ref FROM context_snapshots WHERE snapshot_id = ?")
    .get(snapshotId) as { blob_ref: string } | undefined;
  return row?.blob_ref ?? snapshotId;
}

export function getRun(store: Store, runId: string): Run | undefined {
  // Exact match wins. If not present, try a unique prefix match — common
  // because the CLI displays the first 12 characters of the id.
  const exact = store.db
    .prepare("SELECT * FROM runs WHERE run_id = ?")
    .get(runId) as RunRow | undefined;
  if (exact) return rowToRun(exact);
  if (runId.length < 6) return undefined;
  const prefix = store.db
    .prepare("SELECT * FROM runs WHERE run_id LIKE ? LIMIT 2")
    .all(`${runId}%`) as RunRow[];
  if (prefix.length === 1) return rowToRun(prefix[0]!);
  return undefined;
}

export interface ListRunsOpts {
  limit?: number;
  projectId?: string;
  agentId?: string;
  status?: StepStatus;
  containsTool?: string;
}

export function listRuns(store: Store, opts: ListRunsOpts = {}): Run[] {
  const params: unknown[] = [];
  let where = "1=1";
  if (opts.projectId) {
    where += " AND project_id = ?";
    params.push(opts.projectId);
  }
  if (opts.agentId) {
    where += " AND agent_id = ?";
    params.push(opts.agentId);
  }
  if (opts.status) {
    where += " AND status = ?";
    params.push(opts.status);
  }
  if (opts.containsTool) {
    where +=
      " AND run_id IN (SELECT run_id FROM steps WHERE action_json LIKE ?)";
    params.push(`%"tool_name":"${opts.containsTool}"%`);
  }
  const limit = opts.limit ?? 50;
  const rows = store.db
    .prepare(
      `SELECT * FROM runs WHERE ${where} ORDER BY started_at DESC LIMIT ?`,
    )
    .all(...params, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function listSteps(store: Store, runId: string): Step[] {
  const rows = store.db
    .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY sequence ASC")
    .all(runId) as StepRow[];
  return rows.map(rowToStep);
}

export function getStep(store: Store, stepId: string): Step | undefined {
  const exact = store.db
    .prepare("SELECT * FROM steps WHERE step_id = ?")
    .get(stepId) as StepRow | undefined;
  if (exact) return rowToStep(exact);
  if (stepId.length < 6) return undefined;
  const prefix = store.db
    .prepare("SELECT * FROM steps WHERE step_id LIKE ? LIMIT 2")
    .all(`${stepId}%`) as StepRow[];
  if (prefix.length === 1) return rowToStep(prefix[0]!);
  return undefined;
}

export function getStepBySequence(
  store: Store,
  runId: string,
  sequence: number,
): Step | undefined {
  const row = store.db
    .prepare("SELECT * FROM steps WHERE run_id = ? AND sequence = ?")
    .get(runId, sequence) as StepRow | undefined;
  return row ? rowToStep(row) : undefined;
}

export function insertFork(
  store: Store,
  args: {
    originRunId: string;
    originStepId: string;
    forkRunId: string;
    edit: ForkEdit;
  },
): string {
  const fork_id = `frk_${randomUUID()}`;
  store.db
    .prepare(
      `INSERT INTO forks(fork_id, origin_run_id, origin_step_id, fork_run_id,
                          edit_type, edit_payload_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      fork_id,
      args.originRunId,
      args.originStepId,
      args.forkRunId,
      args.edit.type,
      JSON.stringify(args.edit.payload ?? null),
      new Date().toISOString(),
    );
  return fork_id;
}

export function listForks(
  store: Store,
  originRunId: string,
): Array<{
  fork_id: string;
  origin_run_id: string;
  origin_step_id: string;
  fork_run_id: string;
  edit_type: string;
  created_at: string;
}> {
  return store.db
    .prepare(
      "SELECT fork_id, origin_run_id, origin_step_id, fork_run_id, edit_type, created_at FROM forks WHERE origin_run_id = ? ORDER BY created_at",
    )
    .all(originRunId) as Array<{
    fork_id: string;
    origin_run_id: string;
    origin_step_id: string;
    fork_run_id: string;
    edit_type: string;
    created_at: string;
  }>;
}

export function insertAnnotation(
  store: Store,
  args: {
    targetKind: "step" | "run";
    targetId: string;
    author: string;
    verdict?: AnnotationVerdict;
    note?: string;
  },
): Annotation {
  const ann: Annotation = {
    annotation_id: `ann_${randomUUID()}`,
    target_kind: args.targetKind,
    target_id: args.targetId,
    author: args.author,
    verdict: args.verdict,
    note: args.note,
    created_at: new Date().toISOString(),
  };
  store.db
    .prepare(
      `INSERT INTO annotations(annotation_id, target_kind, target_id, author, verdict, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      ann.annotation_id,
      ann.target_kind,
      ann.target_id,
      ann.author,
      ann.verdict ?? null,
      ann.note ?? null,
      ann.created_at,
    );
  return ann;
}

export function listAnnotations(
  store: Store,
  targetKind: "step" | "run",
  targetId: string,
): Annotation[] {
  const rows = store.db
    .prepare(
      "SELECT * FROM annotations WHERE target_kind = ? AND target_id = ? ORDER BY created_at",
    )
    .all(targetKind, targetId) as Array<{
    annotation_id: string;
    target_kind: string;
    target_id: string;
    author: string;
    verdict: string | null;
    note: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    annotation_id: r.annotation_id,
    target_kind: r.target_kind as "step" | "run",
    target_id: r.target_id,
    author: r.author,
    verdict: (r.verdict ?? undefined) as AnnotationVerdict | undefined,
    note: r.note ?? undefined,
    created_at: r.created_at,
  }));
}

export function getIngestOffset(
  store: Store,
  source_runtime: string,
  source_path: string,
): number {
  const row = store.db
    .prepare(
      "SELECT last_offset FROM ingest_progress WHERE source_runtime = ? AND source_path = ?",
    )
    .get(source_runtime, source_path) as { last_offset: number } | undefined;
  return row?.last_offset ?? 0;
}

export function setIngestOffset(
  store: Store,
  source_runtime: string,
  source_path: string,
  offset: number,
): void {
  store.db
    .prepare(
      `INSERT INTO ingest_progress(source_runtime, source_path, last_offset, last_ingested_at)
       VALUES(?,?,?,?)
       ON CONFLICT(source_runtime, source_path) DO UPDATE SET
         last_offset = excluded.last_offset,
         last_ingested_at = excluded.last_ingested_at`,
    )
    .run(source_runtime, source_path, offset, new Date().toISOString());
}

export function getRunBySessionId(
  store: Store,
  sourceSessionId: string,
): Run | undefined {
  const row = store.db
    .prepare("SELECT * FROM runs WHERE source_session_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(sourceSessionId) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function aggregateTokens(steps: Step[]): TokenUsage {
  return steps.reduce<TokenUsage>(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      output: acc.output + s.tokens.output,
      cached_read: acc.cached_read + s.tokens.cached_read,
      cache_creation: acc.cache_creation + s.tokens.cache_creation,
      cache_creation_1h:
        (acc.cache_creation_1h ?? 0) + (s.tokens.cache_creation_1h ?? 0),
    }),
    {
      input: 0,
      output: 0,
      cached_read: 0,
      cache_creation: 0,
      cache_creation_1h: 0,
    },
  );
}

/* ────────────────────────────────────────────────────────────────────
 * v0.3 — file_change CRUD (Track A)
 *
 * Vendor-neutral row-level access. The Claude Code adapter, Codex
 * adapter (v0.4), SDK helpers (v0.4), and proxy partials (v0.4) all
 * funnel through `insertFileChange` so they share idempotency
 * (UNIQUE(step_id, sequence)) and JSON-encoding semantics.
 * ──────────────────────────────────────────────────────────────────── */

interface FileChangeRow {
  file_change_id: string;
  run_id: string;
  step_id: string;
  sequence: number;
  tool_call_id: string | null;
  derived_from: string;
  path: string;
  old_path: string | null;
  op: string;
  before_blob_ref: string | null;
  after_blob_ref: string | null;
  partial_diff: number;
  gitignored: number;
  patch_text: string | null;
  patch_format: string | null;
  encoding: string | null;
  bom: number;
  line_endings: string | null;
  mime: string | null;
  language: string | null;
  size_before: number | null;
  size_after: number | null;
  line_count_before: number | null;
  line_count_after: number | null;
  lines_added: number;
  lines_removed: number;
  mode_before: number | null;
  mode_after: number | null;
  source_tool_name: string | null;
  source_tool_input: string | null;
  redacted: number;
  normalizer_notes: string | null;
  created_at: string;
}

function rowToFileChange(row: FileChangeRow): FileChange {
  return {
    file_change_id: row.file_change_id,
    run_id: row.run_id,
    step_id: row.step_id,
    sequence: row.sequence,
    tool_call_id: row.tool_call_id ?? undefined,
    derived_from: row.derived_from as FileChangeSource,
    path: row.path,
    old_path: row.old_path ?? undefined,
    op: row.op as FileOp,
    before_blob_ref: row.before_blob_ref ?? undefined,
    after_blob_ref: row.after_blob_ref ?? undefined,
    partial_diff: row.partial_diff === 1,
    gitignored: row.gitignored === 1,
    patch_text: row.patch_text ?? undefined,
    patch_format: (row.patch_format as PatchFormat | null) ?? undefined,
    encoding: (row.encoding as FileEncoding | null) ?? undefined,
    bom: row.bom === 1,
    line_endings: (row.line_endings as LineEndings | null) ?? undefined,
    mime: row.mime ?? undefined,
    language: row.language ?? undefined,
    size_before: row.size_before ?? undefined,
    size_after: row.size_after ?? undefined,
    line_count_before: row.line_count_before ?? undefined,
    line_count_after: row.line_count_after ?? undefined,
    lines_added: row.lines_added,
    lines_removed: row.lines_removed,
    mode_before: row.mode_before ?? undefined,
    mode_after: row.mode_after ?? undefined,
    source_tool_name: row.source_tool_name ?? undefined,
    source_tool_input: row.source_tool_input
      ? safeJsonParse(row.source_tool_input)
      : undefined,
    redacted: row.redacted === 1,
    normalizer_notes: row.normalizer_notes
      ? safeJsonParse(row.normalizer_notes)
      : undefined,
    created_at: row.created_at,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s; // pass through raw if it isn't JSON
  }
}

/**
 * Thrown by `insertFileChange` when a candidate row violates the
 * biconditional contract documented on `FileChange` in
 * `packages/shared/src/types.ts:242-244`:
 *
 *   - `before_blob_ref` is null iff op === "create" OR partial_diff
 *   - `after_blob_ref`  is null iff op === "delete" OR partial_diff
 *   - op === "rename" requires `old_path`
 *
 * `chmod` is the documented exception — it's a mode-only operation
 * and is exempt from both blob_ref biconditionals. The replay layer
 * (`applyFileChange`) treats chmod blob refs as a no-op regardless,
 * so accepting either shape is safe.
 *
 * Hard-fail by design: an adapter that produces an invariant-violating
 * row would otherwise ship the malformation silently into the DB and
 * surface as a downstream rendering or replay bug. Better to throw at
 * the boundary.
 */
export class FileChangeInvariantError extends Error {
  constructor(message: string) {
    super(`FileChange invariant violation: ${message}`);
    this.name = "FileChangeInvariantError";
  }
}

/**
 * Verify a candidate FileChange satisfies the contract on `FileChange`
 * in `packages/shared/src/types.ts`. Throws `FileChangeInvariantError`
 * with a clear message on the first violation. Pure; no side effects.
 *
 * Exported for direct testing.
 */
export function assertFileChangeInvariants(fc: {
  op: FileChange["op"];
  partial_diff: boolean;
  before_blob_ref?: string;
  after_blob_ref?: string;
  old_path?: string;
}): void {
  // chmod is mode-only — exempt from blob_ref rules.
  if (fc.op === "chmod") return;

  // partial_diff overrides per-op rules: both blob refs MUST be null.
  if (fc.partial_diff) {
    if (fc.before_blob_ref !== undefined) {
      throw new FileChangeInvariantError(
        `partial_diff=true requires before_blob_ref to be null (got ${JSON.stringify(fc.before_blob_ref)})`,
      );
    }
    if (fc.after_blob_ref !== undefined) {
      throw new FileChangeInvariantError(
        `partial_diff=true requires after_blob_ref to be null (got ${JSON.stringify(fc.after_blob_ref)})`,
      );
    }
    return;
  }

  // Non-partial create: no prior state → before must be null; new
  // content → after must be set.
  if (fc.op === "create") {
    if (fc.before_blob_ref !== undefined) {
      throw new FileChangeInvariantError(
        "op='create' requires before_blob_ref to be null",
      );
    }
    if (fc.after_blob_ref === undefined) {
      throw new FileChangeInvariantError(
        "op='create' requires after_blob_ref to be set",
      );
    }
    return;
  }

  // Non-partial delete: prior state captured → before set; no after.
  if (fc.op === "delete") {
    if (fc.before_blob_ref === undefined) {
      throw new FileChangeInvariantError(
        "op='delete' requires before_blob_ref to be set",
      );
    }
    if (fc.after_blob_ref !== undefined) {
      throw new FileChangeInvariantError(
        "op='delete' requires after_blob_ref to be null",
      );
    }
    return;
  }

  // modify + rename: both blob refs required for full-fidelity capture.
  // If the adapter couldn't capture either side, it should set
  // partial_diff=true (which short-circuited above).
  if (fc.before_blob_ref === undefined) {
    throw new FileChangeInvariantError(
      `op='${fc.op}' requires before_blob_ref to be set (use partial_diff=true if not captured)`,
    );
  }
  if (fc.after_blob_ref === undefined) {
    throw new FileChangeInvariantError(
      `op='${fc.op}' requires after_blob_ref to be set (use partial_diff=true if not captured)`,
    );
  }

  if (fc.op === "rename" && fc.old_path === undefined) {
    throw new FileChangeInvariantError("op='rename' requires old_path to be set");
  }
}

/**
 * Insert a FileChange row. ID auto-generated if not provided.
 *
 * Idempotency: the schema's `UNIQUE(step_id, sequence)` constraint
 * means writing the same logical FileChange twice will fail loudly.
 * Adapters should compute deterministic `(step_id, sequence)` so a
 * re-ingest of the same JSONL session doesn't duplicate rows.
 *
 * `created_at` defaults to "now" if omitted — adapters usually want
 * this since they don't have a per-FileChange wall-clock from the
 * source.
 *
 * Validation: every row passes through `assertFileChangeInvariants`
 * before the INSERT. Adapter bugs that would otherwise ship malformed
 * rows surface here as a thrown `FileChangeInvariantError` rather
 * than as a silent downstream replay bug.
 */
export function insertFileChange(
  store: Store,
  fc: Omit<FileChange, "file_change_id" | "created_at"> & {
    file_change_id?: string;
    created_at?: string;
  },
): FileChange {
  assertFileChangeInvariants(fc);
  const id = fc.file_change_id ?? `fc_${randomUUID()}`;
  const created = fc.created_at ?? new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO file_change(
        file_change_id, run_id, step_id, sequence,
        tool_call_id, derived_from, path, old_path, op,
        before_blob_ref, after_blob_ref,
        partial_diff, gitignored,
        patch_text, patch_format,
        encoding, bom, line_endings, mime, language,
        size_before, size_after, line_count_before, line_count_after,
        lines_added, lines_removed,
        mode_before, mode_after,
        source_tool_name, source_tool_input,
        redacted, normalizer_notes, created_at
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?,
         ?, ?,
         ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?,
         ?, ?,
         ?, ?,
         ?, ?, ?
       )`,
    )
    .run(
      id,
      fc.run_id,
      fc.step_id,
      fc.sequence,
      fc.tool_call_id ?? null,
      fc.derived_from,
      fc.path,
      fc.old_path ?? null,
      fc.op,
      fc.before_blob_ref ?? null,
      fc.after_blob_ref ?? null,
      fc.partial_diff ? 1 : 0,
      fc.gitignored ? 1 : 0,
      fc.patch_text ?? null,
      fc.patch_format ?? null,
      fc.encoding ?? null,
      fc.bom ? 1 : 0,
      fc.line_endings ?? null,
      fc.mime ?? null,
      fc.language ?? null,
      fc.size_before ?? null,
      fc.size_after ?? null,
      fc.line_count_before ?? null,
      fc.line_count_after ?? null,
      fc.lines_added,
      fc.lines_removed,
      fc.mode_before ?? null,
      fc.mode_after ?? null,
      fc.source_tool_name ?? null,
      fc.source_tool_input !== undefined
        ? JSON.stringify(fc.source_tool_input)
        : null,
      fc.redacted ? 1 : 0,
      fc.normalizer_notes !== undefined
        ? JSON.stringify(fc.normalizer_notes)
        : null,
      created,
    );
  return {
    file_change_id: id,
    run_id: fc.run_id,
    step_id: fc.step_id,
    sequence: fc.sequence,
    tool_call_id: fc.tool_call_id,
    derived_from: fc.derived_from,
    path: fc.path,
    old_path: fc.old_path,
    op: fc.op,
    before_blob_ref: fc.before_blob_ref,
    after_blob_ref: fc.after_blob_ref,
    partial_diff: fc.partial_diff,
    gitignored: fc.gitignored,
    patch_text: fc.patch_text,
    patch_format: fc.patch_format,
    encoding: fc.encoding,
    bom: fc.bom,
    line_endings: fc.line_endings,
    mime: fc.mime,
    language: fc.language,
    size_before: fc.size_before,
    size_after: fc.size_after,
    line_count_before: fc.line_count_before,
    line_count_after: fc.line_count_after,
    lines_added: fc.lines_added,
    lines_removed: fc.lines_removed,
    mode_before: fc.mode_before,
    mode_after: fc.mode_after,
    source_tool_name: fc.source_tool_name,
    source_tool_input: fc.source_tool_input,
    redacted: fc.redacted,
    normalizer_notes: fc.normalizer_notes,
    created_at: created,
  };
}

export interface ListFileChangesOpts {
  runId?: string;
  stepId?: string;
  path?: string;
  /**
   * Used by the replay algorithm: include only FileChanges for steps
   * with sequence < this value. Implemented via a join on `steps`. If
   * `runId` is also given, the join is scoped to that run.
   */
  maxStepSeqExclusive?: number;
}

/**
 * Sort order is `(step.sequence ASC, file_change.sequence ASC)` which
 * matches the replay algorithm's contract (v0.3 §3.6): later steps win
 * over earlier ones, and within a step, the intra-step `sequence` field
 * preserves atomic-batch ordering (MultiEdit fans out N rows in order).
 */
export function listFileChanges(
  store: Store,
  opts: ListFileChangesOpts = {},
): FileChange[] {
  const params: unknown[] = [];
  let where = "1=1";
  if (opts.runId) {
    where += " AND fc.run_id = ?";
    params.push(opts.runId);
  }
  if (opts.stepId) {
    where += " AND fc.step_id = ?";
    params.push(opts.stepId);
  }
  if (opts.path) {
    where += " AND (fc.path = ? OR fc.old_path = ?)";
    params.push(opts.path, opts.path);
  }
  if (opts.maxStepSeqExclusive !== undefined) {
    where += " AND s.sequence < ?";
    params.push(opts.maxStepSeqExclusive);
  }
  const rows = store.db
    .prepare(
      `SELECT fc.*
         FROM file_change fc
         JOIN steps s ON s.step_id = fc.step_id
        WHERE ${where}
        ORDER BY s.sequence ASC, fc.sequence ASC`,
    )
    .all(...params) as FileChangeRow[];
  return rows.map(rowToFileChange);
}

export function getFileChange(
  store: Store,
  fileChangeId: string,
): FileChange | undefined {
  const row = store.db
    .prepare("SELECT * FROM file_change WHERE file_change_id = ?")
    .get(fileChangeId) as FileChangeRow | undefined;
  return row ? rowToFileChange(row) : undefined;
}

/* ────────────────────────────────────────────────────────────────────
 * v0.3 — baseline_tree CRUD + run-state setters
 * ──────────────────────────────────────────────────────────────────── */

interface BaselineTreeRow {
  baseline_tree_id: string;
  project_id: string;
  manifest_blob_ref: string;
  git_head: string | null;
  git_dirty: number;
  captured_at: string;
}

function rowToBaselineTree(row: BaselineTreeRow): BaselineTree {
  return {
    baseline_tree_id: row.baseline_tree_id,
    project_id: row.project_id,
    manifest_blob_ref: row.manifest_blob_ref,
    git_head: row.git_head ?? undefined,
    git_dirty: row.git_dirty === 1,
    captured_at: row.captured_at,
  };
}

export function insertBaselineTree(
  store: Store,
  bt: Omit<BaselineTree, "baseline_tree_id" | "captured_at"> & {
    baseline_tree_id?: string;
    captured_at?: string;
  },
): BaselineTree {
  const id = bt.baseline_tree_id ?? `bt_${randomUUID()}`;
  const captured = bt.captured_at ?? new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO baseline_tree(
         baseline_tree_id, project_id, manifest_blob_ref,
         git_head, git_dirty, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      bt.project_id,
      bt.manifest_blob_ref,
      bt.git_head ?? null,
      bt.git_dirty ? 1 : 0,
      captured,
    );
  return {
    baseline_tree_id: id,
    project_id: bt.project_id,
    manifest_blob_ref: bt.manifest_blob_ref,
    git_head: bt.git_head,
    git_dirty: bt.git_dirty,
    captured_at: captured,
  };
}

export function getBaselineTree(
  store: Store,
  baselineTreeId: string,
): BaselineTree | undefined {
  const row = store.db
    .prepare("SELECT * FROM baseline_tree WHERE baseline_tree_id = ?")
    .get(baselineTreeId) as BaselineTreeRow | undefined;
  return row ? rowToBaselineTree(row) : undefined;
}

/**
 * Find an existing baseline_tree row by its manifest blob ref — useful
 * during baseline capture so two runs against the same git HEAD don't
 * create two rows pointing at the same content. v0.3 §3.5 calls this
 * out as the dominant dedup win.
 */
export function findBaselineByManifest(
  store: Store,
  projectId: string,
  manifestBlobRef: string,
): BaselineTree | undefined {
  const row = store.db
    .prepare(
      "SELECT * FROM baseline_tree WHERE project_id = ? AND manifest_blob_ref = ? LIMIT 1",
    )
    .get(projectId, manifestBlobRef) as BaselineTreeRow | undefined;
  return row ? rowToBaselineTree(row) : undefined;
}

/**
 * Attach a baseline tree to a run. Idempotent: passing the same id
 * twice is a no-op. Passing a different id overwrites (the assumption
 * being that the adapter re-walked the cwd and produced a new
 * manifest — rare but legal).
 */
export function setRunBaselineTree(
  store: Store,
  runId: string,
  baselineTreeId: string,
): void {
  store.db
    .prepare("UPDATE runs SET baseline_tree_id = ? WHERE run_id = ?")
    .run(baselineTreeId, runId);
}

/**
 * Set the Live Probe state on a run. Pass `null` to clear. v0.3 §4 —
 * only meaningful for source_runtime in (sdk-ts, sdk-py); callers are
 * responsible for that guard.
 */
export function setRunProbeState(
  store: Store,
  runId: string,
  state: ProbeState | null,
): void {
  store.db
    .prepare("UPDATE runs SET probe_state = ? WHERE run_id = ?")
    .run(state, runId);
}
