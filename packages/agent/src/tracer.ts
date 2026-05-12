import { randomUUID } from "node:crypto";
import { Store } from "@spool/collector";
import {
  insertRun,
  setRunStatus,
  updateRunTotals,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool/collector";
import type { Run } from "@spool/shared";
import { SpoolStep } from "./step.ts";
import type { StartStepOptions, TracerOptions } from "./types.ts";

/**
 * Public SDK entry point.
 *
 * Lifecycle:
 *
 *   const tracer = new SpoolTracer({ project: "my-app", agent: "support" });
 *   const step = tracer.startStep({ model: "claude-opus-4-7", history });
 *   // ...call model, record outcome, record tokens...
 *   await step.end();
 *
 * One tracer instance = one Run. Create a new tracer per agent invocation.
 * The tracer is intentionally synchronous to create — capture should never
 * block the agent's hot path — and persists asynchronously via promises
 * returned from step.end().
 */
export class SpoolTracer {
  readonly run_id: string;
  readonly project_id: string;
  readonly agent_id: string;
  readonly store: Store;
  private stepCount = 0;
  private prevStepId?: string;
  private ended = false;
  private startedAt = new Date().toISOString();
  private status: "in_progress" | "ok" | "error" | "abandoned" = "in_progress";

  constructor(opts: TracerOptions) {
    if (opts.spoolHome) process.env.SPOOL_HOME = opts.spoolHome;
    this.store = Store.open();
    const project = upsertProjectByCwd(
      this.store,
      opts.cwd ?? opts.project,
      opts.project,
    );
    this.project_id = project.project_id;
    const agent = upsertAgent(this.store, project.project_id, opts.agent);
    this.agent_id = agent.agent_id;
    this.run_id = `run_${randomUUID()}`;
    const run: Run = {
      run_id: this.run_id,
      agent_id: this.agent_id,
      project_id: this.project_id,
      source_session_id: opts.sourceSessionId,
      source_runtime: opts.sourceRuntime ?? "sdk-ts",
      title: opts.runTitle,
      status: "in_progress",
      started_at: this.startedAt,
      git_branch: opts.gitBranch,
      cwd: opts.cwd ?? opts.project,
      tokens_total_input: 0,
      tokens_total_output: 0,
      tokens_total_cached: 0,
      cost_cents: 0,
      step_count: 0,
      tags: opts.tags ?? [],
    };
    insertRun(this.store, run);
  }

  /**
   * Begin one Step. Returns a {@link SpoolStep} the caller fills in
   * imperatively: recordDecision, recordOutcome, recordTokens, end.
   */
  startStep(opts: StartStepOptions): SpoolStep {
    const sequence = this.stepCount;
    const step = new SpoolStep({
      tracer: this,
      sequence,
      parent_step_id: this.prevStepId,
      startedAtMs: Date.now(),
      options: opts,
    });
    this.stepCount += 1;
    this.prevStepId = step.step_id;
    return step;
  }

  /**
   * Mark the run finished. Status is inferred from the last step's
   * outcome unless overridden. Caller must invoke before exiting so the
   * run row gets sealed and totals recomputed.
   */
  async end(
    overrides?: { status?: "ok" | "error" | "abandoned" },
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const status = overrides?.status ?? this.status;
    setRunStatus(this.store, this.run_id, status, new Date().toISOString());
    updateRunTotals(this.store, this.run_id);
    this.store.close();
  }

  /** Internal: notify tracer of a terminal status from a step. */
  _stepCompleted(stepStatus: "ok" | "error" | "in_progress" | "abandoned"): void {
    if (stepStatus === "error") this.status = "error";
    else if (stepStatus === "ok" && this.status !== "error")
      this.status = "ok";
  }

  /** Internal: bump totals after a step inserts. */
  _refreshTotals(): void {
    updateRunTotals(this.store, this.run_id);
  }
}
