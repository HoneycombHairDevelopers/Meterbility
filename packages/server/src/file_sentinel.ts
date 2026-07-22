import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileChange, FileOp, Run, Step } from "@meterbility/shared";
import { IgnoreMatcher } from "@meterbility/shared";
import {
  insertFileChange,
  listFileChanges,
  listRuns,
  listSteps,
  isProbablyText,
  DEFAULT_MAX_PARTIAL_BYTES,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import { diffLines } from "@meterbility/claude-code-adapter";

/**
 * v0.4 — FileSentinel, the OS-level file watcher behind `meter watch
 * --files` (SPEC-V0_3 §3.1.3 / §13.2). Captures what the filesystem
 * *actually saw* while an agent runs, filling the fidelity gap
 * tool-call inspection leaves for Bash side effects (`sed`, `mv`,
 * `npm install`, build scripts, ...).
 *
 * Scope: the sentinel is the **cross-vendor fallback** — it works for
 * any runtime Meterbility can only observe from the outside (Codex,
 * Cursor, proxy captures). Claude Code runs have a better option:
 * hook-based capture (`meter capture`, see hook_capture.ts) attributes
 * exactly via PreToolUse/PostToolUse and needs no resident process.
 * When both are active, per-path dedup keeps the corpus clean.
 *
 * Design points, straight from the spec's honesty table:
 *
 *   - **Fallback, never primary.** Rows are `derived_from =
 *     'filesystem_watch'`. When a step already has a full-fidelity
 *     tool_call row for the same path, the watch event is dropped —
 *     the tool-call capture wins.
 *   - **Attribution is heuristic (temporal proximity).** A change is
 *     attributed to the most recent step of the freshest in-progress
 *     run whose cwd overlaps the watched root, and only when that step
 *     is younger than `attributionWindowMs`. The heuristic's inputs
 *     are recorded on the row's `normalizer_notes` so the UI can
 *     badge these rows as inferred, not exact.
 *   - **Noise control.** `.meterbilityignore` defaults + the root's own
 *     `.meterbilityignore` / `.gitignore` filter events; everything under
 *     `.git/` is dropped wholesale (VCS internals churn on every
 *     command and are never agent side effects worth a row).
 *
 * Fidelity: on start the daemon primes a content snapshot of the root
 * (bounded by `maxFileBytes`, blob-store content-addressing dedupes
 * against baseline captures), so the *before* side of the first touch
 * of any file is real bytes, not a stub. After each event the snapshot
 * advances. Files it never saw before a modify (oversize, appeared
 * mid-flight) degrade to `partial_diff` stubs — honest partial over
 * dishonest full.
 *
 * Renames are reported as delete + create (no os-level rename
 * correlation in v0.4). fs.watch platform caveats (coalesced events,
 * null filenames) degrade to missed rows, never wrong rows.
 */

export interface FileSentinelOptions {
  /** Directory to watch. Defaults to process.cwd(). */
  root?: string;
  /**
   * Attribute a change only when the freshest candidate step is at
   * most this old. Long Bash steps (installs, builds) keep producing
   * events well after the step's start timestamp, so this defaults
   * generously to 120s.
   */
  attributionWindowMs?: number;
  /**
   * Quiet period per path before an event is processed. Also gives the
   * live ingest (1.5s scan interval) a head start so tool_call rows
   * for the same path usually exist by the time we dedup against them.
   */
  debounceMs?: number;
  /** Files larger than this are tracked as stubs (no content). */
  maxFileBytes?: number;
  /** Pre-built matcher (tests). Defaults to root's ignore files + defaults. */
  matcher?: IgnoreMatcher;
}

export type FileSentinelEvent =
  | { type: "sentinel:ready"; root: string; primed_files: number }
  | { type: "file:captured"; run_id: string; step_id: string; change: FileChange }
  | {
      type: "file:unattributed";
      path: string;
      op: FileOp;
      reason: "no-active-run" | "no-recent-step";
    }
  | {
      type: "file:skipped";
      path: string;
      reason: "duplicate-tool-call" | "duplicate-event" | "unchanged";
    }
  | { type: "sentinel:error"; message: string };

interface SnapshotEntry {
  /** Blob ref of the last observed content; undefined for oversize files. */
  ref?: string;
  size: number;
}

const DEFAULT_ATTRIBUTION_WINDOW_MS = 120_000;
const DEFAULT_DEBOUNCE_MS = 2_000;

export class FileSentinel extends EventEmitter {
  private store: Store;
  private root: string;
  private windowMs: number;
  private debounceMs: number;
  private maxFileBytes: number;
  private matcher?: IgnoreMatcher;
  private snapshot = new Map<string, SnapshotEntry>();
  private pending = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private stopped = false;
  /** step_id → next free FileChange sequence, seeded from the DB. */
  private seqCounters = new Map<string, number>();

  constructor(store: Store, opts: FileSentinelOptions = {}) {
    super();
    this.store = store;
    this.root = resolve(opts.root ?? process.cwd());
    this.windowMs = opts.attributionWindowMs ?? DEFAULT_ATTRIBUTION_WINDOW_MS;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_PARTIAL_BYTES;
    this.matcher = opts.matcher;
  }

  async start(): Promise<void> {
    await this.prime();
    this.watcher = watch(
      this.root,
      { recursive: true },
      (_event, filename) => {
        // Platform caveat: filename can be null (overflow / coalesced).
        // We can't rescan cheaply per event, so we drop it — a missed
        // row, never a wrong one.
        if (!filename) return;
        this.enqueue(filename.split("\\").join("/"));
      },
    );
    this.watcher.on("error", (err) => {
      this.emit("data", {
        type: "sentinel:error",
        message: String(err),
      } satisfies FileSentinelEvent);
    });
    this.emit("data", {
      type: "sentinel:ready",
      root: this.root,
      primed_files: this.snapshot.size,
    } satisfies FileSentinelEvent);
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Queue a repo-relative path for processing after the debounce. */
  enqueue(relPath: string): void {
    if (this.stopped) return;
    if (this.isIgnored(relPath)) return;
    this.pending.add(relPath);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flushNow().catch((err) => {
        this.emit("data", {
          type: "sentinel:error",
          message: String(err),
        } satisfies FileSentinelEvent);
      });
    }, this.debounceMs);
  }

  /**
   * Process everything queued right now. Public so tests (and callers
   * that want deterministic ordering) can bypass the debounce timer.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const batch = Array.from(this.pending).sort();
    this.pending.clear();
    for (const rel of batch) {
      try {
        await this.processPath(rel);
      } catch (err) {
        this.emit("data", {
          type: "sentinel:error",
          message: `processing ${rel}: ${String(err)}`,
        } satisfies FileSentinelEvent);
      }
    }
  }

  /**
   * Walk the root and record a {path → blob ref} snapshot so first-touch
   * modifies have a real before side. Content-addressed blob writes
   * dedupe against any baseline tree already captured for this repo.
   *
   * Public so tests can snapshot + `enqueue()` + `flushNow()` without
   * binding an OS watcher; `start()` calls it before `fs.watch`.
   */
  async prime(): Promise<void> {
    if (!this.matcher) this.matcher = await loadRootMatcher(this.root);
    const walk = async (dirRel: string): Promise<void> => {
      const dirAbs = dirRel === "" ? this.root : join(this.root, dirRel);
      let entries;
      try {
        entries = await readdir(dirAbs, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip, same posture as baseline walk
      }
      for (const e of entries) {
        const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
        if (e.isDirectory()) {
          if (rel === ".git" || rel.startsWith(".git/")) continue;
          if (this.matcher!.matches(rel, true)) continue;
          await walk(rel);
        } else if (e.isFile()) {
          if (this.matcher!.matches(rel, false)) continue;
          try {
            const s = await stat(join(this.root, rel));
            if (s.size > this.maxFileBytes) {
              this.snapshot.set(rel, { size: s.size });
              continue;
            }
            const buf = await readFile(join(this.root, rel));
            const ref = await this.store.blobs.putBuffer(buf);
            this.snapshot.set(rel, { ref, size: buf.length });
          } catch {
            // vanished / unreadable mid-walk — skip
          }
        }
      }
    };
    await walk("");
  }

  /** Ignore check for event paths: the path itself and every ancestor
   *  directory (dir-only patterns like `node_modules/` never match a
   *  file candidate directly). */
  private isIgnored(relPath: string): boolean {
    if (relPath === "" || relPath === ".") return true;
    if (relPath === ".git" || relPath.startsWith(".git/")) return true;
    if (this.matcher?.matches(relPath, false)) return true;
    if (this.matcher?.matches(relPath, true)) return true;
    const parts = relPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (this.matcher?.matches(parts.slice(0, i).join("/"), true)) return true;
    }
    return false;
  }

  private async processPath(rel: string): Promise<void> {
    const abs = join(this.root, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      st = undefined; // gone → delete candidate
    }

    if (st?.isDirectory()) {
      // Directory events carry no content. Its children arrive as their
      // own events; nothing to do here.
      return;
    }

    if (!st) {
      // Deleted. A deleted directory fires one event for the dir path;
      // fan out to every snapshot entry underneath it.
      if (this.snapshot.has(rel)) {
        await this.handleDelete(rel);
        return;
      }
      const prefix = rel + "/";
      for (const key of Array.from(this.snapshot.keys())) {
        if (key.startsWith(prefix)) await this.handleDelete(key);
      }
      return;
    }

    // Exists: create or modify.
    const prev = this.snapshot.get(rel);
    if (st.size > this.maxFileBytes) {
      // Oversize — track existence, emit an honest partial stub.
      this.snapshot.set(rel, { size: st.size });
      await this.insertChange(rel, prev ? "modify" : "create", {
        partialStub: true,
        sizeBefore: prev?.size,
        sizeAfter: st.size,
      });
      return;
    }

    let afterBuf: Buffer;
    try {
      afterBuf = await readFile(abs);
    } catch {
      return; // vanished between stat and read — the delete event follows
    }
    const afterRef = await this.store.blobs.putBuffer(afterBuf);
    if (prev?.ref === afterRef) {
      this.emit("data", {
        type: "file:skipped",
        path: rel,
        reason: "unchanged",
      } satisfies FileSentinelEvent);
      return;
    }

    const beforeBuf =
      prev?.ref !== undefined
        ? await this.store.blobs.getBuffer(prev.ref).catch(() => undefined)
        : undefined;
    this.snapshot.set(rel, { ref: afterRef, size: afterBuf.length });

    if (prev && beforeBuf === undefined) {
      // Existed before but we never captured its content (oversize at
      // prime, blob unreadable). Modify without a before side → stub.
      await this.insertChange(rel, "modify", {
        partialStub: true,
        sizeBefore: prev.size,
        sizeAfter: afterBuf.length,
      });
      return;
    }

    await this.insertChange(rel, prev ? "modify" : "create", {
      beforeBuf,
      afterBuf,
      beforeRef: prev?.ref,
      afterRef,
    });
  }

  private async handleDelete(rel: string): Promise<void> {
    const prev = this.snapshot.get(rel);
    if (!prev) return;
    this.snapshot.delete(rel);
    if (prev.ref === undefined) {
      await this.insertChange(rel, "delete", {
        partialStub: true,
        sizeBefore: prev.size,
      });
      return;
    }
    const beforeBuf = await this.store.blobs
      .getBuffer(prev.ref)
      .catch(() => undefined);
    if (beforeBuf === undefined) {
      await this.insertChange(rel, "delete", {
        partialStub: true,
        sizeBefore: prev.size,
      });
      return;
    }
    await this.insertChange(rel, "delete", {
      beforeBuf,
      beforeRef: prev.ref,
    });
  }

  /**
   * Attribution + dedup + row insert. `partialStub` rows carry no blob
   * refs (the invariant `partial_diff ⇒ both refs null`); full rows
   * carry whichever sides the op defines.
   */
  private async insertChange(
    rel: string,
    op: FileOp,
    content: {
      beforeBuf?: Buffer;
      afterBuf?: Buffer;
      beforeRef?: string;
      afterRef?: string;
      partialStub?: boolean;
      sizeBefore?: number;
      sizeAfter?: number;
    },
  ): Promise<void> {
    const attributed = this.attribute();
    if ("reason" in attributed) {
      this.emit("data", {
        type: "file:unattributed",
        path: rel,
        op,
        reason: attributed.reason,
      } satisfies FileSentinelEvent);
      return;
    }
    const { run, step, gapMs } = attributed;

    // Dedup against rows the step already carries for this path.
    const existing = listFileChanges(this.store, { stepId: step.step_id });
    for (const fc of existing) {
      if (fc.path !== rel) continue;
      if (fc.derived_from === "tool_call" && !fc.partial_diff) {
        // Tool-call inspection already captured this path exactly —
        // it's primary, we're the fallback (spec §3.1.3).
        this.emit("data", {
          type: "file:skipped",
          path: rel,
          reason: "duplicate-tool-call",
        } satisfies FileSentinelEvent);
        return;
      }
      if (
        fc.derived_from === "filesystem_watch" &&
        fc.op === op &&
        fc.after_blob_ref === content.afterRef &&
        fc.before_blob_ref === content.beforeRef
      ) {
        this.emit("data", {
          type: "file:skipped",
          path: rel,
          reason: "duplicate-event",
        } satisfies FileSentinelEvent);
        return;
      }
    }

    let seq = this.seqCounters.get(step.step_id);
    if (seq === undefined) {
      seq = existing.reduce((m, fc) => Math.max(m, fc.sequence + 1), 0);
    }
    this.seqCounters.set(step.step_id, seq + 1);

    const notes = {
      attributed_by: "temporal_proximity",
      watcher_root: this.root,
      gap_ms: gapMs,
      observed_at: new Date().toISOString(),
    };

    let change: FileChange;
    if (content.partialStub) {
      change = insertFileChange(this.store, {
        run_id: run.run_id,
        step_id: step.step_id,
        sequence: seq,
        derived_from: "filesystem_watch",
        path: rel,
        op,
        partial_diff: true,
        gitignored: false,
        bom: false,
        size_before: content.sizeBefore,
        size_after: content.sizeAfter,
        lines_added: 0,
        lines_removed: 0,
        redacted: false,
        normalizer_notes: notes,
      });
    } else {
      const { beforeBuf, afterBuf } = content;
      change = insertFileChange(this.store, {
        run_id: run.run_id,
        step_id: step.step_id,
        sequence: seq,
        derived_from: "filesystem_watch",
        path: rel,
        op,
        before_blob_ref: content.beforeRef,
        after_blob_ref: content.afterRef,
        partial_diff: false,
        gitignored: false,
        bom: false,
        size_before: beforeBuf?.length ?? content.sizeBefore,
        size_after: afterBuf?.length ?? content.sizeAfter,
        redacted: false,
        normalizer_notes: notes,
        ...contentRowFields(beforeBuf, afterBuf),
      });
    }

    this.emit("data", {
      type: "file:captured",
      run_id: run.run_id,
      step_id: step.step_id,
      change,
    } satisfies FileSentinelEvent);
  }

  /**
   * Temporal-proximity attribution. Candidate runs: in_progress, cwd
   * overlapping the watched root. Winner: the run whose latest step is
   * newest — and only if that step falls inside the window.
   */
  private attribute():
    | { run: Run; step: Step; gapMs: number }
    | { reason: "no-active-run" | "no-recent-step" } {
    const runs = listRuns(this.store, { limit: 100 }).filter(
      (r) => r.status === "in_progress" && this.cwdOverlaps(r.cwd),
    );
    if (runs.length === 0) return { reason: "no-active-run" };
    let best: { run: Run; step: Step; ts: number } | undefined;
    for (const run of runs) {
      const steps = listSteps(this.store, run.run_id);
      const last = steps[steps.length - 1];
      if (!last) continue;
      const ts = new Date(last.timestamp).getTime();
      if (!best || ts > best.ts) best = { run, step: last, ts };
    }
    if (!best) return { reason: "no-active-run" };
    const gapMs = Date.now() - best.ts;
    if (gapMs > this.windowMs) return { reason: "no-recent-step" };
    return { run: best.run, step: best.step, gapMs };
  }

  private cwdOverlaps(cwd: string | undefined): boolean {
    if (!cwd) return false;
    const norm = resolve(cwd);
    return (
      norm === this.root ||
      this.root.startsWith(norm + "/") ||
      norm.startsWith(this.root + "/")
    );
  }
}

