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
import {
  ADMIN_SEQUENCE_BASE,
  CHECKPOINT_SEQUENCE_BASE,
  nextSequenceInBand,
} from "./bands.ts";

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
 * range [ADMIN_SEQUENCE_BASE, CHECKPOINT_SEQUENCE_BASE) — above the
 * bubble walk and the hook plane, below the rebuild offset — so the DB
 * adapter's bounded reconciliation never touches them (same contract
 * as HOOK_SEQUENCE_BASE; see ingest.ts and bands.ts).
 *
 * Cost semantics (decision D2): cost_cents records the token VALUE of
 * the call (`totalCents`) even when it was subscription-included
 * (`chargedCents` 0) — so the cache lane can reason about waste on
 * "free" requests. The billed/included distinction lives in tags:
 * `cost:actual` when chargedCents > 0, `cost:value` (plus
 * `billing:included` when the value is nonzero) otherwise.
 *
 * Auth: Basic with the team-scoped API key as username (per Cursor's
 * Admin API docs). Rate limit is 60 req/min/team; the puller pages
 * sequentially, retries 429s per Retry-After (max 3 per page), and
 * never retries other 4xx.
 */

// Admin band base — re-exported for back-compat (tests import it from
// this module); the canonical definition lives in bands.ts.
export { ADMIN_SEQUENCE_BASE } from "./bands.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOOKBACK_DAYS = 7;

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

/**
 * Pull result. Invariant: events_seen = events_applied +
 * events_unmatched + events_skipped + events_duplicate — every event
 * the API returned is accounted for in exactly one counter.
 */
export interface PullCursorUsageResult {
  status: "ok" | "no_api_key" | "http_error";
  events_seen: number;
  events_applied: number;
  /** Events whose conversationId matched no local run. */
  events_unmatched: number;
  /** Events skipped as non-token/no-usage (kind-only rows). */
  events_skipped: number;
  /** Events already applied by a prior (overlapping) pull. */
  events_duplicate: number;
  runs_updated: number;
  reason?: string;
}

const PROD_BASE = "https://api.cursor.com";
/** Hard page cap — a stuck/hostile server can't spin the puller forever. */
const MAX_PAGES = 500;
const MAX_429_RETRIES = 3;

export async function pullCursorUsage(
  store: Store,
  opts: PullCursorUsageOptions = {},
): Promise<PullCursorUsageResult> {
  const empty = {
    events_seen: 0,
    events_applied: 0,
    events_unmatched: 0,
    events_skipped: 0,
    events_duplicate: 0,
    runs_updated: 0,
  };
  const apiKey = opts.apiKey ?? getSetting(store, "cursor.admin_api_key");
  if (!apiKey) {
    return {
      status: "no_api_key",
      ...empty,
      reason:
        "no Cursor Admin API key — set it with: meter config set cursor.admin_api_key <key>",
    };
  }
  const base = (
    opts.baseUrl ??
    getSetting(store, "cursor.admin_api_base") ??
    PROD_BASE
  ).replace(/\/+$/, "");
  // The API key rides in an Authorization header — refuse to send it
  // over plaintext HTTP to anything that isn't loopback.
  if (base !== PROD_BASE && !isSecureAdminBase(base)) {
    return {
      status: "http_error",
      ...empty,
      reason: "refusing insecure cursor.admin_api_base (https required)",
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endDate = opts.endDateMs ?? Date.now();
  const startDate = opts.startDateMs ?? endDate - DEFAULT_LOOKBACK_DAYS * DAY_MS;
  const pageSize = opts.pageSize ?? 100;

  let page = 1;
  let seen = 0;
  let applied = 0;
  let unmatched = 0;
  let skipped = 0;
  let duplicate = 0;
  /** run_id → whether ANY applied event for that run was actually billed. */
  const updatedRuns = new Map<string, boolean>();
  let capReason: string | undefined;

  const fetchPage = (p: number) =>
    fetchImpl(`${base}/teams/filtered-usage-events`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ startDate, endDate, page: p, pageSize }),
    });

  // Runs whose events applied so far get their totals recomputed and
  // cost tag swapped no matter how the pull ends — clean completion,
  // mid-pagination http_error, or an unexpected throw. Applied steps
  // are already in the store, so skipping the flush would leave run
  // totals silently stale.
  const flushRunTotals = (): void => {
    for (const [runId, anyBilled] of updatedRuns) {
      updateRunTotals(store, runId);
      markRunCostActual(store, runId, anyBilled);
    }
  };

  try {
    for (;;) {
      let res = await fetchPage(page);
      for (
        let attempt = 0;
        res.status === 429 && attempt < MAX_429_RETRIES;
        attempt += 1
      ) {
        await sleep(retryAfterMs(res));
        res = await fetchPage(page);
      }
      if (!res.ok) {
        return {
          status: "http_error",
          events_seen: seen,
          events_applied: applied,
          events_unmatched: unmatched,
          events_skipped: skipped,
          events_duplicate: duplicate,
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
        try {
          const { outcome, runId } = await applyUsageEvent(store, ev);
          if (outcome === "applied") {
            applied += 1;
            if (runId) {
              const billed =
                typeof ev.chargedCents === "number" && ev.chargedCents > 0;
              updatedRuns.set(runId, (updatedRuns.get(runId) ?? false) || billed);
            }
          } else if (outcome === "unmatched") {
            unmatched += 1;
          } else if (outcome === "skipped") {
            skipped += 1;
          } else {
            duplicate += 1;
          }
        } catch (err) {
          // One malformed event must not sink the whole pull. Counting
          // it as skipped preserves the counter invariant
          // (seen = applied + unmatched + skipped + duplicate).
          // eslint-disable-next-line no-console
          console.error("[meter/cursor-admin] usage event failed:", err);
          skipped += 1;
        }
      }

      if (events.length === 0 || events.length < pageSize) break;
      if (page >= MAX_PAGES) {
        capReason = `page cap reached (${MAX_PAGES})`;
        break;
      }
      page += 1;
    }
  } finally {
    flushRunTotals();
  }

  return {
    status: "ok",
    events_seen: seen,
    events_applied: applied,
    events_unmatched: unmatched,
    events_skipped: skipped,
    events_duplicate: duplicate,
    runs_updated: updatedRuns.size,
    ...(capReason ? { reason: capReason } : {}),
  };
}

