/**
 * E2E fixture server.
 *
 * Boots a real spool web server against a temp SPOOL_HOME, seeds it with
 * a deterministic run + two pre-rendered step cards (so the test page has
 * enough markup to toggle), then exposes a test-only POST that appends a
 * third step and pokes the SSE pipe — that's how the spec exercises the
 * live-append code path without spinning up the real LiveInspector
 * (which watches the user's Claude Code projects dir).
 *
 * Why not reuse `serveApp` directly: `serveApp` builds the Hono app and
 * immediately calls `serve()`, leaving no seam to attach a test-only
 * route. So we mirror it here — same shape, plus one route.
 *
 * The bootstrap writes `fixture.json` next to this file containing the
 * port + run_id so the spec can look them up at runtime instead of
 * relying on hardcoded values.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  Store,
  insertRun,
  insertStep,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool/collector";
import type { Run, Step } from "@spool/shared";
import { buildApp } from "../web.ts";
import { LiveController } from "../live.ts";
import type { LiveEvent } from "../live.ts";

const PORT = Number(process.env.SPOOL_E2E_PORT ?? "4318");
const HOST = "127.0.0.1";

async function main() {
  const home = mkdtempSync(join(tmpdir(), "spool-e2e-"));
  process.env.SPOOL_HOME = home;

  const store = Store.open({ path: join(home, "spool.db") });
  const project = upsertProjectByCwd(store, "/tmp/e2e-pretty", "e2e-pretty");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;

  // Decision blob — a realistic JSON shape so pretty mode has structure
  // to lay out (thinking + plan + next_tool fields).
  const decisionJson = JSON.stringify(
    {
      thinking:
        "I should start by reading inspect.ts to understand the current\nlayout.\nMultiple lines so the ┃-block renderer fires.",
      plan: ["read inspect.ts", "design pretty-print", "wire CLI flag"],
      next_tool: { kind: "tool_call", tool_name: "Read" },
    },
    null,
    2,
  );
  const decisionRef = await store.blobs.putString(decisionJson);

  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    title: "pretty-print e2e fixture",
    status: "in_progress",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  };
  insertRun(store, run);

  function buildStep(seq: number): Step {
    // Deterministic step IDs let the spec pre-seed a localStorage entry
    // for the step that *will* be appended via /__test__/append-step,
    // which is how the live-append-honors-localStorage test asserts the
    // restorePrettyForCard wiring fires post-mount.
    return {
      step_id: `stp-e2e-${seq}`,
      run_id: runId,
      sequence: seq,
      timestamp: new Date(Date.now() + seq * 1000).toISOString(),
      model: "claude-opus-4-7",
      context_snapshot_id: "snap_x",
      decision_ref: decisionRef,
      action: {
        kind: "tool_call",
        tool_name: "Edit",
        tool_use_id: `tu_${seq}`,
        tool_input: {
          file_path: `packages/cli/src/seq${seq}.ts`,
          old_string: "function before() {}",
          new_string: "function after() {}",
        },
      },
      outcome: {
        status: "ok",
        summary: `step ${seq} done`,
      },
      tokens: { input: 100 + seq, output: 50 + seq, cached_read: 0, cache_creation: 0 },
      latency_ms: 100 + seq * 10,
      cost_cents: 1 + seq,
      tags: [],
      status: "ok",
    };
  }

  // Seed 2 steps. The third arrives later via the test-only endpoint.
  insertStep(store, buildStep(0));
  insertStep(store, buildStep(1));

  // ── Server wiring (mirrors serveApp, plus one test route) ────────────
  const controller = new LiveController(store);
  const app = buildApp(store, { controller });

  app.post("/__test__/append-step", async (c) => {
    const seq = 2;
    const step = buildStep(seq);
    insertStep(store, step);
    // Hand-fire the SSE event the way LiveInspector would. We reach into
    // the controller's private subscriber set — TypeScript-private is
    // runtime-public, and this is the test bootstrap (not production).
    const subs = (
      controller as unknown as { subscribers: Set<(e: LiveEvent) => void> }
    ).subscribers;
    const event: LiveEvent = {
      type: "run:updated",
      run: { ...run, step_count: seq + 1 },
      new_steps: [step],
    };
    for (const fn of subs) fn(event);
    return c.json({ ok: true, seq });
  });

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });

  // Write the fixture metadata for the spec to load.
  const fixturePath = join(
    fileURLToPath(new URL("./", import.meta.url)),
    "fixture.json",
  );
  writeFileSync(
    fixturePath,
    JSON.stringify({ port: PORT, host: HOST, runId, home }, null, 2),
  );
  // Stdout marker that webServer's `url` check can match. Hono/Node will
  // already be accepting connections by the time serve() returns.
  process.stdout.write(`E2E_READY http://${HOST}:${PORT} run=${runId}\n`);

  const shutdown = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("e2e bootstrap failed:", err);
  process.exit(1);
});
