import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { join, relative, sep } from "node:path";
import type { BaselineTree, ManifestEntry } from "@spool-ai/shared";
import { IgnoreMatcher } from "@spool-ai/shared";
import {
  findBaselineByManifest,
  insertBaselineTree,
} from "./queries.ts";
import { serializeManifest } from "./replay.ts";
import type { Store } from "./store.ts";

/**
 * v0.3 Track A — lazy baseline tree capture (SPEC §3.5).
 *
 * Walks a run's cwd respecting `.spoolignore` defaults + the user's
 * `.spoolignore` + `.gitignore`, hashes every file's bytes through the
 * blob store (binary-safe per PR 1), serializes a sorted manifest, and
 * registers a `baseline_tree` row.
 *
 * Why lazy: most runs are non-coding (research agents, customer support
 * bots, anything that never touches a filesystem). Eager capture at run
 * start would pay the walk cost on every one of them. So the adapter
 * fires `captureBaseline` only on the first FileChange it's about to
 * insert — at which point we know the run is actually a coding session.
 *
 * Why content-addressed: two runs against the same git HEAD produce
 * byte-identical manifests (sorted serialization), which dedupes through
 * the blob store naturally. This is the dominant storage win flagged in
 * SPEC §3.5 — a 100-step refactor on a 10k-LOC repo shares one baseline
 * blob across every retrospective replay, fork, and trajectory diff
 * forever.
 *
 * Why gentle on failure: any per-file error (permissions, vanished
 * mid-walk, symlink loop) gets a warn and the file gets skipped. A
 * completely missing cwd returns `undefined` rather than throwing — the
 * adapter then proceeds without a baseline, FileChange rows still land,
 * and `workingTreeAt` returns the delta-only tree.
 */

/** Per SPEC §11.1: files over this threshold don't enter the baseline
 *  manifest. If an edit later modifies one, the FileChange row's
 *  partial_diff handles the missing before-state. */
const MAX_BASELINE_FILE_BYTES = 5 * 1024 * 1024;

/** Per SPEC §11.4: parallel file I/O bounded by min(8, os.cpus()). */
const HASH_CONCURRENCY = Math.min(8, Math.max(1, availableParallelism()));

export interface CaptureBaselineResult {
  baseline_tree_id: string;
  /** Manifest blob ref, exposed for diagnostics + tests. */
  manifest_blob_ref: string;
  /** Number of files that made it into the manifest. */
  file_count: number;
  /** Number of files skipped (oversize, unreadable, ignored). */
  skipped: number;
  /** True when this run dedup'd onto an existing baseline_tree row. */
  reused_existing: boolean;
  git_head?: string;
  git_dirty: boolean;
}

export interface CaptureBaselineOptions {
  /**
   * Pre-built ignore matcher. If omitted, the function loads
   * `<cwd>/.spoolignore` + `<cwd>/.gitignore` on top of the
   * shipped defaults.
   */
  matcher?: IgnoreMatcher;
  /** Override the size cap (mostly for tests). */
  maxFileBytes?: number;
}

/**
 * Capture the baseline tree for a project's cwd. Returns `undefined` if
 * the cwd doesn't exist or is empty — the adapter treats that as
 * "non-coding run, no baseline needed" and continues without one.
 */
