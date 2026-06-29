/**
 * Shared subprocess-driven CLI test utilities. Used by
 * `cli.exhaustive.test.ts` and any future command tests so the
 * `spawnSync` ceremony lives in one place.
 *
 * Strategy (D2 from main-web-cli-coverage-plan.md): every CLI test
 * spawns a real subprocess via tsx so it exercises Commander's argv
 * parsing, exit codes, and stdout/stderr formatting end-to-end. This
 * is slower than direct-import (~500ms per test) but catches CLI
 * integration bugs that no other method would.
 *
 * Not a `.test.ts` file — has no `test()` calls, so the test runner
 * skips it as a top-level entry but happily imports it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertRun,
  insertStep,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { Run, Step } from "@meterbility/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "index.ts");
const REPO_ROOT = resolve(__dirname, "../../..");

export interface Fixture {
  /** Test-scoped METERBILITY_HOME (mkdtempSync). */
  home: string;
  /** Optional scaffolded run id. */
  runId?: string;
  /** Optional scaffolded step ids. */
  stepIds?: string[];
  /** Tear down the temp dir. */
  cleanup(): void;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Run the meter CLI in a subprocess. Returns stdout/stderr/exit code.
 * METERBILITY_HOME is scoped to the fixture's temp dir; NO_COLOR is set so
 * `picocolors` output stays plain for stable assertions.
 */
export function runCli(
  args: string[],
  fx: Fixture,
  opts: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): CliResult {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", CLI_ENTRY, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        METERBILITY_HOME: fx.home,
        NO_COLOR: "1",
        ...opts.env,
      },
      input: opts.stdin,
      timeout: opts.timeoutMs,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

/**
 * Create a fresh METERBILITY_HOME with no scaffolded data. The cheapest
 * fixture: useful for commands that need a clean store and create
 * their own state (e.g., `init`).
 */
export function setupEmpty(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "meter-cli-exh-"));
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Create a fresh METERBILITY_HOME and seed it with a run + N steps. Most
 * read-side CLI commands (inspect, files, runs, diff, annotate)
 * need this.
 */
export function setupFixture(
  opts: {
    stepCount?: number;
    status?: Run["status"];
    title?: string;
  } = {},
): Fixture {
  const home = mkdtempSync(join(tmpdir(), "meter-cli-exh-"));
  process.env.METERBILITY_HOME = home;
  const store = Store.open({ path: join(home, "meterbility.db") });
  try {
    const project = upsertProjectByCwd(store, "/tmp/cli-exh", "cli-exh");
    const agent = upsertAgent(store, project.project_id, "claude-code");
    const runId = `run_${randomUUID()}`;
    const stepCount = opts.stepCount ?? 1;
    const run: Run = {
      run_id: runId,
      agent_id: agent.agent_id,
      project_id: project.project_id,
      source_runtime: "claude-code",
      title: opts.title ?? "cli exhaustive fixture",
      status: opts.status ?? "in_progress",
      started_at: new Date().toISOString(),
      cwd: "/tmp/cli-exh",
      tokens_total_input: 0,
      tokens_total_output: 0,
      tokens_total_cached: 0,
      cost_cents: 0,
      step_count: stepCount,
      tags: [],
    };
    insertRun(store, run);
    const stepIds: string[] = [];
    for (let i = 0; i < stepCount; i++) {
      const id = `stp_${randomUUID()}`;
      const step: Step = {
        step_id: id,
        run_id: runId,
        sequence: i,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        model: "claude-opus-4-7",
        context_snapshot_id: "snap_x",
        decision_ref: "blob_dec",
        action: { kind: "tool_call", tool_name: "Edit" },
        outcome: { status: "ok" },
        tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
        latency_ms: 0,
        cost_cents: 0,
        tags: [],
        status: "ok",
      };
      insertStep(store, step);
      stepIds.push(id);
    }
    return {
      home,
      runId,
      stepIds,
      cleanup: () => {
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      },
    };
  } finally {
    store.close();
  }
}
