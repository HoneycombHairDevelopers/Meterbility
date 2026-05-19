import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertFileChange,
  insertRun,
  insertStep,
  upsertAgent,
  upsertProjectByCwd,
} from "@spool/collector";
import type { Run, Step } from "@spool/shared";
import { buildApp } from "./web.ts";

/**
 * v0.3 Turn 7 — web surface tests.
 *
 * Four areas covered:
 *   1. Live control endpoints (start / stop / status idempotency).
 *   2. File-change JSON APIs (per-run, per-step, per-path, per-row).
 *   3. The step-card HTML fragment endpoint — verifies it returns
 *      both the card and the timeline cell so the live-append JS
 *      has something to walk.
 *   4. Smoke for the run-detail page — confirms the data-runId
 *      stamp + steps-anchor + live-toggle markup all land so the
 *      browser-side wiring has anchors to bind to.
 *
 * No real LiveInspector start (it'd touch ~/.claude/projects). We
 * test the controller's idempotency surface and the route plumbing.
 */

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-web-v03-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

/** Build a project + agent + run + N steps so the routes have data. */
function scaffold(store: Store, stepCount: number) {
  const project = upsertProjectByCwd(store, "/tmp/web-v03", "web-v03");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    title: "web turn 7 fixture",
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
  return { runId, stepIds };
}

// ─── 1) Live control endpoints ───────────────────────────────────────

test("GET /api/live/status reports the controller's current state (false by default)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const app = buildApp(store);
    const res = await app.fetch(new Request("http://x/api/live/status"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { live: boolean };
    assert.equal(body.live, false);
  } finally {
    store.close();
  }
});

test("POST /api/live/stop is a no-op when not running (idempotent)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const app = buildApp(store);
    const res = await app.fetch(
      new Request("http://x/api/live/stop", { method: "POST" }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { live: boolean };
    assert.equal(body.live, false);
  } finally {
    store.close();
  }
});

test("POST /api/live/start without a body is accepted (empty body fine)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const app = buildApp(store);
    const res = await app.fetch(
      new Request("http://x/api/live/start", { method: "POST" }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { live: boolean };
    // Could be true or false depending on whether ~/.claude/projects
    // exists on the test machine; either way the route shouldn't 5xx.
    assert.equal(typeof body.live, "boolean");
    // Stop right away so subsequent tests don't see a running inspector.
    await app.fetch(new Request("http://x/api/live/stop", { method: "POST" }));
  } finally {
    store.close();
  }
});

// ─── 2) File-change JSON APIs ────────────────────────────────────────

test("GET /api/runs/:id/files returns rows ordered by (step.seq, fc.seq)", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId, stepIds } = scaffold(store, 2);
    insertFileChange(store, {
      run_id: runId, step_id: stepIds[1]!, sequence: 0,
      derived_from: "tool_call", path: "z.ts", op: "modify",
      before_blob_ref: "blob_z_v0", after_blob_ref: "blob_z_v1",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 1, lines_removed: 0, redacted: false,
    });
    insertFileChange(store, {
      run_id: runId, step_id: stepIds[0]!, sequence: 0,
      derived_from: "tool_call", path: "a.ts", op: "create",
      after_blob_ref: "blob_a",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 10, lines_removed: 0, redacted: false,
    });
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/${runId}/files`),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ path: string; op: string }>;
    assert.equal(body.length, 2);
    // step 0 first (sequence 0 < 1) regardless of insertion order.
    assert.equal(body[0]!.path, "a.ts");
    assert.equal(body[1]!.path, "z.ts");
  } finally {
    store.close();
  }
});

test("GET /api/runs/:id/files/diff?path=... filters and 400s without ?path=", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId, stepIds } = scaffold(store, 1);
    insertFileChange(store, {
      run_id: runId, step_id: stepIds[0]!, sequence: 0,
      derived_from: "tool_call", path: "src/auth.ts", op: "modify",
      before_blob_ref: "blob_auth_v0", after_blob_ref: "blob_auth_v1",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 1, lines_removed: 1, redacted: false,
    });
    const app = buildApp(store);
    // Missing path → 400
    const bad = await app.fetch(
      new Request(`http://x/api/runs/${runId}/files/diff`),
    );
    assert.equal(bad.status, 400);
    // With path → array
    const ok = await app.fetch(
      new Request(`http://x/api/runs/${runId}/files/diff?path=src/auth.ts`),
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Array<{ path: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]!.path, "src/auth.ts");
  } finally {
    store.close();
  }
});

