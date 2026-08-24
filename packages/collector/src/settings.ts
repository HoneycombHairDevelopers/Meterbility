import type { Store } from "./store.ts";

/**
 * Tiny key-value store on top of the `settings` SQLite table. Used by
 * the web UI's Settings page so users can configure Slack webhooks,
 * watched tools, default fork model, etc. without re-typing per
 * session.
 *
 * Secrets warning: values are stored in plaintext in `~/.meter/meterbility.db`.
 * The Settings UI surfaces this clearly. For Keychain-backed storage,
 * see SPEC-DESKTOP.md (the desktop app's job, not the web UI's).
 */

export type SettingKey =
  | "slack.webhook"
  | "slack.default_events"
  | "live.watch_tools"
  | "live.stall_seconds"
  | "fork.default_model"
  | "fork.default_max_iterations"
  | "anthropic.api_key"
  | "postgres.url"
  | "export.include_file_blobs"
  // v0.3 §11 — defense-in-depth for non-loopback `meter web` binds.
  // When set, /api/* routes require `Authorization: Bearer <token>`.
  // Stored verbatim; `isSecret()` matches the `token$` suffix so the
  // settings UI masks it on display.
  | "web.bind_token"
  // v0.3 — file-capture controls per SPEC-V0_3 §3.5 + §11.1.
  // Live-read per FileChange (A7) so an operator can flip them
  // mid-run for incident response. `enabled` is the kill switch;
  // the two byte thresholds tune the size policy.
  | "capture.files.enabled"
  | "capture.files.max_partial_bytes"
  | "capture.files.max_skip_bytes"
  // Cross-vendor parity — Cursor Admin API usage puller (Teams/Business).
  // The api_key is team-scoped (Basic auth); base override is for tests
  // and self-hosted gateways. isSecret() masks the key via `api_key`.
  | "cursor.admin_api_key"
  | "cursor.admin_api_base"
  // meter live (v0.6.x) — capture-attachment heartbeat. ISO timestamp
  // written every evaluator tick by the `meter live` instance that
  // holds the FileSentinel; deleted on clean shutdown. Consumers: the
  // second-instance viewer-guard (fresh heartbeat → new instance runs
  // viewer-only) and the CLI nudge (stale heartbeat + recent capture
  // rows → "meter live to attach" hint). A crashed holder's heartbeat
  // self-expires via staleness — no lock, no pidfile.
  | "live.heartbeat";

/**
 * Runtime enumeration of every SettingKey — keep in sync with the union
 * above. Lets API surfaces (the web settings endpoint) reject unknown
 * keys instead of silently storing garbage.
 */
export const SETTING_KEYS: readonly SettingKey[] = [
  "slack.webhook",
  "slack.default_events",
  "live.watch_tools",
  "live.stall_seconds",
  "fork.default_model",
  "fork.default_max_iterations",
  "anthropic.api_key",
  "postgres.url",
  "export.include_file_blobs",
  "web.bind_token",
  "capture.files.enabled",
  "capture.files.max_partial_bytes",
  "capture.files.max_skip_bytes",
  "cursor.admin_api_key",
  "cursor.admin_api_base",
  "live.heartbeat",
];

/**
 * Freshness contract for the `live.heartbeat` setting — the single
 * source both the `meter live` viewer-guard and the CLI nudge compare
 * against. A heartbeat younger than this means a live viewer holds
 * capture; older self-expires (crashed holder).
 */
export const LIVE_HEARTBEAT_FRESH_MS = 2 * 60_000;

/**
 * The one freshness predicate for `live.heartbeat` — used by the
 * viewer-guard, the watch guard, and the nudge. Future-dated
 * heartbeats beyond a small skew tolerance are treated as STALE:
 * a backward clock step (NTP correction) after a holder crash must
 * not wedge every new instance into viewer-only mode (red-team
 * finding — the naive `age < FRESH` passes for any negative age).
 */
export function isLiveHeartbeatFresh(iso: string, now = Date.now()): boolean {
  const age = now - Date.parse(iso);
  if (!Number.isFinite(age)) return false;
  const SKEW_TOLERANCE_MS = 10_000;
  return age >= -SKEW_TOLERANCE_MS && age < LIVE_HEARTBEAT_FRESH_MS;
}

