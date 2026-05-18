import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertRun,
  setRunStatus,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool/collector";
import {
  probeFilePath,
  readState,
  requestPause,
  setInject,
} from "@spool/shared";
import type { Run } from "@spool/shared";
import { buildApp } from "./web.ts";

/**
 * Probe web panel tests — Turn 8 chunk 5.
 *
 * Strategy: spin up a real Hono app over a real Store, drive it
 * through `app.fetch(new Request(...))` so the test exercises route
 * registration, body parsing, and probe-protocol integration end-to-
 * end. Each test gets a fresh SPOOL_HOME tempdir.
 */

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-probe-web-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

function scaffold(
  store: Store,
  status: Run["status"] = "in_progress",
): string {
  const project = upsertProjectByCwd(store, "/tmp/probe-web", "probe-web");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "sdk-ts",
    title: "probe panel fixture",
    status,
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: [],
  };
  insertRun(store, run);
  return runId;
}

// ─── GET /api/probe/:run_id ──────────────────────────────────────────

test("GET /api/probe/:run_id returns the default running record when no file exists", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    const app = buildApp(store);
    const res = await app.fetch(new Request(`http://x/api/probe/${runId}`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { state: string; inject: string | null };
    assert.equal(body.state, "running");
    assert.equal(body.inject, null);
  } finally {
    store.close();
  }
});

test("GET /api/probe/:run_id 404s on unknown run id", async () => {
  freshStore();
  const store = Store.open();
  try {
    const app = buildApp(store);
    const res = await app.fetch(new Request("http://x/api/probe/run_nope"));
    assert.equal(res.status, 404);
  } finally {
    store.close();
  }
});

// ─── POST /api/probe/:run_id/pause + resume ──────────────────────────

test("POST /api/probe/:run_id/pause writes pause_requested state", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/pause`, { method: "POST" }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { state: string; requested_at_ms: number };
    assert.equal(body.state, "pause_requested");
    assert.ok(body.requested_at_ms > 0);
    // Persisted on disk where the SDK can see it:
    assert.equal(readState(runId).state, "pause_requested");
  } finally {
    store.close();
  }
});

test("POST /api/probe/:run_id/resume transitions back to running, preserves inject", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    requestPause(runId);
    setInject(runId, "carry forward");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/resume`, { method: "POST" }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { state: string; inject: string | null };
    assert.equal(body.state, "running");
    assert.equal(body.inject, "carry forward", "resume must preserve pending inject");
  } finally {
    store.close();
  }
});

// ─── POST /api/probe/:run_id/inject ──────────────────────────────────

test("POST /api/probe/:run_id/inject queues a message", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "remember the stale fixture" }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { inject: string | null };
    assert.equal(body.inject, "remember the stale fixture");
  } finally {
    store.close();
  }
});

test("POST inject refuses to clobber a pending inject without { force: true }", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    setInject(runId, "earlier message");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "newer" }),
      }),
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; current_inject: string };
    assert.match(body.error, /already queued/);
    assert.equal(body.current_inject, "earlier message");
    // Inject preserved:
    assert.equal(readState(runId).inject, "earlier message");
  } finally {
    store.close();
  }
});

test("POST inject with { force: true } overwrites the pending message", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    setInject(runId, "earlier");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "newer", force: true }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(readState(runId).inject, "newer");
  } finally {
    store.close();
  }
});

test("POST inject with { clear: true } discards the pending inject (operator UI 'Discard' button)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    requestPause(runId);
    setInject(runId, "to be discarded");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      }),
    );
    assert.equal(res.status, 200);
    const state = readState(runId);
    assert.equal(state.inject, null, "discard must null the inject field");
    assert.equal(
      state.state,
      "pause_requested",
      "discard must NOT change the pause state",
    );
  } finally {
    store.close();
  }
});

test("POST inject rejects an empty message (without { clear: true })", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      }),
    );
    assert.equal(res.status, 400);
  } finally {
    store.close();
  }
});

// ─── POST /api/probe/:run_id/clear ───────────────────────────────────

test("POST /api/probe/:run_id/clear removes the probe file", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    requestPause(runId);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/clear`, { method: "POST" }),
    );
    assert.equal(res.status, 200);
    // File removed:
    assert.equal(readState(runId).state, "running", "post-clear reads default");
  } finally {
    store.close();
  }
});

test("POST /api/probe/:run_id/clear succeeds even for an unknown run (stale recovery)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const orphan = "run_definitely-not-a-real-run";
    setInject(orphan, "orphaned");
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${orphan}/clear`, { method: "POST" }),
    );
    assert.equal(res.status, 200, "clear must work for orphaned probe files");
  } finally {
    store.close();
  }
});

// ─── GET /api/probe/:run_id/panel ────────────────────────────────────

test("GET /api/probe/:run_id/panel returns HTML reflecting current state", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    requestPause(runId);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/panel`),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /data-probe-panel="1"/);
    assert.match(html, /pause requested/i);
    // Resume button is visible when not running.
    assert.match(html, /probe-resume-btn/);
  } finally {
    store.close();
  }
});

test("GET /api/probe/:run_id/panel 404s when run is sealed (no polling against dead runs)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    setRunStatus(store, runId, "ok", new Date().toISOString());
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/panel`),
    );
    assert.equal(res.status, 404);
  } finally {
    store.close();
  }
});

// ─── Probe panel integration with /runs/:id ──────────────────────────

test("/runs/:id renders the probe panel for an in_progress run", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    const app = buildApp(store);
    const res = await app.fetch(new Request(`http://x/runs/${runId}`));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-probe-panel="1"/);
    assert.match(html, /Live Probe/);
  } finally {
    store.close();
  }
});

test("/runs/:id does NOT render the probe panel for a sealed run", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store, "ok");
    const app = buildApp(store);
    const res = await app.fetch(new Request(`http://x/runs/${runId}`));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /data-probe-panel="1"/, "sealed run should not get probe panel");
  } finally {
    store.close();
  }
});

// ─── Full operator round-trip via the web API ────────────────────────

test("operator round-trip via /api/probe: pause → inject → resume → state", async () => {
  freshStore();
  const store = Store.open();
  try {
    const runId = scaffold(store);
    const app = buildApp(store);

    // pause
    let res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/pause`, { method: "POST" }),
    );
    assert.equal(res.status, 200);

    // inject
    res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "do this" }),
      }),
    );
    assert.equal(res.status, 200);

    // resume
    res = await app.fetch(
      new Request(`http://x/api/probe/${runId}/resume`, { method: "POST" }),
    );
    assert.equal(res.status, 200);

    // final state
    res = await app.fetch(new Request(`http://x/api/probe/${runId}`));
    const final = (await res.json()) as {
      state: string;
      inject: string | null;
    };
    assert.equal(final.state, "running");
    assert.equal(final.inject, "do this", "inject queued through full operator cycle");

    // File on disk matches:
    const onDisk = readState(runId);
    assert.equal(onDisk.state, "running");
    assert.equal(onDisk.inject, "do this");

    // Probe file path consistent:
    const path = probeFilePath(runId);
    assert.match(path, /\/probe\//);
  } finally {
    store.close();
  }
});
