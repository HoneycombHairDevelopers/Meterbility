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

## Refactors (DRY)

### Shared helpers for the two capture paths
**Priority:** P3
`countLines` (3 copies), the recursive walk skeleton, and the test
scaffold (hook_capture.test.ts / file_sentinel.test.ts) are duplicated.
The dedup predicate + sequence seeding are now shared via
`insertWatchRow`; finish the job with a shared `walkTree` and a
capture-test-utils module.

## Tests (nice-to-have gaps from ship review)

### Remaining specialist-flagged test gaps
**Priority:** P3
Ingest-failure drain retry, future-slack rejection, sealed-run
files:changed re-fire, sentinel:error emission, client refreshStepCard
Playwright e2e, `capture post/drain` + garbage-stdin CLI tests,
blockquote/hr markdown styling.

## Completed
