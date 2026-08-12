import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, insertRun, listRuns, listSteps } from "@meterbility/collector";
import type { Run } from "@meterbility/shared";
import { ADMIN_SEQUENCE_BASE, pullCursorUsage } from "./admin_api.ts";

function freshHome(): void {
  process.env.METERBILITY_HOME = mkdtempSync(join(tmpdir(), "meter-cursor-admin-"));
}

function cursorRun(store: Store, composerId: string): Run {
  const run: Run = {
    run_id: `run_${composerId}`,
    agent_id: "agt_test",
    project_id: "prj_test",
    source_session_id: composerId,
    source_runtime: "cursor",
    title: "test",
    status: "ok",
    started_at: new Date().toISOString(),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 0,
    tags: ["cost:approx", "cursor"],
  };
  // Satisfy FKs the minimal way.
  store.db
    .prepare("INSERT OR IGNORE INTO projects(project_id, name, cwd, created_at) VALUES (?,?,?,?)")
    .run("prj_test", "t", "/tmp/t-" + composerId, new Date().toISOString());
  store.db
    .prepare("INSERT OR IGNORE INTO agents(agent_id, project_id, name, created_at) VALUES (?,?,?,?)")
    .run("agt_test", "prj_test", "cursor", new Date().toISOString());
  insertRun(store, run);
  return run;
}

function stubFetch(
  pages: Array<Record<string, unknown>>,
  capture?: Array<{ url: string; body: Record<string, unknown> }>,
): typeof fetch {
  let call = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    capture?.push({ url: String(url), body });
    const page = pages[Math.min(call, pages.length - 1)]!;
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => page,
    } as Response;
  }) as typeof fetch;
}

const EVENT = {
  timestamp: "1754350000000",
  userEmail: "dev@example.com",
  conversationId: "comp-a",
  model: "claude-sonnet-4.6",
  kind: "composer",
  isTokenBasedCall: true,
  chargedCents: 0,
  tokenUsage: {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
    totalCents: 4.2,
  },
};

test("no API key configured → no_api_key status, nothing written", async () => {
  freshHome();
  const store = Store.open();
  const r = await pullCursorUsage(store, { fetchImpl: stubFetch([]) });
  assert.equal(r.status, "no_api_key");
  assert.equal(listRuns(store).length, 0);
  store.close();
});

test("events join runs on conversationId: admin steps with token value + cache splits", async () => {
  freshHome();
  const store = Store.open();
  const run = cursorRun(store, "comp-a");

  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    fetchImpl: stubFetch([
      {
        usageEvents: [
          EVENT,
          { ...EVENT, conversationId: "comp-not-ingested" },
          { conversationId: "comp-a", kind: "tab", isTokenBasedCall: false },
        ],
      },
    ]),
  });

  assert.equal(r.status, "ok");
  assert.equal(r.events_seen, 3);
  assert.equal(r.events_applied, 1);
  assert.equal(r.events_unmatched, 1);
  assert.equal(r.events_skipped, 1);
  assert.equal(r.events_duplicate, 0);
  assert.equal(r.runs_updated, 1);
  assert.equal(
    r.events_seen,
    r.events_applied + r.events_unmatched + r.events_skipped + r.events_duplicate,
    "counter invariant",
  );

  const steps = listSteps(store, run.run_id);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.ok(s.sequence >= ADMIN_SEQUENCE_BASE && s.sequence < 1_000_000);
  assert.equal(s.model, "claude-sonnet-4.6");
  assert.equal(s.tokens.input, 1000);
  assert.equal(s.tokens.cached_read, 5000);
  assert.equal(s.tokens.cache_creation, 300);
  assert.equal(s.cost_cents, 4.2, "token value (totalCents), not a computed estimate");
  // chargedCents: 0 — subscription-included, so value not actual.
  assert.ok(s.tags.includes("cost:value"));
  assert.ok(!s.tags.includes("cost:actual"));
  assert.ok(s.tags.includes("billing:included"));

  // Run totals recomputed from real data; tag swapped to cost:value.
  const updated = listRuns(store).find((x) => x.run_id === run.run_id)!;
  assert.equal(updated.cost_cents, 4.2);
  assert.ok(updated.tags.includes("cost:value"));
  assert.ok(!updated.tags.includes("cost:actual"));
  assert.ok(!updated.tags.includes("cost:approx"));
  store.close();
});

test("billed events (chargedCents > 0) mark step and run cost:actual", async () => {
  freshHome();
  const store = Store.open();
  const run = cursorRun(store, "comp-a");

  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    fetchImpl: stubFetch([{ usageEvents: [{ ...EVENT, chargedCents: 3 }] }]),
  });
  assert.equal(r.events_applied, 1);

  const steps = listSteps(store, run.run_id);
  assert.equal(steps.length, 1);
  assert.ok(steps[0]!.tags.includes("cost:actual"));
  assert.ok(!steps[0]!.tags.includes("cost:value"));
  assert.ok(!steps[0]!.tags.includes("billing:included"));

  const updated = listRuns(store).find((x) => x.run_id === run.run_id)!;
  assert.ok(updated.tags.includes("cost:actual"));
  assert.ok(!updated.tags.includes("cost:approx"));
  store.close();
});

test("{events: [...]} response key works as a fallback for usageEvents", async () => {
  freshHome();
  const store = Store.open();
  const run = cursorRun(store, "comp-a");
  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    fetchImpl: stubFetch([{ events: [EVENT] }]),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.events_applied, 1);
  assert.equal(listSteps(store, run.run_id).length, 1);
  store.close();
});