/**
 * Per-ROOT capture claims (codex adversarial P1: a single global
 * heartbeat let a `meter live` in repoA silently disable file capture
 * for every other repo on the machine, and shutdown deleted another
 * process's claim). The `live.heartbeat` setting value is a JSON map
 * of watched-root → ISO timestamp. A legacy plain-ISO value (written
 * by pre-fix builds) reads as a wildcard claim under "*" that matches
 * any root until it expires.
 *
 * Concurrency: writers re-read + rewrite the whole map each tick,
 * pruning stale entries. Two holders racing a write can clobber each
 * other's entry for one tick — harmless, because each rewrites within
 * 5s and freshness tolerates 2 minutes.
 */
export interface LiveClaim {
  ts: string;
  /** Holder identity (pid + entropy). Lets a holder detect it LOST a
   *  simultaneous-start race and downgrade, instead of two sentinels
   *  refreshing each other's freshness forever (adversarial finding). */
  owner?: string;
}

export function readLiveHeartbeats(store: Store): Record<string, LiveClaim> {
  const raw = getSetting(store, "live.heartbeat");
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, LiveClaim> = {};
      for (const [r, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[r] = { ts: v };
        else if (v && typeof v === "object" && typeof (v as LiveClaim).ts === "string") {
          out[r] = v as LiveClaim;
        }
      }
      return out;
    }
  } catch {
    // legacy plain-ISO value
  }
  return { "*": { ts: raw } };
}

export function writeLiveHeartbeat(store: Store, root: string, owner?: string): void {
  const next: Record<string, LiveClaim> = {};
  for (const [r, claim] of Object.entries(readLiveHeartbeats(store))) {
    if (r !== root && r !== "*" && isLiveHeartbeatFresh(claim.ts)) next[r] = claim;
  }
  next[root] = { ts: new Date().toISOString(), ...(owner ? { owner } : {}) };
  setSetting(store, "live.heartbeat", JSON.stringify(next));
}

/** Release ONLY this root's claim; other roots' holders are untouched. */
export function clearLiveHeartbeat(store: Store, root: string): void {
  const next: Record<string, LiveClaim> = {};
  for (const [r, claim] of Object.entries(readLiveHeartbeats(store))) {
    if (r !== root && isLiveHeartbeatFresh(claim.ts)) next[r] = claim;
  }
  if (Object.keys(next).length === 0) {
    deleteSetting(store, "live.heartbeat");
  } else {
    setSetting(store, "live.heartbeat", JSON.stringify(next));
  }
}

/** Is capture held for THIS root (or by a legacy wildcard claim)? */
export function liveCaptureHeldFor(store: Store, root: string): boolean {
  for (const [r, claim] of Object.entries(readLiveHeartbeats(store))) {
    if ((r === root || r === "*") && isLiveHeartbeatFresh(claim.ts)) return true;
  }
  return false;
}

/** Current owner of this root's fresh claim, if any. */
export function liveClaimOwner(store: Store, root: string): string | undefined {
  const claim = readLiveHeartbeats(store)[root];
  return claim && isLiveHeartbeatFresh(claim.ts) ? claim.owner : undefined;
}

/** Is ANY live viewer holding capture (nudge suppression)? */
export function anyLiveCaptureHeld(store: Store): boolean {
  return Object.values(readLiveHeartbeats(store)).some((c) =>
    isLiveHeartbeatFresh(c.ts),
  );
}

export function getSetting(store: Store, key: SettingKey): string | undefined {
  const row = store.db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(store: Store, key: SettingKey, value: string): void {
  store.db
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

export function deleteSetting(store: Store, key: SettingKey): void {
  store.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function listSettings(
  store: Store,
): Array<{ key: string; value: string; updated_at: string }> {
  return store.db
    .prepare("SELECT key, value, updated_at FROM settings ORDER BY key")
    .all() as Array<{ key: string; value: string; updated_at: string }>;
}

/**
 * Resolve a setting that may also live in an environment variable.
 * Env var wins when both are present — matches CLI semantics where
 * env vars are the authoritative source.
 */
export function resolveSetting(
  store: Store,
  key: SettingKey,
  envVar: string,
): string | undefined {
  return process.env[envVar] ?? getSetting(store, key);
}

export function isSecret(key: string): boolean {
  return /api_key|webhook|password|token|secret|url$/i.test(key);
}

/** Mask a secret value for display: `sk-ant-xxx…last4`. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 7)}${"•".repeat(8)}${value.slice(-4)}`;
}
