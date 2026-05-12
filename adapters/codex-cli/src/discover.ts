import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredCodexSession {
  path: string;
  session_id: string;
  date_dir: string;
  size_bytes: number;
  mtime: Date;
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexSessionsRoot(): string {
  return join(codexHome(), "sessions");
}

/**
 * Walk `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl` and
 * return every session log Spool can ingest, newest first.
 */
export async function discoverCodexSessions(): Promise<DiscoveredCodexSession[]> {
  const root = codexSessionsRoot();
  const out: DiscoveredCodexSession[] = [];
  await walk(root, "", out);
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

async function walk(
  dir: string,
  rel: string,
  out: DiscoveredCodexSession[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(full, rel ? `${rel}/${e}` : e, out);
    } else if (e.startsWith("rollout-") && e.endsWith(".jsonl")) {
      out.push({
        path: full,
        session_id: extractSessionId(e),
        date_dir: rel,
        size_bytes: s.size,
        mtime: s.mtime,
      });
    }
  }
}

function extractSessionId(filename: string): string {
  // rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl → <uuid>
  const m = filename.match(/rollout-[\d-]+T[\d-]+-([0-9a-f-]+)\.jsonl$/);
  return m?.[1] ?? filename.replace(/\.jsonl$/, "");
}
