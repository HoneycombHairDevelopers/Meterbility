import type { Store } from "./store.ts";

/**
 * Tiny key-value store on top of the `settings` SQLite table. Used by
 * the web UI's Settings page so users can configure Slack webhooks,
 * watched tools, default fork model, etc. without re-typing per
 * session.
 *
 * Secrets warning: values are stored in plaintext in `~/.spool/spool.db`.
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
  // v0.3 §11 — defense-in-depth for non-loopback `spool web` binds.
  // When set, /api/* routes require `Authorization: Bearer <token>`.
  // Stored verbatim; `isSecret()` matches the `token$` suffix so the
  // settings UI masks it on display.
  | "web.bind_token";

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
