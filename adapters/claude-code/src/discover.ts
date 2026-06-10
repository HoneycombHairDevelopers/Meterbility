import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectsRoot, encodeCwdForClaude } from "@spool-ai/shared";

export interface DiscoveredSession {
  path: string;
  project_dir: string;
  session_id: string;
  size_bytes: number;
  mtime: Date;
}

/**
 * Walk `~/.claude/projects/<encoded-cwd>/*.jsonl` and return every
 * session log Spool can ingest. If `cwd` is given, we restrict to that
 * project. Otherwise everything is returned, sorted newest-first by
 * mtime so the CLI's `discover` command surfaces the most recent runs
 * to the operator without prompting.
 */
export async function discoverSessions(opts: {
  cwd?: string;
} = {}): Promise<DiscoveredSession[]> {
  const root = claudeProjectsRoot();
  const projects = opts.cwd
    ? [encodeCwdForClaude(opts.cwd)]
    : await safeReaddir(root);
  const out: DiscoveredSession[] = [];
  for (const projDir of projects) {
    const projPath = join(root, projDir);
    let projStat;
    try {
      projStat = await stat(projPath);
    } catch {
      continue;
    }
    if (!projStat.isDirectory()) continue;
    const files = await safeReaddir(projPath);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(projPath, f);
      try {
        const s = await stat(full);
        out.push({
          path: full,
          project_dir: projDir,
          session_id: f.replace(/\.jsonl$/, ""),
          size_bytes: s.size,
          mtime: s.mtime,
        });
      } catch {
        // skip
      }
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