/** Defaults + the root's `.meterbilityignore` / `.gitignore`, mirroring
 *  the baseline walker's stacking order. Shared with hook capture
 *  (hook_capture.ts) so both capture paths filter identically. */
export async function loadRootMatcher(root: string): Promise<IgnoreMatcher> {
  const lists: Array<string[] | undefined> = [];
  for (const name of [".meterbilityignore", ".gitignore"]) {
    try {
      const text = await readFile(join(root, name), "utf-8");
      lists.push(text.split(/\r?\n/));
    } catch {
      lists.push(undefined);
    }
  }
  return IgnoreMatcher.fromDefaultsPlus(...lists);
}

/**
 * Diff-derived row fields shared by the sentinel and hook capture:
 * patch text, format, encoding, and line accounting for a (before,
 * after) content pair. Either side may be absent (create/delete).
 */
export function contentRowFields(
  beforeBuf: Buffer | undefined,
  afterBuf: Buffer | undefined,
): Pick<
  FileChange,
  | "patch_text"
  | "patch_format"
  | "encoding"
  | "line_count_before"
  | "line_count_after"
  | "lines_added"
  | "lines_removed"
> {
  const beforeIsText = beforeBuf === undefined || isProbablyText(beforeBuf);
  const afterIsText = afterBuf === undefined || isProbablyText(afterBuf);
  const canTextDiff =
    (beforeBuf !== undefined || afterBuf !== undefined) &&
    beforeIsText &&
    afterIsText;
  let patch_text: string | undefined;
  let patch_format: FileChange["patch_format"];
  let lines_added = 0;
  let lines_removed = 0;
  if (canTextDiff) {
    const diff = diffLines(
      beforeBuf ? beforeBuf.toString("utf-8") : "",
      afterBuf ? afterBuf.toString("utf-8") : "",
    );
    patch_text = diff.unified || undefined;
    lines_added = diff.stats.added;
    lines_removed = diff.stats.removed;
    patch_format = patch_text ? "unified" : undefined;
  } else {
    patch_format = "binary";
  }
  return {
    patch_text,
    patch_format,
    encoding: canTextDiff ? "utf-8" : "binary",
    line_count_before:
      beforeBuf && beforeIsText
        ? countLines(beforeBuf.toString("utf-8"))
        : undefined,
    line_count_after:
      afterBuf && afterIsText
        ? countLines(afterBuf.toString("utf-8"))
        : undefined,
    lines_added,
    lines_removed,
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) n += 1;
  }
  if (text.charCodeAt(text.length - 1) !== 0x0a) n += 1;
  return n;
}