test("mid-pagination HTTP error returns http_error with the applied count so far", async () => {
  freshHome();
  const store = Store.open();
  cursorRun(store, "comp-a");
  let call = 0;
  const flakyFetch = (async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ usageEvents: [EVENT] }),
      } as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as Response;
  }) as typeof fetch;
  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    pageSize: 1,
    fetchImpl: flakyFetch,
  });
  assert.equal(r.status, "http_error");
  assert.equal(r.events_applied, 1);
  assert.match(r.reason ?? "", /500 on page 2/);
  store.close();
});

test("garbage timestamp still produces a valid ISO timestamp on the step", async () => {
  freshHome();
  const store = Store.open();
  const run = cursorRun(store, "comp-a");
  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    fetchImpl: stubFetch([
      { usageEvents: [{ ...EVENT, timestamp: "garbage" }] },
    ]),
  });
  assert.equal(r.events_applied, 1);
  const steps = listSteps(store, run.run_id);
  assert.equal(steps.length, 1);
  assert.ok(
    !Number.isNaN(new Date(steps[0]!.timestamp).getTime()),
    "timestamp parses as a real date",
  );
  store.close();
});

test("insecure http base URL is refused before any network call", async () => {
  freshHome();
  const store = Store.open();
  let called = false;
  const spyFetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    baseUrl: "http://evil.example.com",
    fetchImpl: spyFetch,
  });
  assert.equal(r.status, "http_error");
  assert.match(r.reason ?? "", /https required/);
  assert.equal(called, false, "no request was sent");

  // Loopback http is fine (test gateways).
  const r2 = await pullCursorUsage(store, {
    apiKey: "key_test",
    baseUrl: "http://127.0.0.1:9999",
    fetchImpl: stubFetch([{ usageEvents: [] }]),
  });
  assert.equal(r2.status, "ok");
  store.close();
});

test("re-pulling an overlapping window is a no-op (deduped on event identity)", async () => {
  freshHome();
  const store = Store.open();
  const run = cursorRun(store, "comp-a");
  const opts = {
    apiKey: "key_test",
    fetchImpl: stubFetch([{ usageEvents: [EVENT] }]),
  };
  await pullCursorUsage(store, opts);
  const r2 = await pullCursorUsage(store, {
    apiKey: "key_test",
    fetchImpl: stubFetch([{ usageEvents: [EVENT] }]),
  });
  assert.equal(r2.events_applied, 0, "duplicate event not re-applied");
  assert.equal(r2.events_duplicate, 1, "duplicate counter populated on re-pull");
  assert.equal(
    r2.events_seen,
    r2.events_applied + r2.events_unmatched + r2.events_skipped + r2.events_duplicate,
    "counter invariant",
  );
  assert.equal(listSteps(store, run.run_id).length, 1);
  store.close();
});

test("pagination: full pages advance until a short page arrives", async () => {
  freshHome();
  const store = Store.open();
  cursorRun(store, "comp-a");
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const ev2 = { ...EVENT, timestamp: "1754350099000" };
  const r = await pullCursorUsage(store, {
    apiKey: "key_test",
    pageSize: 1,
    fetchImpl: stubFetch(
      [{ usageEvents: [EVENT] }, { usageEvents: [ev2] }, { usageEvents: [] }],
      captured,
    ),
  });
  assert.equal(r.events_applied, 2);
  assert.equal(captured.length, 3);
  assert.equal(captured[0]!.body.page, 1);
  assert.equal(captured[1]!.body.page, 2);
  assert.ok(String(captured[0]!.url).endsWith("/teams/filtered-usage-events"));
  store.close();
});

test("HTTP error surfaces as http_error with partial counts", async () => {
  freshHome();
  const store = Store.open();
  const failFetch = (async () =>
    ({ ok: false, status: 401, json: async () => ({}) }) as Response) as typeof fetch;
  const r = await pullCursorUsage(store, { apiKey: "bad", fetchImpl: failFetch });
  assert.equal(r.status, "http_error");
  assert.match(r.reason ?? "", /401/);
  store.close();
});

test("admin steps survive DB-ingest reconciliation (above the hook range)", async () => {
  freshHome();
  const store = Store.open();
  const Database = (await import("better-sqlite3")).default;

  // Seed the composer db FIRST so the run comes from the DB adapter.
  const dir = mkdtempSync(join(tmpdir(), "cursor-admin-mixed-"));
  const dbPath = join(dir, "state.vscdb");
  const cdb = new Database(dbPath);
  cdb.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const ins = cdb.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  ins.run(
    "composerData:comp-a",
    JSON.stringify({
      _v: 10,
      composerId: "comp-a",
      name: "admin mixed",
      status: "completed",
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }],
      text: "admin mixed",
      unifiedMode: "agent",
    }),
  );
  ins.run(
    "bubbleId:comp-a:u1",
    JSON.stringify({ _v: 3, bubbleId: "u1", type: 1, text: "hi", createdAt: new Date().toISOString() }),
  );
  cdb.close();

  const { ingestCursorGlobal } = await import("./ingest.ts");
  await ingestCursorGlobal(store, { dbPath });
  await pullCursorUsage(store, {
    apiKey: "key_test",
    fetchImpl: stubFetch([{ usageEvents: [EVENT] }]),
  });
  await ingestCursorGlobal(store, { dbPath }); // reconcile pass

  const runs = listRuns(store);
  assert.equal(runs.length, 1);
  const steps = listSteps(store, runs[0]!.run_id);
  assert.equal(
    steps.filter((s) => s.sequence >= ADMIN_SEQUENCE_BASE).length,
    1,
    "admin step survived reconciliation",
  );
  assert.equal(steps.filter((s) => s.sequence < 100_000).length, 1);
  store.close();
});
