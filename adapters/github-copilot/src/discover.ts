import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  copilotLegacySessionRoot,
  copilotSessionStateRoot,
} from "@meterbility/shared";

export interface DiscoveredCopilotSession {
  /** Full path to the session's events.jsonl. */
  path: string;
  /** Session directory name — the session id in current CLI builds. */
  session_id: string;
  /** Directory containing events.jsonl (holds workspace.yaml etc.). */
  session_dir: string;
  size_bytes: number;
  mtime: Date;
  /** True when found under the legacy history-session-state root. */
  legacy: boolean;
}

/**
 * Walk `~/.copilot/session-state/<id>/events.jsonl` (and the legacy
 * `history-session-state` root) and return every session Meterbility can
 * ingest, newest-first by mtime. Both roots are probed and tolerated
 * absent — a VS Code-only Copilot install has neither.
 */
export async function discoverCopilotSessions(): Promise<
  DiscoveredCopilotSession[]
> {
  const out: DiscoveredCopilotSession[] = [];
  const roots: Array<{ root: string; legacy: boolean }> = [
    { root: copilotSessionStateRoot(), legacy: false },
    { root: copilotLegacySessionRoot(), legacy: true },
  ];
  for (const { root, legacy } of roots) {
    for (const dir of await safeReaddir(root)) {
      const sessionDir = join(root, dir);
      const eventsPath = join(sessionDir, "events.jsonl");
      try {
        const s = await stat(eventsPath);
        if (!s.isFile()) continue;
        out.push({
          path: eventsPath,
          session_id: dir,
          session_dir: sessionDir,
          size_bytes: s.size,
          mtime: s.mtime,
          legacy,
        });
      } catch {
        // No events.jsonl in this dir — not an ingestible session.
      }
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

/**
 * Best-effort cwd from the session dir's workspace.yaml. Deliberately
 * not a YAML parser — we need one scalar out of an undocumented file,
 * so a line scan over the plausible keys keeps the dependency surface
 * zero and the failure mode graceful (undefined ⇒ "(github-copilot)").
 */
export async function workspaceCwd(
  sessionDir: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(sessionDir, "workspace.yaml"), "utf-8");
  } catch {
    return undefined;
  }
  for (const key of ["cwd", "workspace", "path", "folder", "root"]) {
    const re = new RegExp(`^${key}:\\s*["']?([^"'\\n#]+)`, "m");
    const m = re.exec(text);
    const val = m?.[1]?.trim();
    if (val && val.startsWith("/")) return val;
  }
  return undefined;
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
