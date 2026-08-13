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
Sensitive-path suppression covers the FileChange row, and as of
v0.5.1 the inline capture planes (cursor/codex patch_text and
source_tool_input) run through redactString — but `steps.action_json`
still retains the full Write body / Edit strings across all adapters
(incl. the new cursor hook shell commands), as does the raw transcript. Deciding whether to scrub the
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

### INVESTIGATE: Terminal-status authority between capture planes
**Priority:** P3
A hook-sealed terminal status (`stop` → error/abandoned) can be
overwritten to `ok` by a later composer-DB read claiming `completed` —
the reconciliation guard only prevents terminal→in_progress downgrades,
not terminal-vs-terminal disagreements. Define which plane wins when
both claim a (different) terminal status: the hook plane observed the
stop in real time, the composer row is Cursor's own retrospective
verdict. Likely answer: hook wins for error/abandoned; needs a decision
plus a guard in setRunStatus's call sites.

### INVESTIGATE: Codex offset-based step identity assumes append-only rollouts
**Priority:** P3
Codex step ids hash (run_id, record byte offset). An upstream rollout
rewrite/compaction shifts every offset, so re-ingest would mint new
step ids at already-occupied sequences and crash-loop that session's
ingest on UNIQUE(run_id, sequence). Not yet observed in real rollouts
(they are append-as-you-go), but if it ever fires in practice, add a
catch-and-rebuild guard like the Cursor adapter's reconciliation
(vacate via offset, upsert, trim tail) instead of letting the tick
loop error forever.

### Proxy cwd header is advisory
**Priority:** P3
`x-meterbility-cwd` is caller-supplied and used for project identity —
a header can attach runs to an existing project the caller doesn't own.
Acceptable for the loopback-bind default; revisit (allowlist or
project-scoped tokens) before the team server binds non-loopback.

## Live Probe (cross-runtime pause)

Today only the SDKs acknowledge the probe protocol, so Pause is gated
to sdk-ts/sdk-py runs (v0.5.1). Hook systems make a real pause feasible
for the IDE runtimes: the pre-tool hook polls the probe file and holds
before answering, yielding pause-between-tool-calls (the closest analog
to the SDK's pause-between-model-calls). Shared prerequisites for all
three: a probe reader in the hook path (shared/src/probe.ts already
exports readState/confirmPaused), a hold loop with a hard cap well
under the host's hook timeout, `run:paused`/`run:resumed` emission via
the existing live poller, and probe-panel gating extended per-runtime
as each lands. Injection is explicitly out of scope for hook-based
pause v1 (no way to add a message to the host's context; only delay).

### Claude Code pause via PreToolUse hook
**Priority:** P3
`meter capture pre` already runs as the PreToolUse hook
(packages/server/src/hook_capture.ts, installed by `meter init
--hooks`). Extend it (or a sibling `meter probe-hold` command chained
in settings.json) to check `probeFilePath(runId)` and hold while state
is pause_requested/paused. CRITICAL constraint: never exit 2 (that
BLOCKS the tool call — same footgun documented in capture.ts) and
never exceed Claude Code's hook timeout — cap the hold and re-arm on
the next tool call so a long pause degrades to "crawl" rather than a
hook kill. Attribution via session_id → getRunBySessionId is already
solved by hook_capture.

### Cursor pause via beforeShellExecution / beforeMCPExecution hooks
**Priority:** P3
`meter cursor-hook` already receives blocking permission events
(beforeShellExecution, beforeMCPExecution, beforeReadFile). A pause
mode would poll the probe file before answering `{continue: true}`.
Two design conflicts to resolve first: (1) v0.5.1 deliberately answers
BEFORE persistence and fails open so capture never stalls the editor —
pause mode inverts that, so it must be opt-in (e.g. only hold when a
probe file exists for the joined run) and keep the no-permission-vote
contract when releasing; (2) hook timeout budget is undocumented —
measure before shipping. Only tool-shaped work pauses (pure text
generation has no before* hook).

### Codex pause via [hooks] — verify blocking semantics first
**Priority:** P3
Codex config exposes `[hooks]` tables and `notify`. UNVERIFIED whether
its hooks can block/delay tool execution or are fire-and-forget
notifications — if fire-and-forget, pause is not possible and this
entry converts to "document as vendor-withheld" (probe panel stays
hidden for codex-cli). Verify against a current CLI before any design:
capture a session with a slow hook installed and observe whether tool
execution waits.

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
