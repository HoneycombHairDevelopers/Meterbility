import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertRun,
  upsertAgent,
  upsertProjectByCwd,
  getRun,
} from "@spool/collector";
import type { Run } from "@spool/shared";
import { buildApp } from "./web.ts";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-close-"));
  process.env.SPOOL_HOME = dir;
  return dir;
}

function makeRun(
  store: Store,
  status: Run["status"] = "in_progress",
  runtime: Run["source_runtime"] = "proxy",
  startedAt: string = new Date().toISOString(),
): string {
  const project = upsertProjectByCwd(store, "/tmp/close-test", "close-test");
  const agent = upsertAgent(store, project.project_id, "tester");
  const run_id = `run_${randomUUID()}`;
  insertRun(store, {
    run_id,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: runtime,
    title: "test run",
    status,
    started_at: startedAt,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  } as Run);
  return run_id;
}

test("POST /api/runs/:id/close seals an in_progress run as ok by default", async () => {
  fresh();
  const store = Store.open();
  try {
    const run_id = makeRun(store, "in_progress");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/${run_id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Run;
    assert.equal(body.status, "ok");
    assert.ok(body.ended_at);
    const reread = getRun(store, run_id);
    assert.equal(reread!.status, "ok");
    assert.ok(reread!.ended_at);
  } finally {
    store.close();
  }
});

test("POST /api/runs/:id/close honors explicit status", async () => {
  fresh();
  const store = Store.open();
  try {
    const run_id = makeRun(store, "in_progress");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/${run_id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "abandoned" }),
      }),
    );
    assert.equal(res.status, 200);
    const reread = getRun(store, run_id);
    assert.equal(reread!.status, "abandoned");
  } finally {
    store.close();
  }
});

test("POST /api/runs/:id/close rejects invalid status", async () => {
  fresh();
  const store = Store.open();
  try {
    const run_id = makeRun(store, "in_progress");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/${run_id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "bogus" }),
      }),
    );
    assert.equal(res.status, 400);
  } finally {
    store.close();
  }
});

test("POST /api/runs/:id/close 404s for unknown run", async () => {
  fresh();
  const store = Store.open();
  try {
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/run_does_not_exist/close`, {
        method: "POST",
      }),
    );
    assert.equal(res.status, 404);
  } finally {
    store.close();
  }
});

test("POST /api/runs/close-stale only closes runs older than the window", async () => {
  fresh();
  const store = Store.open();
  try {
    const oldRun = makeRun(
      store,
      "in_progress",
      "proxy",
      new Date(Date.now() - 90 * 60_000).toISOString(),
    );
    const recentRun = makeRun(
      store,
      "in_progress",
      "proxy",
      new Date().toISOString(),
    );
    const okRun = makeRun(store, "ok", "proxy");

    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/close-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ older_than_minutes: 60 }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { closed: number; run_ids: string[] };
    assert.equal(body.closed, 1);
    assert.deepEqual(body.run_ids, [oldRun]);
    assert.equal(getRun(store, oldRun)!.status, "ok");
    assert.equal(getRun(store, recentRun)!.status, "in_progress");
    assert.equal(getRun(store, okRun)!.status, "ok"); // untouched
  } finally {
    store.close();
  }
});

test("POST /api/runs/close-stale source filter scopes to one runtime", async () => {
  fresh();
  const store = Store.open();
  try {
    const oldStart = new Date(Date.now() - 90 * 60_000).toISOString();
    const proxyRun = makeRun(store, "in_progress", "proxy", oldStart);
    const sdkRun = makeRun(store, "in_progress", "sdk-py", oldStart);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/close-stale`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ older_than_minutes: 60, source: "proxy" }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { closed: number; run_ids: string[] };
    assert.equal(body.closed, 1);
    assert.equal(body.run_ids[0], proxyRun);
    assert.equal(getRun(store, sdkRun)!.status, "in_progress");
  } finally {
    store.close();
  }
});
