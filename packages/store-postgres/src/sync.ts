import type { Store as SqliteStore } from "@spool-ai/collector";
import { listRuns, listSteps, resolveSnapshotBlobRef } from "@spool-ai/collector";
import {
  pgInsertRun,
  pgInsertStep,
  pgUpsertAgent,
  pgUpsertProject,
} from "./queries.ts";
import type { PostgresStore } from "./store.ts";

/**
 * Copy a local SQLite Store's data into a Postgres deployment. The
 * intended use case (SPEC §15.3): a team operator wants to share a
 * project's run history with teammates without giving up the local
 * dogfood loop.
 *
 * Idempotent — re-running won't duplicate rows because every insert
 * uses ON CONFLICT DO UPDATE.
 *
 * Sync order: projects → agents → runs → steps → blobs (referenced by
 * step rows and run rows).
 */
export interface SyncReport {
  runs: number;
  steps: number;
  blobs: number;
  bytes: number;
}

export async function syncSqliteToPostgres(
  sqlite: SqliteStore,
  postgres: PostgresStore,
  opts: { limitRuns?: number } = {},
): Promise<SyncReport> {
  const runs = listRuns(sqlite, { limit: opts.limitRuns ?? 1000 });
  const report: SyncReport = { runs: 0, steps: 0, blobs: 0, bytes: 0 };
  for (const run of runs) {
    // Ensure project + agent exist on the Postgres side. We use the
    // same ids as SQLite when possible, but the upserts will return
    // existing rows if there's already a row at that cwd / name.
    const proj = await pgUpsertProject(
      postgres,
      run.cwd ?? "(unknown)",
      run.cwd ?? undefined,
    );
    const agent = await pgUpsertAgent(postgres, proj.project_id, "synced");
    const remappedRun = {
      ...run,
      project_id: proj.project_id,
      agent_id: agent.agent_id,
    };
    await pgInsertRun(postgres, remappedRun);
    report.runs += 1;

    const steps = listSteps(sqlite, run.run_id);
    for (const step of steps) {
      await pgInsertStep(postgres, { ...step, run_id: remappedRun.run_id });
      report.steps += 1;

      // Sync referenced blobs.
      const refs = new Set<string>();
      refs.add(resolveSnapshotBlobRef(sqlite, step.context_snapshot_id));
      refs.add(step.decision_ref);
      if (step.outcome.tool_result_ref) refs.add(step.outcome.tool_result_ref);
      for (const r of refs) {
        const buf = await sqlite.blobs.getBuffer(r).catch(() => undefined);
        if (!buf) continue;
        await postgres.putBlob(buf, r);
        report.blobs += 1;
        report.bytes += buf.length;
      }
    }
  }
  return report;
}
