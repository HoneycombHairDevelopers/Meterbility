import type { Run, Step } from "@spool-ai/shared";
import type { PostgresStore } from "./store.ts";

/**
 * A subset of the SQLite query surface, ported to async Postgres. The
 * mapping is mechanical — same column names, same JSON columns. Only
 * the most common reads/writes are implemented in v0.1; the rest land
 * as we wire each surface (web, replay, regression) to optionally use
 * the Postgres backend.
 */

interface RunRow {
  run_id: string;
  agent_id: string;
  project_id: string;
  source_session_id: string | null;
  source_runtime: string;
  title: string | null;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  git_branch: string | null;
  cwd: string | null;
  fork_origin_run_id: string | null;
  fork_origin_step_id: string | null;
  tokens_total_input: string | number;
  tokens_total_output: string | number;
  tokens_total_cached: string | number;
  cost_cents: number;
  step_count: number;
  tags: string[];
}

function rowToRun(r: RunRow): Run {
  return {
    run_id: r.run_id,
    agent_id: r.agent_id,
    project_id: r.project_id,
    source_session_id: r.source_session_id ?? undefined,
    source_runtime: r.source_runtime as Run["source_runtime"],
    title: r.title ?? undefined,
    status: r.status as Run["status"],
    started_at: r.started_at.toISOString(),
    ended_at: r.ended_at?.toISOString() ?? undefined,
    git_branch: r.git_branch ?? undefined,
    cwd: r.cwd ?? undefined,
    fork_origin_run_id: r.fork_origin_run_id ?? undefined,
    fork_origin_step_id: r.fork_origin_step_id ?? undefined,
    tokens_total_input: Number(r.tokens_total_input),
    tokens_total_output: Number(r.tokens_total_output),
    tokens_total_cached: Number(r.tokens_total_cached),
    cost_cents: Number(r.cost_cents),
    step_count: r.step_count,
    tags: Array.isArray(r.tags) ? r.tags : [],
  };
}

interface StepRow {
  step_id: string;
  run_id: string;
  parent_step_id: string | null;
  fork_origin_id: string | null;
  sequence: number;
  timestamp: Date;
  model: string;
  context_snapshot_id: string;
  decision_ref: string;
  action: Step["action"];
  outcome: Step["outcome"];
  tokens_input: string | number;
  tokens_output: string | number;
  tokens_cached_read: string | number;
  tokens_cache_creation: string | number;
  tokens_cache_creation_1h: string | number;
  tokens_reasoning: string | number | null;
  latency_ms: number;
  cost_cents: number;
  status: string;
  tags: string[];
}

function rowToStep(r: StepRow): Step {
  return {
    step_id: r.step_id,
    run_id: r.run_id,
    parent_step_id: r.parent_step_id ?? undefined,
    fork_origin_id: r.fork_origin_id ?? undefined,
    sequence: r.sequence,
    timestamp: r.timestamp.toISOString(),
    model: r.model,
    context_snapshot_id: r.context_snapshot_id,
    decision_ref: r.decision_ref,
    action: r.action,
    outcome: r.outcome,
    tokens: {
      input: Number(r.tokens_input),
      output: Number(r.tokens_output),
      cached_read: Number(r.tokens_cached_read),
      cache_creation: Number(r.tokens_cache_creation),
      cache_creation_1h: Number(r.tokens_cache_creation_1h ?? 0),
      reasoning: r.tokens_reasoning != null ? Number(r.tokens_reasoning) : undefined,
    },
    latency_ms: r.latency_ms,
    cost_cents: Number(r.cost_cents),
    tags: Array.isArray(r.tags) ? r.tags : [],
    status: r.status as Step["status"],
  };
}

export async function pgUpsertProject(
  store: PostgresStore,
  cwd: string,
  name?: string,
): Promise<{ project_id: string; cwd: string; name: string }> {
  const existing = await store.client.query<{
    project_id: string;
    cwd: string;
    name: string;
  }>("SELECT project_id, cwd, name FROM projects WHERE cwd = $1", [cwd]);
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0]!;
  const id = `prj_${cryptoRandom()}`;
  const display = name ?? cwd.split("/").pop() ?? cwd;
  await store.client.query(
    "INSERT INTO projects(project_id, name, cwd, created_at) VALUES ($1,$2,$3,NOW())",
    [id, display, cwd],
  );
  return { project_id: id, cwd, name: display };
}

