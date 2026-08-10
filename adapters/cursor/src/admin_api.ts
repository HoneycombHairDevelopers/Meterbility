import type { Run, Step } from "@meterbility/shared";
import { hashJson } from "@meterbility/shared";
import {
  getRunBySessionId,
  getSetting,
  insertStep,
  recordContextSnapshot,
  updateRunTotals,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";

/**
 * Cursor Admin API usage puller (Teams/Business plans) — the third
 * Cursor capture channel, and the only source of REAL cost data:
 * Cursor's local DB never persists usage (usageData is {} in every
 * row), but `POST /teams/filtered-usage-events` returns per-request
 * events with model, a full token breakdown (input / output /
 * cacheRead / cacheWrite), billed cents, the user's email — and
 * `conversationId`, which is the composerId, joining server-side usage
 * to locally-ingested runs.
 *
 * Each usage event becomes one step in the reserved admin sequence
 * range [ADMIN_SEQUENCE_BASE, SEQUENCE_REBUILD_OFFSET) — above the
 * bubble walk and the hook plane, below the rebuild offset — so the DB
 * adapter's bounded reconciliation never touches them (same contract
 * as HOOK_SEQUENCE_BASE; see ingest.ts). Steps carry billed cents from
 * the API (`cost:actual`), not computed estimates, and run totals
 * recompute to real dollars via updateRunTotals.
 *
 * Auth: Basic with the team-scoped API key as username (per Cursor's
 * Admin API docs). Rate limit is 60 req/min/team; the puller pages
 * sequentially and never retries a 4xx.
 */

export const ADMIN_SEQUENCE_BASE = 200_000;

export interface CursorUsageEvent {
  timestamp?: string | number;
  userEmail?: string;
  conversationId?: string;
  model?: string;
  kind?: string;
  maxMode?: boolean;
  isTokenBasedCall?: boolean;
  isChargeable?: boolean;
  chargedCents?: number;
  requestsCosts?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalCents?: number;
  };
  [k: string]: unknown;
}

export interface PullCursorUsageOptions {
  /** Epoch ms window start (default: 7 days ago). */
  startDateMs?: number;
  /** Epoch ms window end (default: now). */
  endDateMs?: number;
  /** Page size per request (default 100). */
  pageSize?: number;
  /** Base URL override (tests / gateways); else setting or prod default. */
  baseUrl?: string;
  /** API key override; else the cursor.admin_api_key setting. */
  apiKey?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface PullCursorUsageResult {
  status: "ok" | "no_api_key" | "http_error";
  events_seen: number;
  events_applied: number;
  /** Events whose conversationId matched no local run. */
  events_unmatched: number;
  /** Events skipped as non-token/no-usage (kind-only rows). */
  events_skipped: number;
  runs_updated: number;
  reason?: string;
}

const PROD_BASE = "https://api.cursor.com";

export async function pullCursorUsage(
  store: Store,
  opts: PullCursorUsageOptions = {},
): Promise<PullCursorUsageResult> {
  const apiKey = opts.apiKey ?? getSetting(store, "cursor.admin_api_key");
  if (!apiKey) {
    return {
      status: "no_api_key",
      events_seen: 0,
      events_applied: 0,
      events_unmatched: 0,
      events_skipped: 0,
      runs_updated: 0,
      reason:
        "no Cursor Admin API key — set it with: meter config set cursor.admin_api_key <key>",
    };
  }
  const base = (
    opts.baseUrl ??
    getSetting(store, "cursor.admin_api_base") ??
    PROD_BASE
  ).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endDate = opts.endDateMs ?? Date.now();
  const startDate = opts.startDateMs ?? endDate - 7 * 24 * 60 * 60 * 1000;
  const pageSize = opts.pageSize ?? 100;

  let page = 1;
  let seen = 0;
  let applied = 0;
  let unmatched = 0;
  let skipped = 0;
  const updatedRuns = new Set<string>();

  for (;;) {
    const res = await fetchImpl(`${base}/teams/filtered-usage-events`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ startDate, endDate, page, pageSize }),
    });
    if (!res.ok) {
      return {
        status: "http_error",
        events_seen: seen,
        events_applied: applied,
        events_unmatched: unmatched,
        events_skipped: skipped,
        runs_updated: updatedRuns.size,
        reason: `Admin API ${res.status} on page ${page}`,
      };
    }
    const body = (await res.json()) as {
      usageEvents?: CursorUsageEvent[];
      events?: CursorUsageEvent[];
    };
    const events = body.usageEvents ?? body.events ?? [];
    seen += events.length;

    for (const ev of events) {
      const outcome = await applyUsageEvent(store, ev);
      if (outcome === "applied") {
        applied += 1;
      } else if (outcome === "unmatched") {
        unmatched += 1;
      } else if (outcome === "skipped") {
        skipped += 1;
      }
      if (outcome === "applied" && ev.conversationId) {
        const run = getRunBySessionId(store, ev.conversationId);
        if (run) updatedRuns.add(run.run_id);
      }
    }

    if (events.length < pageSize) break;
    page += 1;
  }

  for (const runId of updatedRuns) {
    updateRunTotals(store, runId);
    markRunCostActual(store, runId);
  }

  return {
    status: "ok",
    events_seen: seen,
    events_applied: applied,
    events_unmatched: unmatched,
    events_skipped: skipped,
    runs_updated: updatedRuns.size,
  };
}

