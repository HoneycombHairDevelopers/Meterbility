import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Meterbility data directory. Honors METERBILITY_HOME, defaults to ~/.meter.
 */
export function meterHome(): string {
  return process.env.METERBILITY_HOME ?? join(homedir(), ".meter");
}

export function dbPath(): string {
  return join(meterHome(), "meterbility.db");
}

export function blobRoot(): string {
  return join(meterHome(), "blobs");
}

export function blobPath(sha256: string): string {
  if (sha256.length < 4) throw new Error("invalid sha256");
  return join(blobRoot(), sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

/**
 * Path to Claude Code's per-project session log directory. Honors
 * CLAUDE_HOME for tests; defaults to ~/.claude.
 */
export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

export function claudeProjectsRoot(): string {
  return join(claudeHome(), "projects");
}

/**
 * Claude Code's content-addressed file backup store, used by the v0.3
 * file-change adapter (SPEC §3.4) to recover the pre-edit blob for
 * every modifying assistant turn.
 *
 * Layout: `<claudeHome>/file-history/<session-uuid>/<backupFileName>`.
 * The backup filename is the SHA Claude assigned at backup time; we
 * re-hash on read into Meterbility's blob store so identical bytes dedup.
 */
export function claudeFileHistoryDir(sessionId: string): string {
  return join(claudeHome(), "file-history", sessionId);
}

/**
 * Claude Code encodes the cwd as the project directory name by replacing
 * `/`, `.`, and `_` with `-`. We mirror that scheme so we can resolve a
 * project from a cwd.
 */
export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[\/._]/g, "-");
}

/**
 * GitHub Copilot CLI's config/state directory. `COPILOT_HOME` mirrors
 * the CLAUDE_HOME override pattern for tests and non-default installs.
 */
export function copilotHome(): string {
  return process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
}

/**
 * Copilot CLI session persistence: one directory per session containing
 * `events.jsonl` (typed event log) plus `workspace.yaml` metadata.
 * NOTE: this is GitHub's undocumented private exhaust, not a stable
 * product surface — the adapter's shape probe is the drift alarm.
 */
export function copilotSessionStateRoot(): string {
  return join(copilotHome(), "session-state");
}

/** Legacy session storage on older Copilot CLI installs. Probed second. */
export function copilotLegacySessionRoot(): string {
  return join(copilotHome(), "history-session-state");
}