export async function pgUpsertAgent(
  store: PostgresStore,
  projectId: string,
  name: string,
): Promise<{ agent_id: string; project_id: string; name: string }> {
  const existing = await store.client.query<{
    agent_id: string;
    project_id: string;
    name: string;
  }>(
    "SELECT agent_id, project_id, name FROM agents WHERE project_id = $1 AND name = $2",
    [projectId, name],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0]!;
  const id = `agt_${cryptoRandom()}`;
  await store.client.query(
    "INSERT INTO agents(agent_id, project_id, name, created_at) VALUES ($1,$2,$3,NOW())",
    [id, projectId, name],
  );
  return { agent_id: id, project_id: projectId, name };
}

export async function pgInsertRun(store: PostgresStore, run: Run): Promise<void> {
  await store.client.query(
    `INSERT INTO runs(
       run_id, agent_id, project_id, source_session_id, source_runtime,
       title, status, started_at, ended_at, git_branch, cwd,
       fork_origin_run_id, fork_origin_step_id,
       tokens_total_input, tokens_total_output, tokens_total_cached,
       cost_cents, step_count, tags
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
     ON CONFLICT (run_id) DO UPDATE SET
       status = EXCLUDED.status,
       ended_at = EXCLUDED.ended_at,
       tokens_total_input = EXCLUDED.tokens_total_input,
       tokens_total_output = EXCLUDED.tokens_total_output,
       tokens_total_cached = EXCLUDED.tokens_total_cached,
       cost_cents = EXCLUDED.cost_cents,
       step_count = EXCLUDED.step_count,
       tags = EXCLUDED.tags`,
    [
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
    ],
  );
}

export async function pgInsertStep(store: PostgresStore, step: Step): Promise<void> {
  await store.client.query(
    `INSERT INTO steps(
       step_id, run_id, parent_step_id, fork_origin_id, sequence, timestamp,
       model, context_snapshot_id, decision_ref, action, outcome,
       tokens_input, tokens_output, tokens_cached_read, tokens_cache_creation,
       tokens_cache_creation_1h, tokens_reasoning, latency_ms, cost_cents,
       status, tags
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
     ON CONFLICT (step_id) DO UPDATE SET
       action = EXCLUDED.action,
       outcome = EXCLUDED.outcome,
       tokens_input = EXCLUDED.tokens_input,
       tokens_output = EXCLUDED.tokens_output,
       tokens_cached_read = EXCLUDED.tokens_cached_read,
       tokens_cache_creation = EXCLUDED.tokens_cache_creation,
       tokens_cache_creation_1h = EXCLUDED.tokens_cache_creation_1h,
       tokens_reasoning = EXCLUDED.tokens_reasoning,
       latency_ms = EXCLUDED.latency_ms,
       cost_cents = EXCLUDED.cost_cents,
       status = EXCLUDED.status,
       tags = EXCLUDED.tags`,
    [
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
    ],
  );
}

export async function pgListRuns(
  store: PostgresStore,
  opts: { limit?: number; projectId?: string } = {},
): Promise<Run[]> {
  const params: unknown[] = [];
  let where = "1=1";
  if (opts.projectId) {
    params.push(opts.projectId);
    where += ` AND project_id = $${params.length}`;
  }
  params.push(opts.limit ?? 50);
  const r = await store.client.query<RunRow>(
    `SELECT * FROM runs WHERE ${where} ORDER BY started_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(rowToRun);
}

export async function pgGetRun(
  store: PostgresStore,
  runId: string,
): Promise<Run | undefined> {
  const r = await store.client.query<RunRow>(
    "SELECT * FROM runs WHERE run_id = $1 OR run_id LIKE $2 LIMIT 2",
    [runId, `${runId}%`],
  );
  return r.rowCount === 1 ? rowToRun(r.rows[0]!) : undefined;
}

export async function pgListSteps(
  store: PostgresStore,
  runId: string,
): Promise<Step[]> {
  const r = await store.client.query<StepRow>(
    "SELECT * FROM steps WHERE run_id = $1 ORDER BY sequence ASC",
    [runId],
  );
  return r.rows.map(rowToStep);
}

function cryptoRandom(): string {
  const arr = new Uint8Array(8);
  // Lazy: don't import node:crypto here — call sites already do.
  for (let i = 0; i < 8; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
