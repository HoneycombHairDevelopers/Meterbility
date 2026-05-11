import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Spool data directory. Honors SPOOL_HOME, defaults to ~/.spool.
 */
export function spoolHome(): string {
  return process.env.SPOOL_HOME ?? join(homedir(), ".spool");
}

export function dbPath(): string {
  return join(spoolHome(), "spool.db");
}

export function blobRoot(): string {
  return join(spoolHome(), "blobs");
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
 * Claude Code encodes the cwd as the project directory name by replacing
 * `/`, `.`, and `_` with `-`. We mirror that scheme so we can resolve a
 * project from a cwd.
 */
export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[\/._]/g, "-");
}
