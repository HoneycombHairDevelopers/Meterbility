# TODOS

Deferred work, organized by component then priority (P0 highest).
Completed items move to the bottom with their landing version.

## Capture (hook + sentinel)

### Concurrent pre folds a sibling's in-flight writes
**Priority:** P2
Parallel Bash calls: call B's `pre` can classify call A's still-executing
writes as ambient and fold them into the manifest baseline without a
record — total loss of exact capture for that overlap (red-team finding,
v0.5.0 ship). Fix sketch: per-session in-flight marker written by `pre`,
removed by `post`; a `pre` that sees a live marker stashes its folded
diffs as an unattributed record instead of absorbing them.

### Symlink changes are invisible to the scanners
**Priority:** P2
`scanStats` and the sentinel walkers only handle `isFile()`/`isDirectory()`
dirents; symlink create/retarget/delete produces no row (the sentinel's
event path now safely SKIPS non-regular files, but skipping ≠ recording).
Emit `partial_diff` stub rows keyed on lstat + target string so the FACT
of a symlink change is preserved.

### Orphan blob accumulation — needs `meter db gc`
**Priority:** P2
Pre-fold refreshes, expired stash records, and deduped sentinel events
all write blobs no row ever references. Content addressing bounds
duplicates but distinct intermediate states accumulate forever.
Reference-count against file_change/baseline/context tables and add a
`meter db gc` command.

### Step-level tool_input still carries sensitive content
**Priority:** P2
Sensitive-path suppression covers the FileChange row (blobs, patch,
source_tool_input), but `steps.action_json` retains the full Write body /
Edit strings, as does the raw transcript. Deciding whether to scrub the
step record is a product call — the transcript on disk has the content
regardless.

### mtime-granularity blind spot in the stat scan
**Priority:** P3
Same-size in-place edits inside one filesystem timestamp tick are
invisible to the hook path's (size, mtime) comparison. Consider
confirming equal-size entries by content hash when mtime is within
granularity, or storing ctime/inode.

### Cold-prime latency on very large repos
**Priority:** P3
First hooked Bash call pays the full-tree read (now checkpointed every
250 files so it resumes across hook timeouts, but each call still burns
its timeout until complete). Consider priming at `meter init --hooks`
time or a stat-only first pass with lazy content blobbing.

## Server (live / web)

### fcCounts map never pruned
**Priority:** P3
`LiveInspector.fcCounts` (step_id → announced row count) grows for the
process lifetime. Evict entries for runs that leave the arrival-scan
window.

### insertStep upsert can throw on sequence-shifted re-ingest
**Priority:** P3
`ON CONFLICT(step_id) DO UPDATE SET sequence=excluded.sequence` can
violate UNIQUE(run_id, sequence) if a rewritten transcript reorders
steps; the step-insert loop in the adapter is unwrapped, so one shifted
step would abort that session's ingest each tick. Remaining scope:
Claude Code adapter only — the Cursor adapter now detects shifts and
resolves them two-phase (vacate sequences via offset, upsert, trim
tail) inside one transaction. Wrap claude-code's loop per-row like the
file_change loop or port the same two-phase rebuild.

### LiveInspector poll does O(table) work per tick at rest
**Priority:** P3
Every 1.5s tick re-scans session files and runs the `file_change`
GROUP BY arrival query (`live.ts:465`) regardless of activity; cost
grows with table size and runs forever on an idle team server. After
the team-MVP's ingest-triggered eventing (eng review 2026-08-04, D3=3B)
is verified in a pilot, the poll is only a fallback: add an incremental
cursor (only rows past last-seen id) and adaptive interval backoff when
eventing is healthy. Blocked by: eventing landing and proving out —
do not touch the live path during the demo window.

## Server (live / web) — cont.

### Live step append protocol assumes contiguous sequences
**Priority:** P2
`html.ts:1743` (`appendStepsUpTo`) walks `seq = step_count` upward and
fetches step-card fragments one sequence at a time — it wedges when
reserved-band steps exist (hooks 100k / admin 200k / checkpoints 300k)
because `step_count` counts them but the walk never reaches their
sequences. Latent until Cursor joins eventing. Fix: fetch by explicit
sequence list or an `after=<cursor>` param instead of assuming
contiguity.

### Incremental Codex ingest state
**Priority:** P2
Every live tick on a growing Codex rollout still rebuilds the full
session (O(n) buildSteps + O(n²)-ish snapshot hashing as history
grows). This ship landed parse-once (single file read) and the
idle-tail gate (chatter-only appends skip the rebuild) as mitigation;
the real fix is persisted incremental state: carry (history refs,
sequence, prevStepId, model) across ticks keyed on the ingest offset.

### Local-vs-admin usage double-count policy
**Priority:** P2
Theoretical until Cursor persists local `usageData`: if the bubble walk
ever starts carrying real token counts AND the Admin API puller is
configured, the same request would be counted in both the walk step and
the admin band step, doubling run totals. Define precedence (admin wins;
zero out walk-step tokens? tag one plane `usage:shadow`?) before
enabling both.

### Hook hot-path updateRunTotals
**Priority:** P3
Every Cursor hook event runs `updateRunTotals` — a full-run aggregation
over all steps — on the hot path of the user's editor. Skip it for
zero-token hook steps or switch to increment-only updates.

### Prepared-statement caching
**Priority:** P3
Adapters call `store.db.prepare()` inside per-row loops (file_change
existence guards, band sequence counts). better-sqlite3 caches by
source string but a per-Store statement cache (prepare once, reuse)
would make the hot loops allocation-free.

### Proxy cwd header is advisory
**Priority:** P3
`x-meterbility-cwd` is caller-supplied and used for project identity —
a header can attach runs to an existing project the caller doesn't own.
Acceptable for the loopback-bind default; revisit (allowlist or
project-scoped tokens) before the team server binds non-loopback.

## Refactors (DRY)

### Shared helpers for the two capture paths
**Priority:** P3
Cross-adapter duplication has grown past the original capture-path pair:
- `toRepoRelative` — 5 copies (claude-code/file_changes.ts,
  codex-cli/ingest.ts, cursor/hooks.ts, cursor/extras.ts, plus the
  collector/baseline.ts variant).
- `countLines` — 5 copies (claude-code/file_changes.ts,
  codex-cli/ingest.ts, cursor/file_changes.ts, cursor/hooks.ts,
  collector capture path).
- `parseMaybeJson` — duplicated in cursor/file_changes.ts and
  cursor/ingest.ts.
- `diffLines` — cursor imports it from `@meterbility/claude-code-adapter`,
  a cross-adapter dependency that belongs in shared.
- The synthetic-step scaffold (blob snapshot + decision ref +
  nextSequenceInBand + insertStep + tags) is triplicated across cursor
  hooks.ts / admin_api.ts / extras.ts.
- Raw SQL in adapters that wants collector helpers: run-tag rewrite
  (`replaceRunTag`), step/file_change existence guards (`stepExists`,
  `fileChangeExists`).
Also still open from capture: the recursive walk skeleton and the test
scaffold (hook_capture.test.ts / file_sentinel.test.ts); dedup predicate
+ sequence seeding are shared via `insertWatchRow` — finish with a
shared `walkTree` and a capture-test-utils module.

## Tests (nice-to-have gaps from ship review)

### Remaining specialist-flagged test gaps
**Priority:** P3
Ingest-failure drain retry, future-slack rejection, sealed-run
files:changed re-fire, sentinel:error emission, client refreshStepCard
Playwright e2e, `capture post/drain` + garbage-stdin CLI tests,
blockquote/hr markdown styling.

## Completed