export async function captureBaseline(
  store: Store,
  projectId: string,
  cwd: string,
  opts: CaptureBaselineOptions = {},
): Promise<CaptureBaselineResult | undefined> {
  // Validate cwd exists. Common during ingest of historical sessions
  // where the project directory has since been deleted.
  try {
    const s = await stat(cwd);
    if (!s.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const matcher = opts.matcher ?? (await buildDefaultMatcher(cwd));
  const maxBytes = opts.maxFileBytes ?? MAX_BASELINE_FILE_BYTES;

  // Walk + filter. Returns the list of candidate file paths (POSIX,
  // repo-relative) along with their POSIX mode bits.
  const candidates = await walk(cwd, matcher);

  // Parallel hash through the blob store.
  const entries: ManifestEntry[] = [];
  let skipped = 0;
  const queue = [...candidates];
  await Promise.all(
    Array.from({ length: HASH_CONCURRENCY }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        const absPath = join(cwd, ...c.repoPath.split("/"));
        try {
          const buf = await readFile(absPath);
          if (buf.length > maxBytes) {
            skipped += 1;
            continue;
          }
          // Binary-safe via PR 1 — isProbablyText auto-routes binary
          // bytes around the redaction pass.
          const blob_ref = await store.blobs.putBuffer(buf);
          entries.push({ path: c.repoPath, mode: c.mode, blob_ref });
        } catch {
          // ENOENT / EACCES / midwalk-vanished — skip with a tally so
          // the operator can spot widespread issues via the
          // CaptureBaselineResult.skipped count.
          skipped += 1;
        }
      }
    }),
  );

  // Serialize + write the manifest blob. `skipRedact: true` because
  // the manifest is structured index data — running it through the
  // redaction pass would corrupt the format (the manifest mentions
  // paths like `.env`, which the env-file rule would scrub).
  const manifestBuf = serializeManifest(entries);
  const manifest_blob_ref = await store.blobs.putBuffer(manifestBuf, {
    skipRedact: true,
  });

  // Dedup: if a row with this manifest already exists for this project,
  // reuse it. Two runs against the same git HEAD on the same project
  // land here.
  const existing = findBaselineByManifest(store, projectId, manifest_blob_ref);
  const { git_head, git_dirty } = readGitAdvisory(cwd);
  if (existing) {
    return {
      baseline_tree_id: existing.baseline_tree_id,
      manifest_blob_ref,
      file_count: entries.length,
      skipped,
      reused_existing: true,
      git_head: existing.git_head ?? git_head,
      git_dirty: existing.git_dirty,
    };
  }
  const row = insertBaselineTree(store, {
    project_id: projectId,
    manifest_blob_ref,
    git_head,
    git_dirty,
  });
  return {
    baseline_tree_id: row.baseline_tree_id,
    manifest_blob_ref,
    file_count: entries.length,
    skipped,
    reused_existing: false,
    git_head,
    git_dirty,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface Candidate {
  repoPath: string; // POSIX, relative to cwd
  mode: number;
}

async function walk(
  rootCwd: string,
  matcher: IgnoreMatcher,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const stack: string[] = [rootCwd];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip the subtree
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const repoRel = toRepoRelative(rootCwd, abs);
      const isDir = entry.isDirectory();
      if (matcher.matches(repoRel, isDir)) continue;
      if (isDir) {
        stack.push(abs);
      } else if (entry.isFile()) {
        let mode = 0o100644;
        try {
          const s = await stat(abs);
          mode = s.mode;
        } catch {
          // ignore; fall back to default mode
        }
        out.push({ repoPath: repoRel, mode });
      }
      // Skip symlinks, sockets, fifos, etc. — not interesting for code
      // capture, and following symlinks invites loops.
    }
  }
  return out;
}

function toRepoRelative(rootCwd: string, abs: string): string {
  return relative(rootCwd, abs).split(sep).join("/");
}

async function buildDefaultMatcher(cwd: string): Promise<IgnoreMatcher> {
  const userSpool = await readLines(join(cwd, ".spoolignore"));
  const gitignore = await readLines(join(cwd, ".gitignore"));
  return IgnoreMatcher.fromDefaultsPlus(userSpool, gitignore);
}

async function readLines(path: string): Promise<string[] | undefined> {
  try {
    const text = await readFile(path, "utf-8");
    return text.split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function readGitAdvisory(cwd: string): {
  git_head: string | undefined;
  git_dirty: boolean;
} {
  // Both calls are best-effort. If `git` isn't on PATH, or cwd isn't a
  // git repo, both return undefined / false. Spool never depends on
  // git — this is advisory metadata only (SPEC §3.5).
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf-8",
    // Suppress noisy "not a git repository" output from stderr.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const git_head =
    head.status === 0 ? head.stdout.trim() || undefined : undefined;
  if (!git_head) return { git_head: undefined, git_dirty: false };
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const git_dirty = status.status === 0 && status.stdout.trim().length > 0;
  return { git_head, git_dirty };
}

// Type guard re-export for downstream symmetry with the rest of the
// module's API.
export type { BaselineTree };
