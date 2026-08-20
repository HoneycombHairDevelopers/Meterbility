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

## Diff / Alignment (semantic trajectory diff, eng-reviewed 2026-08-13)

### Post-ship calibration milestone: 20 real hand-marked pairs
**Priority:** P2
The semantic-diff ship gate evaluates ≤15% misalignment on synthetic
fixtures + 2 hand-marked real pairs; the Codex falsifier needs 20 real
pairs to be meaningful. Accumulate dogfood run pairs, hand-mark expected
`step_id_a ↔ step_id_b` alignments (format in the design doc's
Dependencies: JSON per pair; one-to-many edits marked `unalignable` and
excluded from the denominator), re-run the calibration harness at 20.
Target ≤10%, hard gate ≤15%. Depends on: shipped aligner.

### Context-snapshot similarity tiering (first fuzzy plugin)
**Priority:** P3
`classify()` compares `context_snapshot_id` by identity — near-identical
contexts diff the same as unrelated ones (parked by design premise 1).
Implement as the first ScoringFn plugin over the aligner's pluggable
scoring interface: graded context similarity feeding `context_diff`
tiering. Depends on: shipped aligner + plugin interface.

### Cost/token-weighted alignment_score
**Priority:** P3
v1 scores `(matched + 0.5·changed) / max(|A|,|B|)` with uniform step
weights; an expensive divergent step should move the parity score more
than a trivial one. Weight by per-step cost/token share once the
eval-harness `trajectory_alignment` assertion consumes the score
(epic child #5). Depends on: shipped v2 score.

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

## Live capture front door (meter live — design doc docs/designs/meter-live-front-door.md)

### Approach C: hook-ensured auto-capture
**Priority:** P2
Eliminate the forgetting failure entirely: the already-installed hook plane
auto-spawns a detached ingest+sentinel process on the first tool call of a
session; `meter live` becomes a pure viewer attaching to capture that is
already happening. Deferred twice (office-hours D9, eng review D1) to stay
out of the sell-track demo window. Consent posture settled: explicit consent
at `meter init --hooks` time, automation at run-time — no silent always-on
daemon. The `live.heartbeat` settings row + viewer-guard shipped with
`meter live` is the designed insertion point (auto-spawned capture holds the
heartbeat; viewers attach). Constraints to solve before building: hook
timeout budget (never block the agent's tool call), orphan-process cleanup,
multi-project contention. Depends on: `meter live` shipped and dogfooded.

### Nudge-query covering index (conditional)
**Priority:** P3
The hook-nudge existence check filters `file_change` by
`derived_from` + `created_at` (`LIMIT 1`) on every human CLI invocation with
no covering index. Deliberately deferred: cheap at current scale. Trigger:
add the index if the check exceeds ~10ms in CLI startup profiling at scale.
Depends on: nudge shipped.

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

## Adapters (GitHub Copilot + fleet lineage — design doc docs/designs/copilot-squad-adapter.md, eng-reviewed 2026-08-19)

### Claude Code Task-subagent carving retrofit
**Priority:** P2
Retrofit the v6 lineage (`parent_run_id`/`parent_run_step_id`) + carve
pattern onto the Claude Code adapter so `Task` sub-agents become child
runs. `adapters/claude-code/src/file_changes.ts:40` already punts
sub-agent attribution "to v0.5+ when sub-agents become first-class" —
the Copilot adapter makes them first-class; this closes the same gap
for the largest existing data source and unifies the fleet view across
vendors. Reuses the v6 columns and carve/aggregation policy verbatim.
Care: touches the most battle-tested adapter; needs its own regression
pass (byte-identical re-ingest of existing transcripts).
**Depends on:** copilot-squad-adapter M1-M2 shipping first.

### Copilot adapter phase-2 follow-ons (deliberate deferrals)
**Priority:** P3
Umbrella for the channels explicitly deferred by the design doc — see
its "Phased follow-ons" + "NOT in scope" sections for rationale:
- VS Code chatSessions ingest (whole-doc JSON, no usage data)
- Org/enterprise billing puller + day-level reconciliation annotations
- Replay/fork over carved child runs (lineage-only in v6; fork.ts
  rejects via derived rule)
- Squad sidecar annotations + watch-mode wave grouping — gated on the
  Brady falsifier checkpoint outcome (premise 5 of the design doc)
These are intentional deferrals, not omissions; split into own entries
when picked up.

## Cost / pricing (multi-upstream `cost:unpriced` semantics — design doc docs/designs/proxy-multi-upstream.md)

### Budget gates must not silently pass unpriced runs
**Priority:** P1
`regression.ts`'s `max_cost_cents` assertion compares against the stored
`cost_cents`, and an unpriced run stores 0 by construction — so a budget
gate of "fail over $5" PASSES a run of arbitrary open-model spend. That
inverts the gate's purpose exactly when cost is least known. Decide the
semantic (recommended: an unpriced run FAILS any `max_cost_cents`
assertion with a distinct "cost unknown" verdict, so operators must
either price the model or drop the gate), then implement in the
assertion evaluator + a regression-suite test. The run-level signal is
the `cost:unpriced` tag (and per-step tags). Deliberately deferred from
the multi-upstream ship (eng review D4, 2026-08-20): changing verdict
semantics deserves its own reviewed change, not a mid-ship patch.

### Mixed priced+unpriced runs display only "unpriced"
**Priority:** P1
A run mixing priced Claude steps with even one unpriced open-model step
carries `cost:unpriced` on the run row, so every cost surface (web run
rows, fleet cards, run header, `meter list`, `meter inspect`) renders
"unpriced" — hiding real accumulated Anthropic/OpenAI spend the store
has already computed. Decide the display grammar (candidate: "≥ $X +
unpriced" where $X sums the priced steps; the run total already equals
that sum since unpriced steps contribute 0), then update `costEl`/
`runSummaryLine`/`printRunHeader` together so the surfaces can't drift.
Needs a small design pass first — the "≥" framing changes what the
number claims. Deferred from the multi-upstream ship (eng review D4,
2026-08-20) as a product decision, not a correctness fix.

## Tests (nice-to-have gaps from ship review)

### Remaining specialist-flagged test gaps
**Priority:** P3
Ingest-failure drain retry, future-slack rejection, sealed-run
files:changed re-fire, sentinel:error emission, client refreshStepCard
Playwright e2e, `capture post/drain` + garbage-stdin CLI tests,
blockquote/hr markdown styling.

## Completed
