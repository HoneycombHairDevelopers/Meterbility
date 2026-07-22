import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileChange, FileOp, Run, Step } from "@meterbility/shared";
import { meterHome, IgnoreMatcher } from "@meterbility/shared";
import {
  getRunBySessionId,
  insertFileChange,
  listFileChanges,
  listSteps,
  DEFAULT_MAX_PARTIAL_BYTES,
} from "@meterbility/collector";
import type { Store } from "@meterbility/collector";
import { ingestSession } from "@meterbility/claude-code-adapter";
import { contentRowFields, loadRootMatcher } from "./file_sentinel.ts";

/**
 * v0.4 — hook-based file capture for Claude Code (`meter capture`,
 * installed by `meter init --hooks`).
 *
 * Where the FileSentinel (file_sentinel.ts) is a resident watcher with
 * temporal-proximity attribution, this path is ephemeral and exact:
 * Claude Code's PreToolUse/PostToolUse hooks invoke `meter capture
 * pre` / `meter capture post` around every Bash call, and the change
 * set observed between the two is attributed to that specific step.
 *
 * Two Claude Code realities shape the design (verified against current
 * hook docs):
 *
 *   1. **Hook payloads carry no tool_use_id.** We get `session_id`,
 *      `cwd`, `tool_name`, `tool_input`, `transcript_path`. So the
 *      step linkage is recovered by matching the payload's tool_input
 *      against the run's steps — exact for the dominant case (a Bash
 *      command is near-unique within a session; ties break by
 *      timestamp proximity).
 *   2. **The transcript JSONL may lag the hook.** At post time the
 *      assistant message that carries the tool_use may not be on disk
 *      yet, so capture never blocks on it: observed deltas are written
 *      to a durable stash immediately (bytes → blob store, metadata →
 *      pending file) and *drained* into FileChange rows on subsequent
 *      capture invocations, once ingest can see the step. A record
 *      that can't be attributed within the TTL is dropped with its
 *      blobs intact — honest absence over guessed attribution.
 *
 * State on disk, under `$METERBILITY_HOME/capture/`:
 *   - `manifest-<sha16(root)>.json` — persistent {path → stat + blob
 *     ref} map for the watched root. `pre` silently folds in anything
 *     that changed since the last capture (ambient edits, Edit-tool
 *     writes that already have exact tool_call capture) so those are
 *     never blamed on the upcoming Bash step. `post` diffs against it
 *     and advances it.
 *   - `pending.json` — the stash of not-yet-attributed capture
 *     records.
 *
 * Concurrency: parallel Bash calls can interleave pre/post pairs.
 * Writes are atomic (tmp + rename) and last-writer-wins; an
 * interleaved pair degrades to both steps' deltas landing in one
 * record — attribution then picks the closest-matching step. Good
 * enough for v0.4; noted in docs.
 */

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
}

interface ManifestEntry {
  size: number;
  mtime_ms: number;
  /** Blob ref of last observed content; absent for oversize files. */
  ref?: string;
}

interface Manifest {
  root: string;
  updated_at: string;
  files: Record<string, ManifestEntry>;
}

interface StashDelta {
  path: string;
  op: FileOp;
  before_ref?: string;
  after_ref?: string;
  size_before?: number;
  size_after?: number;
  /** True when a side existed but its content wasn't capturable. */
  partial: boolean;
}

interface StashRecord {
  id: string;
  session_id: string;
  transcript_path?: string;
  cwd: string;
  tool_name: string;
  tool_input: unknown;
  observed_at: string;
  attempts: number;
  deltas: StashDelta[];
}

export interface CaptureOptions {
  /** Override the capture state directory (tests). */
  stateDir?: string;
  /** Pre-built ignore matcher (tests). */
  matcher?: IgnoreMatcher;
  /** Files larger than this are tracked as partial stubs. */
  maxFileBytes?: number;
  /**
   * Incremental-ingest hook. Defaults to the Claude Code adapter's
   * `ingestSession`; tests inject a no-op. Failures are swallowed —
   * drain just retries on the next invocation.
   */
  ingest?: (store: Store, transcriptPath: string) => Promise<unknown>;
  /** Max age before an unattributable stash record is dropped. */
  stashTtlMs?: number;
}

export interface CapturePreResult {
  root: string;
  /** True when this call built the manifest from scratch. */
  primed: boolean;
  /** Entries silently refreshed into the baseline (ambient edits). */
  refreshed: number;
  drained: DrainResult;
}

export interface CapturePostResult {
  root: string;
  /** Deltas observed and stashed by this call. */
  observed: number;
  drained: DrainResult;
}

export interface DrainResult {
  /** FileChange rows inserted across all drained records. */
  inserted: FileChange[];
  /** Records still pending (transcript hasn't caught up yet). */
  pending: number;
  /** Records dropped after exhausting the TTL. */
  expired: number;
}