type ApplyOutcome = "applied" | "duplicate" | "unmatched" | "skipped";

async function applyUsageEvent(
  store: Store,
  ev: CursorUsageEvent,
): Promise<ApplyOutcome> {
  const conversationId = ev.conversationId;
  const usage = ev.tokenUsage;
  if (!conversationId) return "skipped";
  if (!usage || ev.isTokenBasedCall === false) return "skipped";

  const run: Run | undefined = getRunBySessionId(store, conversationId);
  if (!run) return "unmatched";

  // Stable identity: the API exposes no event id, so hash the fields
  // that uniquely describe one request. Re-pulls of overlapping windows
  // become no-ops.
  const stepId = `stp_${hashJson([
    run.run_id,
    "cursor-admin",
    ev.timestamp ?? null,
    ev.model ?? null,
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  ])}`;
  const exists = store.db
    .prepare(`SELECT 1 FROM steps WHERE step_id = ?`)
    .get(stepId);
  if (exists) return "duplicate";

  const seqRow = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND sequence >= ? AND sequence < 1000000`,
    )
    .get(run.run_id, ADMIN_SEQUENCE_BASE) as { n: number };
  const sequence = ADMIN_SEQUENCE_BASE + seqRow.n;

  const snapshotId = hashJson(["cursor-admin-snapshot", stepId]);
  const snapshotRef = await store.blobs.putJson({ id: snapshotId, components: [] });
  recordContextSnapshot(store, snapshotId, snapshotRef, 0);
  const decisionRef = await store.blobs.putJson({
    source: "cursor-admin-api",
    userEmail: ev.userEmail,
    kind: ev.kind,
    maxMode: ev.maxMode,
    chargedCents: ev.chargedCents,
  });

  // Billed cents come straight from the API: totalCents is the token
  // cost of this call; chargedCents is what was actually billed
  // (0 for subscription-included requests). Record the token cost so
  // the cache lane can reason about waste even when it was "free".
  const costCents = usage.totalCents ?? ev.chargedCents ?? 0;

  const step: Step = {
    step_id: stepId,
    run_id: run.run_id,
    sequence,
    timestamp: normalizeTimestamp(ev.timestamp),
    model: ev.model ?? "cursor-unknown",
    context_snapshot_id: snapshotId,
    decision_ref: decisionRef,
    action: {
      kind: "none",
      text: `[cursor usage] ${ev.kind ?? "request"} by ${ev.userEmail ?? "unknown"}`,
    },
    outcome: { status: "ok" },
    tokens: {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cached_read: usage.cacheReadTokens ?? 0,
      cache_creation: usage.cacheWriteTokens ?? 0,
    },
    latency_ms: 0,
    cost_cents: costCents,
    tags: ["cursor", "cursor-admin", "cost:actual"],
    status: "ok",
  };
  insertStep(store, step);
  return "applied";
}

/** Swap cost:approx → cost:actual on runs backed by billed API data. */
function markRunCostActual(store: Store, runId: string): void {
  const row = store.db
    .prepare(`SELECT tags FROM runs WHERE run_id = ?`)
    .get(runId) as { tags: string } | undefined;
  if (!row) return;
  try {
    const tags = JSON.parse(row.tags) as string[];
    const next = tags.filter((t) => t !== "cost:approx");
    if (!next.includes("cost:actual")) next.push("cost:actual");
    store.db
      .prepare(`UPDATE runs SET tags = ? WHERE run_id = ?`)
      .run(JSON.stringify(next), runId);
  } catch {
    // Malformed tags — leave untouched.
  }
}

function normalizeTimestamp(ts: string | number | undefined): string {
  if (ts === undefined) return new Date().toISOString();
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  return new Date().toISOString();
}