test("GET /api/steps/:id/file_changes returns rows for one step", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId, stepIds } = scaffold(store, 2);
    insertFileChange(store, {
      run_id: runId, step_id: stepIds[0]!, sequence: 0,
      derived_from: "tool_call", path: "a.ts", op: "create",
      after_blob_ref: "blob_a",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 1, lines_removed: 0, redacted: false,
    });
    insertFileChange(store, {
      run_id: runId, step_id: stepIds[1]!, sequence: 0,
      derived_from: "tool_call", path: "b.ts", op: "create",
      after_blob_ref: "blob_b",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 1, lines_removed: 0, redacted: false,
    });
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/steps/${stepIds[0]!}/file_changes`),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ path: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]!.path, "a.ts");
  } finally {
    store.close();
  }
});

test("GET /api/file_change/:id returns one row and 404s on unknown", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId, stepIds } = scaffold(store, 1);
    const fc = insertFileChange(store, {
      run_id: runId, step_id: stepIds[0]!, sequence: 0,
      derived_from: "tool_call", path: "x.ts", op: "modify",
      before_blob_ref: "blob_x_v0", after_blob_ref: "blob_x_v1",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 5, lines_removed: 2, redacted: false,
    });
    const app = buildApp(store);
    const ok = await app.fetch(
      new Request(`http://x/api/file_change/${fc.file_change_id}`),
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { path: string; lines_added: number };
    assert.equal(body.path, "x.ts");
    assert.equal(body.lines_added, 5);

    const miss = await app.fetch(
      new Request("http://x/api/file_change/fc_does_not_exist"),
    );
    assert.equal(miss.status, 404);
  } finally {
    store.close();
  }
});

// ─── 3) Step-card fragment endpoint ──────────────────────────────────

test("GET /api/runs/:id/step-card/:seq returns HTML with the card + a timeline block", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId } = scaffold(store, 3);
    const app = buildApp(store);
    const res = await app.fetch(
      new Request(`http://x/api/runs/${runId}/step-card/1`),
    );
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") ?? "",
      /text\/html/,
    );
    const html = await res.text();
    // The fragment wrapper exists.
    assert.match(html, /data-step-fragment/);
    // The step card has the right sequence id.
    assert.match(html, /id="step-1"/);
    // The detached timeline cell is included so the client can hoist it.
    assert.match(html, /data-timeline-blk/);
  } finally {
    store.close();
  }
});

test("step-card fragment 400s on bad seq, 404s on missing", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId } = scaffold(store, 1);
    const app = buildApp(store);
    const bad = await app.fetch(
      new Request(`http://x/api/runs/${runId}/step-card/not-a-number`),
    );
    assert.equal(bad.status, 400);
    const miss = await app.fetch(
      new Request(`http://x/api/runs/${runId}/step-card/99`),
    );
    assert.equal(miss.status, 404);
  } finally {
    store.close();
  }
});

// ─── 4) Run detail page wiring smoke ─────────────────────────────────

test("/runs/:id stamps data-run-id, exposes #steps-anchor, and renders the Live toggle", async () => {
  freshStore();
  const store = Store.open();
  try {
    const { runId } = scaffold(store, 1);
    // Add one FileChange so the Files tab + run-level "Files changed"
    // section both render — gives us a more complete check of the
    // wiring than the bare run page.
    const { listSteps } = await import("@spool/collector");
    const step = listSteps(store, runId)[0]!;
    insertFileChange(store, {
      run_id: runId, step_id: step.step_id, sequence: 0,
      derived_from: "tool_call", path: "src/x.ts", op: "modify",
      before_blob_ref: "blob_x_v0", after_blob_ref: "blob_x_v1",
      partial_diff: false, gitignored: false, bom: false,
      lines_added: 3, lines_removed: 1, redacted: false,
      patch_text: "@@ -1 +1 @@\n-old\n+new\n",
      patch_format: "unified",
      source_tool_name: "Edit",
    });
    const app = buildApp(store);
    const res = await app.fetch(new Request(`http://x/runs/${runId}`));
    assert.equal(res.status, 200);
    const html = await res.text();
    // Live toggle in the header.
    assert.match(html, /id="live-toggle"/);
    assert.match(html, /toggleLive/);
    // Run-id stamp script.
    assert.match(html, new RegExp(`m.dataset.runId = "${runId}"`));
    // Steps-anchor wrapper for the live appender.
    assert.match(html, /id="steps-anchor"/);
    // Files tab tab-button on the step card.
    assert.match(html, /data-tab="files"/);
    // Run-level Files summary section.
    assert.match(html, /Files changed in this run/);
    // The op badge for our captured modify hits the right color class.
    assert.match(html, /file-op-modify/);
    // Live SSE wiring functions are present (so the page can react
    // when the user flips the toggle).
    assert.match(html, /initLiveRunUpdates/);
    assert.match(html, /spool:live-state/);
  } finally {
    store.close();
  }
});

test("/runs/:id renders without a Files tab when no FileChanges exist", async () => {
  // Read-only steps (Read/Glob/Grep) should not get a Files tab — keep
  // the tab bar quiet. This pins that contract. We match on the
  // actual rendered DOM (button attribute + element class) rather
  // than substring-searching for prose, because the inline CSS block
  // contains "Files changed in this run" as a section comment that
  // would always match.
  freshStore();
  const store = Store.open();
  try {
    const { runId } = scaffold(store, 1);
    const app = buildApp(store);
    const res = await app.fetch(new Request(`http://x/runs/${runId}`));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.includes('data-tab="files"'), false);
    // The run-level summary lives in a <details class="run-files-summary">;
    // when no files are captured, the renderer returns an empty string and
    // that class never makes it into the HTML.
    assert.equal(html.includes('class="run-files-summary"'), false);
  } finally {
    store.close();
  }
});