const DEFAULT_STASH_TTL_MS = 15 * 60_000;

/** Attribution match slack: a step may be stamped slightly after the
 *  post hook observes (clock ordering isn't guaranteed). */
const MATCH_FUTURE_SLACK_MS = 30_000;

export async function capturePre(
  store: Store,
  payload: HookPayload,
  opts: CaptureOptions = {},
): Promise<CapturePreResult> {
  const root = resolve(payload.cwd ?? process.cwd());
  const matcher = opts.matcher ?? (await loadRootMatcher(root));
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_PARTIAL_BYTES;
  const dir = stateDir(opts);
  const existing = await loadManifest(dir, root);

  if (!existing) {
    const manifest = await buildManifest(store, root, matcher, maxBytes);
    await saveManifest(dir, root, manifest);
    const drained = await drainStash(store, opts);
    return { root, primed: true, refreshed: 0, drained };
  }

  // Fold anything that changed since the last capture into the
  // baseline WITHOUT emitting rows: these changes happened before the
  // step we're about to observe, so blaming them on it would be the
  // exact misattribution this path exists to avoid.
  const scanned = await scanStats(root, matcher);
  let refreshed = 0;
  for (const [rel, st] of scanned) {
    const prev = existing.files[rel];
    if (prev && prev.size === st.size && prev.mtime_ms === st.mtime_ms) continue;
    existing.files[rel] = await readEntry(store, root, rel, st, maxBytes);
    refreshed += 1;
  }
  for (const rel of Object.keys(existing.files)) {
    if (!scanned.has(rel)) {
      delete existing.files[rel];
      refreshed += 1;
    }
  }
  await saveManifest(dir, root, existing);
  const drained = await drainStash(store, opts);
  return { root, primed: false, refreshed, drained };
}