type ApplyOutcome = "applied" | "duplicate" | "unmatched" | "skipped";

async function applyUsageEvent(
  store: Store,
  ev: CursorUsageEvent,
): Promise<{ outcome: ApplyOutcome; runId?: string }> {
  const conversationId = ev.conversationId;
  const usage = ev.tokenUsage;
  if (!conversationId) return { outcome: "skipped" };
  if (!usage || ev.isTokenBasedCall === false) return { outcome: "skipped" };

  const run: Run | undefined = getRunBySessionId(store, conversationId);
  if (!run) return { outcome: "unmatched" };

  // Stable identity: the API exposes no event id, so hash the FULL
  // event object. Deterministic across re-pulls — the server returns
  // the same JSON, so key insertion order (and therefore the hash) is
  // stable — while ANY differing field (chargedCents, requestsCosts,
  // maxMode, fields we don't model yet) keeps distinct events distinct.
  // Re-pulls of overlapping windows become no-ops.
  const stepId = `stp_${hashJson([run.run_id, "cursor-admin", ev])}`;
  const exists = store.db
    .prepare(`SELECT 1 FROM steps WHERE step_id = ?`)
    .get(stepId);
  if (exists) return { outcome: "duplicate", runId: run.run_id };

  // Async blob writes FIRST (content-addressed — harmless if a crash
  // strands them), so the band-sequence derivation + insert can run
  // inside one synchronous transaction below (mirrors insertHookStep):
  // concurrent pulls can't compute the same band sequence.
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

  // Cost semantics (D2): totalCents is the token VALUE of this call;
  // chargedCents is what was actually billed (0 for
  // subscription-included requests). Record the value so the cache lane
  // can reason about waste even when it was "free"; tag the difference.
  const costCents = usage.totalCents ?? ev.chargedCents ?? 0;
  const billed = typeof ev.chargedCents === "number" && ev.chargedCents > 0;
  const tags = ["cursor", "cursor-admin", billed ? "cost:actual" : "cost:value"];
  if (!billed && costCents > 0) tags.push("billing:included");

  store.db.transaction((): void => {
    const existing = store.db
      .prepare(`SELECT 1 FROM steps WHERE step_id = ?`)
      .get(stepId);
    if (existing) return;
    const sequence = nextSequenceInBand(
      store,
      run.run_id,
      ADMIN_SEQUENCE_BASE,
      CHECKPOINT_SEQUENCE_BASE,
    );
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
      tags,
      status: "ok",
    };
    insertStep(store, step);
  })();
  return { outcome: "applied", runId: run.run_id };
}

/**
 * Replace the local `cost:approx` estimate tag now that the run is
 * backed by API data: `cost:actual` when any event was actually billed,
 * `cost:value` when everything was subscription-included.
 */
function markRunCostActual(
  store: Store,
  runId: string,
  anyBilled: boolean,
): void {
  const row = store.db
    .prepare(`SELECT tags FROM runs WHERE run_id = ?`)
    .get(runId) as { tags: string } | undefined;
  if (!row) return;
  try {
    const chosen = anyBilled ? "cost:actual" : "cost:value";
    const tags = JSON.parse(row.tags) as string[];
    const next = tags.filter((t) => t !== "cost:approx");
    // A run once marked cost:actual stays actual — a later value-only
    // window doesn't erase evidence of billed usage.
    if (anyBilled) {
      const i = next.indexOf("cost:value");
      if (i >= 0) next.splice(i, 1);
      if (!next.includes(chosen)) next.push(chosen);
    } else if (!next.includes("cost:actual") && !next.includes(chosen)) {
      next.push(chosen);
    }
    store.db
      .prepare(`UPDATE runs SET tags = ? WHERE run_id = ?`)
      .run(JSON.stringify(next), runId);
  } catch {
    // Malformed tags — leave untouched.
  }
}

/**
 * Display-only timestamp normalization (no longer part of event
 * identity): epoch ms arrives as a number OR a numeric string; some
 * gateways return ISO strings. Anything unparseable degrades to now().
 */
function normalizeTimestamp(ts: string | number | undefined): string {
  if (ts === undefined) return new Date().toISOString();
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

/** https anywhere, or plaintext http to loopback only. Scheme compare is
 *  case-insensitive (URL protocols are); `[::1]` counts as loopback. */
function isSecureAdminBase(base: string): boolean {
  try {
    const url = new URL(base);
    const proto = url.protocol.toLowerCase();
    if (proto === "https:") return true;
    if (proto !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Parse Retry-After (seconds) — default 5s, capped at 60s. */
function retryAfterMs(res: Response): number {
  const raw = res.headers?.get?.("retry-after");
  const secs = raw ? Number(raw) : NaN;
  const capped = Number.isFinite(secs) && secs > 0 ? Math.min(secs, 60) : 5;
  return capped * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
