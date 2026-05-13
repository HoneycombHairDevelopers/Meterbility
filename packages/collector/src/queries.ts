import { randomUUID } from "node:crypto";
import type {
  Action,
  Annotation,
  AnnotationVerdict,
  ForkEdit,
  Outcome,
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
        cost_cents, step_count, tags
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