export async function capturePost(
  store: Store,
  payload: HookPayload,
  opts: CaptureOptions = {},
): Promise<CapturePostResult> {
  const root = resolve(payload.cwd ?? process.cwd());
  const matcher = opts.matcher ?? (await loadRootMatcher(root));
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_PARTIAL_BYTES;
  const dir = stateDir(opts);
  let manifest = await loadManifest(dir, root);

  if (!manifest) {
    // No baseline (post-only install, or first run): prime now. The
    // changes this step made are indistinguishable from the priors, so
    // nothing is observed — honest empty over guessed rows.
    manifest = await buildManifest(store, root, matcher, maxBytes);
    await saveManifest(dir, root, manifest);
    const drained = await drainStash(store, opts);
    return { root, observed: 0, drained };
  }

  const scanned = await scanStats(root, matcher);
  const deltas: StashDelta[] = [];

  for (const [rel, st] of scanned) {
    const prev = manifest.files[rel];
    if (prev && prev.size === st.size && prev.mtime_ms === st.mtime_ms) continue;
    const entry = await readEntry(store, root, rel, st, maxBytes);
    manifest.files[rel] = entry;
    if (prev && prev.ref !== undefined && prev.ref === entry.ref) continue; // touch, same bytes
    const bothCaptured =
      entry.ref !== undefined && (prev === undefined || prev.ref !== undefined);
    deltas.push({
      path: rel,
      op: prev ? "modify" : "create",
      before_ref: prev?.ref,
      after_ref: entry.ref,
      size_before: prev?.size,
      size_after: entry.size,
      partial: !bothCaptured,
    });
  }
  for (const rel of Object.keys(manifest.files)) {
    if (scanned.has(rel)) continue;
    const prev = manifest.files[rel]!;
    delete manifest.files[rel];
    deltas.push({
      path: rel,
      op: "delete",
      before_ref: prev.ref,
      size_before: prev.size,
      partial: prev.ref === undefined,
    });
  }

  await saveManifest(dir, root, manifest);

  if (deltas.length > 0 && payload.session_id && payload.tool_name) {
    const stash = await loadStash(dir);
    stash.push({
      id: `cap_${createHash("sha256").update(`${payload.session_id}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16)}`,
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      cwd: root,
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      observed_at: new Date().toISOString(),
      attempts: 0,
      deltas,
    });
    await saveStash(dir, stash);
  }

  const drained = await drainStash(store, opts);
  return { root, observed: deltas.length, drained };
}

/**
 * Try to attribute every pending stash record to its step and insert
 * FileChange rows. Safe to call any time; each record retries until
 * the transcript catches up or the TTL expires.
 */
export async function drainStash(
  store: Store,
  opts: CaptureOptions = {},
): Promise<DrainResult> {
  const dir = stateDir(opts);
  const ttl = opts.stashTtlMs ?? DEFAULT_STASH_TTL_MS;
  const ingest = opts.ingest ?? defaultIngest;
  const stash = await loadStash(dir);
  if (stash.length === 0) return { inserted: [], pending: 0, expired: 0 };

  const inserted: FileChange[] = [];
  const remaining: StashRecord[] = [];
  let expired = 0;

  for (const record of stash) {
    if (record.transcript_path) {
      try {
        await ingest(store, record.transcript_path);
      } catch {
        // Ingest hiccups (mid-write JSONL, locked file) are retried on
        // the next invocation; never fail the drain over one record.
      }
    }
    const match = findStep(store, record);
    if (!match) {
      const age = Date.now() - new Date(record.observed_at).getTime();
      if (age > ttl) {
        expired += 1; // blobs stay in the store; only attribution is lost
      } else {
        record.attempts += 1;
        remaining.push(record);
      }
      continue;
    }
    inserted.push(...(await insertDeltas(store, record, match)));
  }

  await saveStash(dir, remaining);
  return { inserted, pending: remaining.length, expired };
}

// ─── attribution ─────────────────────────────────────────────────────

/** How a stash record was matched to its step — recorded on the row's
 *  normalizer_notes so consumers can rank trustworthiness. */
export type StepMatchQuality = "exact" | "command" | "temporal";

/** Temporal-tier window: a same-tool step this far in the past can
 *  still claim an otherwise unmatchable observation. Mirrors the stash
 *  TTL — anything older would have expired anyway. */
const TEMPORAL_MATCH_WINDOW_MS = DEFAULT_STASH_TTL_MS;

/**
 * Find the step this record's tool call produced. Three tiers:
 *
 *   1. exact    — canonical tool_input equality.
 *   2. command  — (Bash) the `command` field alone matches; covers
 *                 steps whose input carries extra fields.
 *   3. temporal — same tool_name, nearest in time. Exists for parallel
 *                 tool calls: Claude Code emits sibling calls in ONE
 *                 assistant message, which the step builder collapses
 *                 into a single step carrying only the FIRST call's
 *                 input — the sibling's command matches no step and
 *                 would otherwise expire unattributed. The collapsed
 *                 step IS that sibling's turn, so nearest-in-time is
 *                 the honest destination (quality recorded on the row).
 *
 * Ties break by timestamp closest to the observation; a step stamped
 * after the observation is tolerated up to a small slack.
 */
function findStep(
  store: Store,
  record: StashRecord,
): { run: Run; step: Step; match: StepMatchQuality } | undefined {
  const run = getRunBySessionId(store, record.session_id);
  if (!run) return undefined;
  const observedMs = new Date(record.observed_at).getTime();
  const wantCanonical = canonicalJson(record.tool_input);
  const wantCommand = commandOf(record.tool_input);

  const rank: Record<StepMatchQuality, number> = {
    exact: 3,
    command: 2,
    temporal: 1,
  };
  let best:
    | { step: Step; match: StepMatchQuality; gap: number }
    | undefined;
  for (const step of listSteps(store, run.run_id)) {
    if (step.action.kind !== "tool_call") continue;
    if (step.action.tool_name !== record.tool_name) continue;
    const ts = new Date(step.timestamp).getTime();
    if (ts - observedMs > MATCH_FUTURE_SLACK_MS) continue;
    const gap = Math.abs(observedMs - ts);

    let match: StepMatchQuality;
    if (canonicalJson(step.action.tool_input) === wantCanonical) {
      match = "exact";
    } else if (
      wantCommand !== undefined &&
      commandOf(step.action.tool_input) === wantCommand
    ) {
      match = "command";
    } else if (gap <= TEMPORAL_MATCH_WINDOW_MS) {
      match = "temporal";
    } else {
      continue;
    }

    if (
      !best ||
      rank[match] > rank[best.match] ||
      (rank[match] === rank[best.match] && gap < best.gap)
    ) {
      best = { step, match, gap };
    }
  }
  return best ? { run, step: best.step, match: best.match } : undefined;
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function commandOf(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command: unknown }).command;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

// ─── row insertion ───────────────────────────────────────────────────

async function insertDeltas(
  store: Store,
  record: StashRecord,
  match: { run: Run; step: Step; match: StepMatchQuality },
): Promise<FileChange[]> {
  const { run, step } = match;
  const existing = listFileChanges(store, { stepId: step.step_id });
  let seq = existing.reduce((m, fc) => Math.max(m, fc.sequence + 1), 0);
  const out: FileChange[] = [];

  for (const d of record.deltas) {
    const dup = existing.some(
      (fc) =>
        fc.path === d.path &&
        ((fc.derived_from === "tool_call" && !fc.partial_diff) ||
          (fc.derived_from === "filesystem_watch" &&
            fc.op === d.op &&
            fc.before_blob_ref === d.before_ref &&
            fc.after_blob_ref === d.after_ref)),
    );
    if (dup) continue;

    const notes = {
      attributed_by: "hook",
      match: match.match,
      session_id: record.session_id,
      observed_at: record.observed_at,
    };

    if (d.partial) {
      out.push(
        insertFileChange(store, {
          run_id: run.run_id,
          step_id: step.step_id,
          sequence: seq++,
          tool_call_id: step.action.tool_use_id,
          derived_from: "filesystem_watch",
          path: d.path,
          op: d.op,
          partial_diff: true,
          gitignored: false,
          bom: false,
          size_before: d.size_before,
          size_after: d.size_after,
          lines_added: 0,
          lines_removed: 0,
          redacted: false,
          normalizer_notes: notes,
        }),
      );
      continue;
    }

    const beforeBuf = d.before_ref
      ? await store.blobs.getBuffer(d.before_ref).catch(() => undefined)
      : undefined;
    const afterBuf = d.after_ref
      ? await store.blobs.getBuffer(d.after_ref).catch(() => undefined)
      : undefined;
    out.push(
      insertFileChange(store, {
        run_id: run.run_id,
        step_id: step.step_id,
        sequence: seq++,
        tool_call_id: step.action.tool_use_id,
        derived_from: "filesystem_watch",
        path: d.path,
        op: d.op,
        before_blob_ref: d.before_ref,
        after_blob_ref: d.after_ref,
        partial_diff: false,
        gitignored: false,
        bom: false,
        size_before: d.size_before,
        size_after: d.size_after,
        redacted: false,
        normalizer_notes: notes,
        ...contentRowFields(beforeBuf, afterBuf),
      }),
    );
  }
  return out;
}

// ─── filesystem scan + manifest / stash IO ───────────────────────────

async function scanStats(
  root: string,
  matcher: IgnoreMatcher,
): Promise<Map<string, { size: number; mtime_ms: number }>> {
  const out = new Map<string, { size: number; mtime_ms: number }>();
  const walk = async (dirRel: string): Promise<void> => {
    const dirAbs = dirRel === "" ? root : join(root, dirRel);
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === ".git" || rel.startsWith(".git/")) continue;
        if (matcher.matches(rel, true)) continue;
        await walk(rel);
      } else if (e.isFile()) {
        if (matcher.matches(rel, false)) continue;
        try {
          const s = await stat(join(root, rel));
          out.set(rel, { size: s.size, mtime_ms: Math.trunc(s.mtimeMs) });
        } catch {
          // vanished mid-scan
        }
      }
    }
  };
  await walk("");
  return out;
}

async function readEntry(
  store: Store,
  root: string,
  rel: string,
  st: { size: number; mtime_ms: number },
  maxBytes: number,
): Promise<ManifestEntry> {
  if (st.size > maxBytes) return { size: st.size, mtime_ms: st.mtime_ms };
  try {
    const buf = await readFile(join(root, rel));
    const ref = await store.blobs.putBuffer(buf);
    return { size: st.size, mtime_ms: st.mtime_ms, ref };
  } catch {
    return { size: st.size, mtime_ms: st.mtime_ms };
  }
}

async function buildManifest(
  store: Store,
  root: string,
  matcher: IgnoreMatcher,
  maxBytes: number,
): Promise<Manifest> {
  const scanned = await scanStats(root, matcher);
  const files: Record<string, ManifestEntry> = {};
  for (const [rel, st] of scanned) {
    files[rel] = await readEntry(store, root, rel, st, maxBytes);
  }
  return { root, updated_at: new Date().toISOString(), files };
}

function stateDir(opts: CaptureOptions): string {
  const dir = opts.stateDir ?? join(meterHome(), "capture");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(dir: string, root: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(dir, `manifest-${key}.json`);
}

async function loadManifest(
  dir: string,
  root: string,
): Promise<Manifest | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(manifestPath(dir, root), "utf-8"),
    ) as Manifest;
    // Root mismatch would mean a hash collision or hand-edited file —
    // rebuild rather than diff against the wrong tree.
    return parsed.root === root ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function saveManifest(
  dir: string,
  root: string,
  manifest: Manifest,
): Promise<void> {
  manifest.updated_at = new Date().toISOString();
  await writeAtomic(manifestPath(dir, root), JSON.stringify(manifest));
}

function stashPath(dir: string): string {
  return join(dir, "pending.json");
}

async function loadStash(dir: string): Promise<StashRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(stashPath(dir), "utf-8"));
    return Array.isArray(parsed) ? (parsed as StashRecord[]) : [];
  } catch {
    return [];
  }
}

async function saveStash(dir: string, stash: StashRecord[]): Promise<void> {
  await writeAtomic(stashPath(dir), JSON.stringify(stash));
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}

async function defaultIngest(store: Store, transcriptPath: string): Promise<unknown> {
  return ingestSession(store, transcriptPath);
}
