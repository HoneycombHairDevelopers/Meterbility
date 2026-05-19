/**
 * Shared test utilities for `web.exhaustive.test.ts` (and any future
 * server route tests). Lifts the `freshStore() + scaffold()` pattern
 * out of `web_v0_3.test.ts` so we don't re-define it 50 times across
 * the exhaustive coverage of all 49 routes.
 *
 * Why not export from `web_v0_3.test.ts` directly: that's a `.test.ts`
 * file. Node's test runner happily ignores non-test exports, but the
 * conventional split keeps test files focused on tests and shared
 * helpers in their own module.
 *
 * Not a `.test.ts` itself — has no `test()` calls, so the runner skips
 * it as a top-level file but happily resolves it as an import.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertRun,
  insertStep,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool/collector";
import type { Run, Step } from "@spool/shared";

export interface ServerTestCtx {
  /** Test-scoped SPOOL_HOME directory (mkdtemp). */
  home: string;
  /** Open Store connection — caller responsible for store.close() in finally. */
  store: Store;
  /** Tear down: closes the store, removes the temp dir. */
  cleanup(): void;
}

/**
 * Open a fresh in-temp-dir Store with SPOOL_HOME set. Pair with
 * `cleanup()` in a `try`/`finally`. The Store is left open — tests
 * call `store.close()` themselves so they can introspect after.
 */
export function freshCtx(): ServerTestCtx {
  const home = mkdtempSync(join(tmpdir(), "spool-web-exh-"));
  process.env.SPOOL_HOME = home;
  const store = Store.open({ path: join(home, "spool.db") });
  return {
    home,
    store,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // already closed
      }
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

export interface ScaffoldResult {
  projectId: string;
  agentId: string;
  runId: string;
  stepIds: string[];
}

/**
 * Build a project + agent + run + N empty steps so route tests have
 * something to query against. The run is `status: "in_progress"` by
 * default so probe routes and the run-detail panel render. Pass
 * `{ status: "ok" }` to test sealed-run code paths.
 */
export function scaffoldRun(
  store: Store,
  opts: {
    stepCount?: number;
    status?: Run["status"];
    sourceRuntime?: Run["source_runtime"];
    title?: string;
  } = {},
): ScaffoldResult {
  const stepCount = opts.stepCount ?? 1;
  const project = upsertProjectByCwd(store, "/tmp/web-exh", "web-exh");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: opts.sourceRuntime ?? "claude-code",
    title: opts.title ?? "web exhaustive fixture",
    status: opts.status ?? "in_progress",
    started_at: new Date().toISOString(),
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
    projectId: project.project_id,
    agentId: agent.agent_id,
    runId,
    stepIds,
  };
}

/**
 * Read the first N events from an SSE response body. Each event in
 * the live channel is encoded as the standard `data: <json>\n\n` SSE
 * envelope; this helper parses them back into objects for assertion.
 *
 * Has a hard cap so a misbehaving stream doesn't hang the test runner.
 * The caller controls the cap via `maxBytes`. Default 64 KB is plenty
 * for the live route's initial burst.
 */
export async function readSseEvents(
  res: Response,
  count: number,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<unknown[]> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (!res.body) throw new Error("SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  let bytesRead = 0;

  while (events.length < count && Date.now() < deadline && bytesRead < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx = buffer.indexOf("\n\n");
    while (sepIdx !== -1 && events.length < count) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const dataLine = block
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (dataLine) {
        const payload = dataLine.slice(5).trimStart();
        try {
          events.push(JSON.parse(payload));
        } catch {
          events.push(payload);
        }
      }
      sepIdx = buffer.indexOf("\n\n");
    }
  }
  try {
    await reader.cancel();
  } catch {
    // already closed
  }
  return events;
}

/**
 * Convenience: build a JSON Request with the right Content-Type so
 * Hono's `c.req.json()` parses cleanly. Used by every POST/PUT test
 * that sends a body.
 */
export function jsonReq(
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "DELETE" = "POST",
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
