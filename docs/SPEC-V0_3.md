# Spool — v0.3 Milestone Spec

> **What this is.** The forward-looking spec for the v0.3 milestone. Three
> things ship together, scoped responsibly: (1) Claude-Code-hook file-change
> capture, (2) Live Probe (the pause-inject-resume primitive carried over
> from v0.2 debt), (3) a public OSS launch as the forcing function.
> Everything else (cross-vendor file capture, fork integration, diff lane)
> defers to v0.4 / v0.5 / v1 on the schedule in §13.
>
> **What it isn't.** A vision doc — that's [`SPEC.md`](../SPEC.md), preserved
> unchanged. An as-built doc — that's [`SPEC-V0_2.md`](../SPEC-V0.2.md). When
> v0.3 ships, fold the deltas into a new `SPEC-V0_3.md` in the same shape as
> v0.2.
>
> **Status.** Spec — pre-build. Approval gate before any migration lands.
> Three predecessors gate work:
> 1. v0.2 cap-stone audit complete (it is — §1 below).
> 2. `BlobStore.putBuffer` binary-safety fix landed (PR 1, see §3.2).
> 3. v0.3 scope and milestone phasing approved (this doc).
>
> **Audience.** Anyone implementing v0.3, anyone reviewing v0.3 PRs, anyone
> proposing a change to the data model, capture pipeline, or UI primitives
> during the v0.3 cycle.

---

## Table of Contents

1. [Where v0.2 actually landed](#1-where-v02-actually-landed)
2. [What v0.3 is — and what it deliberately isn't](#2-what-v03-is--and-what-it-deliberately-isnt)
3. [Feature 1 — Step-by-step code changes (Claude-Code-hook only)](#3-feature-1--step-by-step-code-changes-claude-code-hook-only)
4. [Feature 2 — Live Probe (paying down v0.2 debt)](#4-feature-2--live-probe-paying-down-v02-debt)
5. [Feature 3 — Public OSS launch (the forcing function)](#5-feature-3--public-oss-launch-the-forcing-function)
6. [Data model deltas](#6-data-model-deltas)
7. [CLI surface](#7-cli-surface)
8. [Web UI surface](#8-web-ui-surface)
9. [Cerulean tokens used](#9-cerulean-tokens-used)
10. [Security + privacy](#10-security--privacy)
11. [Performance + limits](#11-performance--limits)
12. [Trace format v0.3 deltas](#12-trace-format-v03-deltas)
13. [Milestone phasing — v0.3 → v1](#13-milestone-phasing--v03--v1)
14. [Open questions](#14-open-questions)
15. [Decisions journal](#15-decisions-journal)
16. [Glossary additions](#16-glossary-additions)

---

## 1. Where v0.2 actually landed

The audit (run against `SPEC.md` §19–22) showed:

- **v0 + v0.1 shipped completely.** Every line item.
- **v0.2 shipped with substitutions.** Python SDK ✓, cost surfacing ✓, but
  the rest of the original v0.2 list (LangChain adapter, Vercel adapter,
  sandbox templates, team tier, Live Probe, cost dashboards, OSS launch)
  didn't ship as written.
- **v0.2 added what the original SPEC didn't anticipate.** Proxy capture,
  `spool run -- <cmd>`, multi-step fork continuation, Cerulean design system,
  Anthropic 5m/1h cache split, settings table + page, resolved-context
  viewer, run sealing, and a clutch of CLI quality-of-life (`spool watch`,
  `spool open`, `spool config`, `spool doctor --json`).

Two outright wins from those substitutions:

- **Proxy > LangChain/Vercel adapters.** One piece of code replaces N
  framework-specific adapters and obsoletes a whole category of roadmap
  work. Strict win, not substitution.
- **Cerulean + QoL > more language SDKs + sandbox templates.** Design
  system is load-bearing for every future visual feature. QoL is what
  separates "works in demo" from "works daily."

One real omission worth naming:

- **Live Probe is still owed.** Sandbox templates and team tier are
  deferrable — neither is critical-path for what Spool is for. Live
  Probe is different. Pause-inject-resume is the only primitive on the
  original v0.2 list that's a *debugger primitive* in the DevTools
  sense; fork is great for post-hoc analysis but Live Probe is the
  breakpoint equivalent that makes DevTools DevTools. That's why it
  lands in v0.3 alongside file capture, not in v0.4 with everything
  else.

**Single label for v0.2:** "shipped with the capture story rewritten and
the productionization story still owed." v0.3 starts paying down the
second half.

---

## 2. What v0.3 is — and what it deliberately isn't

### 2.1 Shape

Three ships, in priority order:

| # | Feature | Why now | Estimated effort |
|---|---|---|---|
| 1 | Claude-Code-hook file-change capture | Coding agents are the dominant Spool user; "what did the agent actually do to my code?" is the single biggest inspection gap | 4 weeks |
| 2 | Live Probe (pause + inject + resume) | Closes v0.2's only real debugger-primitive debt; turns Spool from post-hoc inspector into actual debugger | 2 weeks |
| 3 | Public OSS launch | Forcing function for productionization debt the team has stopped seeing | 2 weeks |

Estimated total: **8 weeks**, parallelizable across feature 1 and
features 2/3 once feature 1's schema migration is approved.

### 2.2 Scope discipline — what's in this milestone and what isn't

This spec consolidates feedback from the Codex audit on the broader v0.3
draft. Cut hard on day one rather than chasing scope mid-cycle:

**In scope for v0.3:**

- Claude Code hook adapter file-change capture (Edit, MultiEdit, Write,
  NotebookEdit). Bash stubs with `partial_diff = true`.
- New schema: `file_change`, `baseline_tree`, `runs.baseline_tree_id`.
  Full enum coverage in DDL even where v0.3 only fires a subset, because
  SQLite CHECK constraints aren't cheap to migrate later (v0.2 §17:
  additive-only).
- Lazy baseline tree capture + `working_tree_at(run, step)` function.
  No working-tree panel UI yet.
- Files tab on the step card, `/runs/:run_id/files` page, `spool files` CLI.
- Live Probe: pause / inject context / resume for SDK-instrumented runs.
- Public OSS launch: license, contributing docs, public repo, install
  story for strangers.
- Trace format `0.3.0`, additive.
- `BlobStore.putBuffer` binary-safety fix (PR 1 — ships before
  anything else).

**Out of scope for v0.3, scheduled per §13:**

- Codex CLI file capture → v0.4
- SDK file-capture helpers → v0.4
- Proxy partial-fidelity file capture → v0.4
- File-watcher daemon (Bash side effects) → v0.4
- Fork `edit_file` edit type → v0.5
- Trajectory diff `file_tree` lane → v0.5
- Working-tree scrubber + scope toggles → v0.5

**Explicitly not built in any near milestone:**

- Spool's own AI edit tool. Spool is a debugger, not an agent.
- A third patch format. Unified diff + V4A parsing covers everything.
- A merge engine. Sequential single-actor semantics are sufficient.
- A live filesystem overlay (Shadow Workspace style). Cursor tried,
  Cursor deprecated.
- Reimplementing `/rewind` (Claude Code) or the review pane (Codex).
  Those exist upstream. Spool's value is cross-run comparison,
  trajectory replay, and fork — which neither upstream tool does.

### 2.3 Success criteria

What "v0.3 shipped" means, all three features:

**File capture:**

- Schema migration applies cleanly on every existing local store.
  Additive-only per v0.2 §17. No destructive changes.
- Claude Code hook adapter produces `FileChange` rows for every modifying
  step on every test corpus in `fixtures/claude-code/`. Attribution is
  exact for Edit/MultiEdit/Write/NotebookEdit; Bash steps emit stub rows
  with `partial_diff = true`.
- Binary blobs (PNG, .woff2, package-lock.json, compiled artifacts) round-
  trip through `BlobStore.putBuffer` without corruption. Test fixtures
  cover each format.
- Files tab renders for every coding-agent run in the test corpora;
  binary files show "binary changed" without rendering bytes; redacted
  files show the redaction marker.
- `spool files <run-id>` prints git-status-style summary, exits 0.

**Live Probe:**

- An SDK-instrumented run pauses on demand. While paused: a context
  edit (system prompt, message append, tool toggle) can be applied.
  Resume re-emits the next model call with the edited context. The
  step records the probe edit as a first-class annotation.
- CLI: `spool probe <run-id> --pause`, `--inject <type> --payload-file`,
  `--resume`.
- Web: pause/inject/resume controls on the live run page for SDK-mode
  runs only. Proxy and hook modes show "Live Probe unavailable for
  this capture mode" with a link to docs.

**OSS launch:**

- Public GitHub repo with MIT license. Issues enabled. Contributing.md.
- `npm install -g @spool/cli && spool web` works on a fresh
  Node 20+ machine with no Spool-internal knowledge.
- README has a < 5-minute "first run captured" path that doesn't require
  reading more than the README.
- A "fresh laptop install" test runs in CI on macOS and Linux against
  every released version.
- 76+ existing tests pass; new tests cover schema migration idempotency,
  the FileChange normalizer for Claude Code, working-tree-at(step)
  replay, redaction on capture, Live Probe pause-inject-resume cycle.

---

## 3. Feature 1 — Step-by-step code changes (Claude-Code-hook only)

### 3.1 The architectural calls

These three are non-obvious enough to deserve naming, and they're what
everything else falls out of.

#### 3.1.1 Snapshot per modifying step, not patch chains

| | Snapshot per step | Forward patch replay |
|---|---|---|
| Storage cost | O(unique blobs); SHA dedup recovers ~95% on real codebases | O(patches); smaller absolutely but no cross-run dedup |
| Compute to view step N | O(touched_paths) lookup | O(N) patch applications |
| Correctness vs non-determinism | Always correct (we recorded the actual bytes) | Drifts if a patch fails to apply mid-replay |
| Plays well with `fork` | Free — fork inherits the materialized tree at fork-step | Requires re-running the patch chain |

Snapshot per step + content addressing wins on every axis. This is the
same trade git itself made (objects content-addressed, diffs computed
on demand) and what Claude Code does internally with its
`~/.claude/file-history/` store. The `patch_text` field on each
`FileChange` is a *cached derived artifact*, not the source of truth.

#### 3.1.2 First-class `file_change` row, not JSON on `Step`

One step can produce many FileChanges. MultiEdit, apply_patch envelopes
with many sections, and Bash with side effects all fan out. Path-keyed
queries are core ("show me every change to src/auth.ts across this
run"). JSON embedding would force re-shred on every read.

Sibling table with foreign key to `step` and indexes on `(run_id,
step_id)`, `(run_id, path)`, `(run_id, path, step_id)`.

#### 3.1.3 OS-level file-watcher is a v0.4 fallback, never the primary

Tool-call inspection captures what the agent *thinks* it changed. A
file watcher captures what the filesystem *actually saw*. They differ
in the presence of Bash.

| | Tool-call inspection | File watcher |
|---|---|---|
| Catches `Edit` / `MultiEdit` / `Write` / `apply_patch` | yes | yes |
| Catches `sed`, `mv`, `npm install`, build scripts | no | yes |
| Attribution | exact | heuristic (temporal proximity) |
| Noise | none | high; needs `.spoolignore` |
| Cross-platform | yes | requires per-OS bindings |

In v0.3, tool-call inspection is the only signal. Bash steps emit stub
FileChanges with `partial_diff = true` and a UI flag pointing at v0.4's
watcher. Honest partial > dishonest full.

### 3.2 PR 1 — BlobStore binary safety (ships first)

Standalone PR, no schema, no UI. Lands before any FileChange row is
written.

**The bug.** `BlobStore.putBuffer` always passes through `redactBuffer`,
which calls `.toString("utf-8")` on the bytes. Today no binary blobs
flow through it, so it hasn't bitten — but the moment file capture
ships, every captured PNG, `.woff2`, lockfile, or compiled artifact
gets corrupted byte-by-byte.

**The fix:**

```ts
function isProbablyText(buf: Buffer): boolean {
  // null-byte heuristic in the first 8KB
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return !sample.includes(0);
}

interface PutBufferOptions {
  skipRedact?: boolean;     // caller already knows it's binary or
                            // already-redacted
}

class BlobStore {
  async putBuffer(buf: Buffer, opts: PutBufferOptions = {}): Promise<string> {
    if (opts.skipRedact || !isProbablyText(buf)) {
      // Write bytes verbatim. Encoding metadata travels on the
      // FileChange row, not the blob itself.
      return this.writeVerbatim(buf);
    }
    return this.writeRedacted(buf);   // existing path
  }
}
```

**Tests** in packages/collector/test/blob_store.test.ts:

- 1×1 PNG, ~256-byte ttf, 1 MB random binary, 50 KB UTF-8 source file
  with embedded secrets, 100 KB UTF-16 source file. Every round-trip is
  byte-exact for binary; redacted-as-expected for text.

### 3.3 Data model — new entities

Schema version bumps **3 → 4**. Additive-only.

#### 3.3.1 `file_change`

```sql
CREATE TABLE IF NOT EXISTS file_change (
    file_change_id      TEXT PRIMARY KEY,           -- ULID
    run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id             TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    sequence            INTEGER NOT NULL,           -- intra-step ordering
    tool_call_id        TEXT,                       -- soft FK into action_json.tool_use_id
    derived_from        TEXT NOT NULL
        CHECK (derived_from IN ('tool_call','filesystem_watch','git_diff')),
    path                TEXT NOT NULL,              -- repo-relative, POSIX separators
    old_path            TEXT,                       -- only for op='rename'
    op                  TEXT NOT NULL
        CHECK (op IN ('create','modify','delete','rename','chmod')),
    before_blob_ref     TEXT,                       -- null iff op='create' OR partial
    after_blob_ref      TEXT,                       -- null iff op='delete' OR partial
    partial_diff        INTEGER NOT NULL DEFAULT 0,
    gitignored          INTEGER NOT NULL DEFAULT 0,
    patch_text          TEXT,                       -- cached unified diff
    patch_format        TEXT
        CHECK (patch_format IN ('unified','binary','notebook_cell')
               OR patch_format IS NULL),
    encoding            TEXT,                       -- 'utf-8','utf-16-le','utf-16-be','binary'
    bom                 INTEGER NOT NULL DEFAULT 0,
    line_endings        TEXT,                       -- 'lf','crlf','mixed'
    mime                TEXT,
    language            TEXT,
    size_before         INTEGER,
    size_after          INTEGER,
    line_count_before   INTEGER,
    line_count_after    INTEGER,
    lines_added         INTEGER NOT NULL DEFAULT 0,
    lines_removed       INTEGER NOT NULL DEFAULT 0,
    mode_before         INTEGER,
    mode_after          INTEGER,
    source_tool_name    TEXT,                       -- 'Edit','MultiEdit','apply_patch',…
    source_tool_input   TEXT,                       -- JSON; verbatim, post-redaction
    redacted            INTEGER NOT NULL DEFAULT 0,
    normalizer_notes    TEXT,                       -- JSON; for audit
    created_at          TEXT NOT NULL,
    UNIQUE(step_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_fc_run_step    ON file_change(run_id, step_id);
CREATE INDEX IF NOT EXISTS idx_fc_run_path    ON file_change(run_id, path);
CREATE INDEX IF NOT EXISTS idx_fc_step        ON file_change(step_id);
CREATE INDEX IF NOT EXISTS idx_fc_path_seq    ON file_change(run_id, path, step_id);
```

Full enum coverage in v0.3 even where only `tool_call` and three ops
fire. Adding enum values to a SQLite CHECK constraint later requires
table rebuild, which violates v0.2 §17's additive-only rule. Cheap to
include now, expensive to add later.

#### 3.3.2 `baseline_tree`

Working-tree state at run start, used by the replay algorithm as the
foundation FileChanges layer on top of.

```sql
CREATE TABLE IF NOT EXISTS baseline_tree (
    baseline_tree_id    TEXT PRIMARY KEY,           -- ULID
    project_id          TEXT NOT NULL REFERENCES projects(project_id),
    manifest_blob_ref   TEXT NOT NULL,              -- sha of sorted manifest blob
    git_head            TEXT,                       -- commit SHA if in git repo
    git_dirty           INTEGER NOT NULL DEFAULT 0,
    captured_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_project ON baseline_tree(project_id);
CREATE INDEX IF NOT EXISTS idx_bt_git     ON baseline_tree(project_id, git_head);
```

Manifest format: sorted, newline-delimited records, each
`path\0mode\0blob_ref`, with `\n` as record separator. NUL field
separator means paths with spaces need no escaping; sortedness means
identical trees produce byte-identical manifests and dedup via SHA
naturally.

Manifest blob lives in the regular blob store with `skipRedact: true`
(it's a structured index, not redactable content).

#### 3.3.3 New column on `runs`

```sql
ALTER TABLE runs ADD COLUMN baseline_tree_id TEXT;
```

Nullable. Legacy runs predate the feature; many runs (research,
customer-support agents) never touch a filesystem; coding-agent runs
capture lazily on first FileChange.

### 3.4 Claude Code adapter — file-history-snapshot parsing

Lives at adapters/claude-code/src/file_changes.ts.

Claude Code persists a `file-history-snapshot` JSONL record immediately
before each modifying assistant turn. Its `trackedFileBackups` map
names a `backupFileName` (content-addressed pre-edit blob inside
`~/.claude/file-history/<session-uuid>/`) per file that turn will
modify. A `null` `backupFileName` means the file did not previously
exist.

**Algorithm:**

1. On each `file-history-snapshot` record, for each entry in
   `trackedFileBackups`:
   - Copy `~/.claude/file-history/<session>/<backupFileName>` into the
     Spool blob store (re-hash on read; record `before_blob_ref`).
   - Record path and a pending FileChange (op TBD).
2. On the following `assistant` message, walk its `content[]` blocks.
   For each `tool_use` with name `Edit | MultiEdit | Write | NotebookEdit`:
   - Use the `file-history-snapshot.messageId` linkage to associate the
     tool_use with pending FileChanges.
   - Compute `op`: present-before + present-after → `modify`;
     absent-before + present-after → `create`; present-before +
     absent-after → `delete`.
3. On the following `tool_result`: re-read the file from cwd to compute
   `after_blob_ref`. Diff against `before_blob_ref` for `patch_text`,
   `lines_added`, `lines_removed`.
4. For `Bash` tool_use blocks: emit a single FileChange-stub with
   `partial_diff = true`, `derived_from = "tool_call"`, no blob refs.

**Bug surface to handle** (every one observed in upstream issues):

- `file-history-snapshot.messageId` occasionally collides with a real
  message `uuid`. Use record `type` as the discriminator before keying
  on `messageId`.
- First JSONL line is nondeterministic (sometimes `progress`, sometimes
  `queue-operation`, sometimes `file-history-snapshot`). Never key off
  line 0; iterate to first `summary` or `user`.
- Snapshot bloat on long sessions: dedup at write time via SHA (the blob
  store already does this; essentially free).
- Sub-agent transcripts in `agent-<shortId>.jsonl`. Sub-agent FileChanges
  attach to the **parent step that spawned the Task tool call**.
  Document; revisit when sub-agents become first-class runs.

### 3.5 Baseline tree capture

The first FileChange of a run triggers capture. The collector:

1. Walks the run's cwd, respecting `.spoolignore` + `.gitignore` (§10).
2. Hashes each file's bytes (via existing blob store).
3. Writes the sorted manifest blob.
4. Records the `baseline_tree` row.
5. Writes `baseline_tree_id` onto the run row.

Baselines are content-addressed by manifest blob — two runs against
the same git HEAD share the same baseline. Dominant dedup win.

Git advisory metadata: if cwd is a git repo, record `git_head`
(`git rev-parse HEAD`) and `git_dirty` (any output from
`git status --porcelain`). Both nullable; Spool never depends on git.

### 3.6 Replay algorithm

```py
def working_tree_at(run_id: str, step_seq: int) -> dict[str, str]:
    """Returns {path: blob_ref} for the working tree as it stood at the
    start of step `step_seq` of `run_id`."""
    run = load_run(run_id)
    tree = dict(load_baseline_tree(run.baseline_tree_id))
    # Apply all FileChanges with step.seq < step_seq, ordered by
    # (step.seq ASC, file_change.sequence ASC).
    for fc in iter_file_changes(run_id=run_id, max_step_seq_exclusive=step_seq):
        if fc.op == "delete":
            tree.pop(fc.path, None)
        elif fc.op == "rename":
            tree.pop(fc.old_path, None)
            if fc.after_blob_ref:
                tree[fc.path] = fc.after_blob_ref
        elif fc.op == "chmod":
            pass  # mode-only; manifest tracks separately
        else:  # create | modify
            tree[fc.path] = fc.after_blob_ref
    return tree
```

Complexity: O(touched_paths) per call, given the `idx_fc_run_path`
index. Bounded above by total files modified in the run. Never
O(total_files_in_repo).

Shipped in v0.3 as a library function. No working-tree panel UI yet
(that's v0.5).

### 3.7 What v0.3 doesn't ship

Honest list of file-capture features explicitly deferred:

- **Codex `apply_patch` ingest** (v0.4).
- **Cursor file capture** (v0.4, proxy + watcher only).
- **SDK helpers** `captureFilesystemDeltaDuring`, `WrappedTextEditorTool`,
  `WrappedApplyPatchTool` (v0.4).
- **Proxy file-change partials** (v0.4).
- **File-watcher daemon** for Bash side effects (v0.4).
- **Fork `edit_file` edit type** (v0.5).
- **Trajectory diff `file_tree` lane** (v0.5).
- **Working-tree panel and scrubber** (v0.5).
- **Codex-style scope toggles** ("Last step" / "Since start" / vs.
  parent run) (v0.5).

Each is designed for in the v0.3 schema — full enum values, nullable
columns, additive trace format — so v0.4 / v0.5 are migration-free.

---

## 4. Feature 2 — Live Probe (paying down v0.2 debt)

### 4.1 The primitive

Pause-inject-resume on a running agent. The fork primitive (v0.2 §8) is
post-hoc: it derives a new run from a captured one. Live Probe operates
on the *currently executing* run.

Mental model: a breakpoint that lets you edit the context before the
next model call fires.

### 4.2 Scope discipline

Live Probe only ships for **SDK-mode runs** in v0.3. Proxy and hook
modes are out:

- **SDK mode** (`@spool/agent`, `spool-agent`): Spool owns the loop. The
  SDK can block before the next `tracer.startStep()` call. Pause is real.
- **Hook mode** (Claude Code, Codex, Cursor): Spool is a passive
  observer of someone else's runtime. We can't pause Claude Code from
  outside without interfering with its execution.
- **Proxy mode**: Spool intercepts HTTP. We could in principle delay a
  request, but the upstream LLM call would still fire and there's no
  clean way to mutate the request body without breaking client
  contracts. Deferred.

Web UI for proxy/hook modes shows "Live Probe unavailable for this
capture mode" with a docs link explaining the SDK migration path.
Honest about the limit.

### 4.3 Probe surface

Three operations, all on SDK-instrumented runs:

| Operation | Effect |
|---|---|
| **Pause** | Sets `run.probe_state = "paused"`. Next `tracer.startStep()` blocks until resume. SSE event `run:paused` fires. |
| **Inject** | While paused, apply one of the existing fork edit types: `replace_system_prompt`, `add_context`, `remove_tool`, `modify_tool_description`, `replace_user_message`, `inject_message`, `change_model`. The injection mutates the in-memory context the next step will see. Records as a `probe_edit` annotation on the step that follows resume. |
| **Resume** | Clears `probe_state`. The blocked `startStep()` returns; agent proceeds with the (possibly edited) context. SSE event `run:resumed` fires. |

Multiple injects allowed between pause and resume. Each records
separately on the same step's annotation list.

### 4.4 Why reuse fork edit types

The seven fork edit types (v0.2 §8.1) already cover every meaningful
context mutation. Inventing a parallel "probe edit" enum would
duplicate the surface for no semantic gain.

By reusing them:

- The fork machinery's payload validation works unchanged.
- A probe + resume cycle is structurally equivalent to a `--continue
  live` fork that happens to forward-fork the same run rather than
  branching. (We may eventually unify the two paths; not in v0.3.)
- The diff engine's awareness of edit types extends to probed runs for
  free.

### 4.5 Data model

One new column on `runs` (additive, nullable):

```sql
ALTER TABLE runs ADD COLUMN probe_state TEXT;
-- 'paused' | 'resumed' | NULL. NULL = never probed.
```

Annotations table (v0.2 §5.2) gets two new conventional verdicts:

- `probe_edit` — records the injected edit on the step that follows
  resume. `note` field carries `{edit_type, payload}` as JSON.
- `probe_pause` — records the moment of pause. `note` field is the
  pause-time context snapshot id, so we can render "what did the user
  see when they decided to pause."

No schema migration for annotations — the verdict field is already
free-form text in v0.2.

### 4.6 SDK API surface

**TypeScript:**

```ts
import { SpoolTracer } from "@spool/agent";

const tracer = new SpoolTracer({
  project: "my-app",
  agent: "support",
  probeEnabled: true,        // opt-in; default false for production
});

// In the agent loop:
while (!done) {
  const step = await tracer.startStep({...});   // blocks if paused
  // ...
}
```

`probeEnabled: true` makes `startStep` consult `probe_state` before
proceeding. Default `false` because production agents typically don't
want startup-time uncertainty about whether a probe might fire. Dev/
debug builds opt in.

Python mirrors the same flag on `SpoolTracer`.

### 4.7 CLI

```sh
spool probe <run-id> --pause
spool probe <run-id> --inject add_context --payload-file ctx.json
spool probe <run-id> --inject change_model --payload claude-sonnet-4-6
spool probe <run-id> --resume
spool probe <run-id> --status                # show paused/resumed/none
```

`--pause` and `--resume` are idempotent. `--inject` requires the run to
be paused (4xx if not).

### 4.8 Web UI

On the run detail page for any run with `source_runtime ∈ {sdk-ts,
sdk-py}` AND `status === "in_progress"` AND `probeEnabled === true`:

A **Probe panel** appears beneath the run header. Three states:

- **Idle:** one button, "Pause run." Confirmation prompt warns the
  blocking effect.
- **Paused:** the button becomes "Resume." A secondary section appears
  with an edit-type picker (same dropdown as the fork modal) and a
  payload editor. "Apply edit" stages an injection; multiple can stage
  before resume.
- **Resumed (transient):** flash a mint pill "Resumed with N edits" for
  three seconds, then return to idle.

For runs that don't qualify (wrong source_runtime, not in_progress, or
`probeEnabled = false`), the panel is replaced with a single tertiary-
styled note: "Live Probe is available for SDK runs with probe enabled.
[docs]"

### 4.9 SSE additions

The existing `/api/live` stream (v0.2 §7.1) gains two events:

```ts
| { type: "run:paused"; run_id: string; step_id: string;
    paused_at: string }
| { type: "run:resumed"; run_id: string; edits: number;
    resumed_at: string }
```

`run:paused` carries the step id at which the pause took effect (the
step that *would* have started next). `run:resumed` carries the count
of injected edits since pause.

---

## 5. Feature 3 — Public OSS launch (the forcing function)

### 5.1 Why this is a feature, not a marketing item

OSS launch isn't a go-to-market check-the-box. It's a *forcing function*
for productionization debt the team has stopped seeing. Every assumption
about `~/.claude/projects/<encoded-cwd>/` paths, every implicit cwd,
every place schema diverges from documentation — these surface the
moment a stranger installs Spool on a fresh laptop. Indefinitely
deferring lets debt compound. Date-pinning the launch is what makes it
a forcing function.

**Target: end of v0.3 cycle (week 8 from spec approval).** If the date
slips, it slips with the rest of v0.3, not independently.

### 5.2 Deliverables

| Item | Scope |
|---|---|
| **Public repo** | `github.com/<org>/spool`. MIT license. Issues + Discussions enabled. PR template, issue templates (bug / feature / security). |
| **Install story** | `npm install -g @spool/cli` works on a fresh Node 20+ install. `pip install spool-agent` works in a clean venv. Documented in README; tested in CI on macOS 14+ and Ubuntu 22+. |
| **README** | < 5-minute "first run captured" path. No prior Spool knowledge. Demo gif. Architecture diagram (the v0.2 §13 package map, lightly edited). |
| **CONTRIBUTING.md** | Local dev setup, test commands, coding conventions (TypeScript style, Python style, the additive-only schema rule, the redaction-required-on-blob-write rule, the "one accent color" rule). |
| **SECURITY.md** | Responsible disclosure email, the redaction posture (v0.2 §5.3 + this spec §10.1), the network-bind warning (§10.5). |
| **Docs site or docs/ directory** | Minimum: getting-started, CLI reference, web UI tour, capture modes, design rationale (decisions journal extracted from v0.2 §17 + this spec §15). |
| **Telemetry posture** | Opt-in only, off by default, single env var to disable (`SPOOL_TELEMETRY=off`). Documented in SECURITY.md. v0.3 ships with telemetry stubbed off; actual telemetry deferred. |
| **Versioning + release** | Semver, tagged releases on GitHub, automated npm + PyPI publish on tag. Trace format version (v0.2 §11) becomes part of the public contract. |
| **License audit** | Every dependency MIT/Apache/BSD compatible. SPDX headers on source files. |

### 5.3 What the launch *doesn't* commit to

- **API stability.** v0.3 is pre-1.0. The trace format additive rule
  (v0.2 §17) and the SQLite additive rule continue to apply, but the
  TypeScript/Python public API surface may break minor-version-to-minor
  until 1.0.
- **Hosted backend.** Stays an optional opt-in (the Postgres path, v0.2
  §5.5). Spool is local-first; hosted is for team-tier later.
- **A support SLA.** Issues and Discussions are best-effort.
- **Backward compatibility for in-progress alpha integrations.** People
  who somehow have non-public versions of Spool need to migrate; we
  don't promise to support their forks.

### 5.4 The "fresh laptop" test

Before launch, three reviewers (not Brantley) each take a fresh machine,
follow only the README, and capture their first run. Each files at
least one issue against the docs or install story before the launch is
greenlit. The bug list from this exercise blocks launch.

This is the part the team can't do on its own laptops. Outsource it.

---

## 6. Data model deltas

Consolidating §3 and §4 schema changes:

**New tables:**

- `file_change` — §3.3.1
- `baseline_tree` — §3.3.2

**New columns:**

- `runs.baseline_tree_id TEXT` — §3.3.3 (file capture)
- `runs.probe_state TEXT` — §4.5 (Live Probe)

**Annotations:** no schema change; new conventional verdict values
(`probe_edit`, `probe_pause`) use the existing free-form `verdict`
field per v0.2 §5.2.

**Schema version:** `meta.schema_version` bumps `3 → 4` after successful
migration. Migration is idempotent and gated behind `PRAGMA table_info`
checks per v0.2 §17.

**Postgres mirror** (store-postgres/src/schema.ts) gets the same DDL.

---

## 7. CLI surface

Cross-reference: `SPEC-V0_2.md` §3.

### 7.1 New commands

```sh
spool files <run-id> [--at <step>] [--diff <path>]
                     [--from <step_a> --to <step_b>] [--json]
spool probe <run-id> --pause | --resume | --status
                     | --inject <edit-type> --payload-file <path>
                     | --inject <edit-type> --payload <inline>
spool init                       # scaffolds .spool/config.toml + .spoolignore
```

Default `spool files <run-id>` output:

```text
RUN  01HGX...  (Claude Code · 14 steps · 6 files touched)
  M  src/auth.ts                +14 −2
  M  src/auth.test.ts           +37 −0
  A  src/lib/jwt.ts             +89 −0
  D  src/legacy/auth.js          +0 −89
  R  src/router.ts → src/app.ts  +0 −0
  M  package.json                +2 −0

Final +142 −91  across 6 files
Baseline:  git HEAD a3f1c2e  (clean)
```

`spool files <run-id> --tree <step>` is **deferred to v0.5** when the
working-tree panel UI exists (no UI consumer until then).

### 7.2 Augmentations to existing commands

- **`spool inspect <run-id> --show files`** — new `--show` value alongside
  `decision | action | outcome | cost | context | all`.
- **`spool inspect <run-id> --at <step> --show files --diff`** — render
  unified diff for that step.
- **`spool export`** includes FileChange rows and baseline tree manifest
  refs. **Does not** inline file content blobs unless
  `--include-file-blobs` is passed. Default-off because bug reports get
  shared.

### 7.3 Settings fallback chain extension

Two new keys join the v0.2 §3.7 chain:

| Flag | Setting key | Env var |
|---|---|---|
| `--include-file-blobs` (export) | `export.include_file_blobs` | — |
| `spool probe` SDK probe enable | `probe.enabled_default` | `SPOOL_PROBE_ENABLED` |

---

## 8. Web UI surface

Cross-reference: `SPEC-V0_2.md` §4.

### 8.1 New tab on the Step card

Sibling to Decision / Action / Outcome / Cost / Context, the **Files**
tab shows:

- `+N −M  · K files` summary header.
- A list of FileChange rows: op badge (mint A / amber M / coral D /
  violet R), monospace path, `+N −M` stat, optional `partial` /
  `binary` / `redacted` flag, click to expand.
- Expanded row: unified diff with standard `+`/`−` highlighting, hunk
  headers in cerulean.
- Binary files: badge `binary`, size delta, no diff body.
- Redacted files: badge `redacted`, reason text, no diff body.
- Partial-diff files: badge `partial`, tooltip pointing at `spool watch`
  (v0.4).

### 8.2 Run detail page additions

- **"Files changed in this run"** collapsible section below the step
  list. Flat list of unique paths, cumulative `+N −M`, sparkline of
  which steps touched each file. Click → opens per-file timeline.
- **Probe panel** beneath the run header (§4.8). Conditional on
  source_runtime + status + probeEnabled.

### 8.3 New page: `/runs/:run_id/files`

> **Note (2026-05-22):** spec text was updated from `/files/:run_id` to
> `/runs/:run_id/files` for consistency with the JSON endpoint
> `/api/runs/:id/files` (§8.4) and the run-detail page convention
> (`/runs/:run_id`). The HTML page now lives under the run namespace.

Full-page browse view, no step-list chrome. Two-pane layout:

- Left: file tree at end of run, op badges per file.
- Right: per-file view with tabs:
  - **Final** — syntax-highlighted end-of-run content.
  - **History** — every touch in the run, inline diffs stacked.
  - **Raw** — link to `/api/blob/:hash`.

### 8.4 New JSON API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/runs/:id/files` | summary list of files touched |
| GET | `/api/runs/:id/files/tree?at=<step>` | working-tree manifest at step N |
| GET | `/api/runs/:id/files/diff?path=<p>&from=<s_a>&to=<s_b>` | diff for one path between two steps |
| GET | `/api/steps/:id/file_changes` | FileChanges for one step |
| GET | `/api/file_change/:id` | one FileChange row |
| GET | `/api/blob/:hash/render?lang=<l>` | syntax-highlighted blob (server-side, cached) |
| POST | `/api/runs/:id/probe/pause` | request pause |
| POST | `/api/runs/:id/probe/inject` | body: `{edit_type, payload}` |
| POST | `/api/runs/:id/probe/resume` | resume |
| GET | `/api/runs/:id/probe` | current probe state |

### 8.5 SSE additions

The existing `/api/live` stream gains three event types:

```ts
| { type: "files:changed"; run_id: string; step_id: string;
    paths: string[]; partial: boolean }
| { type: "run:paused"; run_id: string; step_id: string;
    paused_at: string }
| { type: "run:resumed"; run_id: string; edits: number;
    resumed_at: string }
```

---

## 9. Cerulean tokens used

No new color tokens. Files feature stays inside v0.2 §12's semantic
palette:

| Element | Token |
|---|---|
| `create` op badge | `--mint-400` + `--mint-bg` |
| `modify` op badge | `--amber-400` + `--amber-bg` |
| `delete` op badge | `--coral-400` + `--coral-bg` |
| `rename` op badge | `--violet-400` + `--violet-bg` |
| `partial` flag | `--text-tertiary` + `--surface-2` |
| `binary` flag | `--text-secondary` + `--surface-2` |
| `redacted` flag | `--coral-400` border, `--text-secondary` text |
| Diff `+` lines | `--mint-bg` background |
| Diff `−` lines | `--coral-bg` background |
| Hunk header | `--cerulean-400` text |
| File path | `--font-mono`, `--text-primary` |
| Probe panel "paused" state | `--amber-400` border, `--amber-bg` fill |
| Probe panel "resumed" flash | `--mint-400` pill |

**One token added** — same pattern as the existing `*-bg` semantic pairs
(v0.2 §12.1):

```css
--cerulean-bg: rgba(56, 189, 248, 0.08);   /* 8% alpha for selected file row */
```

Stays inside the "one accent color" rule (v0.2 §12.5).

---

## 10. Security + privacy

### 10.1 Redaction extension

The existing redaction pass (v0.2 §5.3) gets two new rules:

- **`env-file`** — paths matching `.env`, `.env.*`, `*.env`,
  `*credentials*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`. Blob
  content replaced with `«spool:redacted:env-file»`.
- **`inline-secret`** — content matches AWS access keys, GitHub PATs,
  Anthropic keys, OpenAI keys, JWT-shaped tokens, RSA private key
  headers, Slack tokens. Replaces just the matched substring; blob
  still readable.

Ruleset in packages/shared/src/redaction/secrets.ts, modeled on
detect-secrets / trufflehog rule sets.

Every firing logs to `redaction_log` per v0.2 behavior. `SPOOL_REDACT=off`
continues to disable globally.

The redaction extension lands **with** the PR 1 binary-safety fix
(§3.2) — they're the same redaction subsystem.

### 10.2 `.spoolignore`

A `.spoolignore` at the repo root is respected by:

- Baseline tree capture (§3.5).
- Tool-call-derived FileChanges — ignored paths get a stub FileChange
  with `redacted = true` and reason `«spool:redacted:spoolignored»`. The
  *existence* of the edit is recorded; the content is not.
- File-watcher events (v0.4) — completely filtered.

**Defaults when no file present:**

```text
# Build artifacts
node_modules/
dist/
build/
.next/
target/
.cache/

# Language-specific
.venv/
__pycache__/
*.pyc

# Version control internals
.git/objects/
.git/logs/

# Editor / OS
.DS_Store
.idea/
.vscode/

# Coverage / tooling
coverage/
.nyc_output/

# Sensitive by default
.env
.env.*
*.pem
*.key
id_rsa*
id_ed25519*
credentials.json
.aws/
.kube/config
```

`.gitignore` is also respected — for file-watcher-derived events only
(v0.4). For tool-call-derived events, the agent presumably had a reason
to touch a gitignored file, so we capture but flag `gitignored = true`
(column already in §3.3.1 DDL).

### 10.3 Repo-level opt-in

.spool/config.toml:

```toml
[capture.files]
enabled = true              # default: false until user opts in
include = ["src/**", "tests/**"]
exclude = ["**/*.snap"]
max_file_size_bytes = 5_242_880
binary_detection = "null-byte-heuristic"
```

When absent or `enabled = false`: FileChange rows still emit (so the
*fact* is recorded) but with `before_blob_ref = after_blob_ref = null`,
`partial_diff = true`, `redacted = true`. UI: "file capture not enabled
for this project."

`spool init` (§7.1) scaffolds both the config and `.spoolignore`.

### 10.4 Trace export defaults

`spool export <run-id>` (v0.2 §3.6) inlines blobs by default for
self-contained traces. **File content blobs are excluded unless
`--include-file-blobs` is passed.**

Reasoning:

- Bug reports get shared. Code shouldn't ship to the bug tracker by
  accident.
- The default `--no-blobs` mode of v0.2 still works for everything else.
- Recipients without blobs still see metadata: paths, ops, line counts,
  patch_text (which itself routes through the redaction pass).

Documented prominently in `spool export --help`.

### 10.5 Network bind warning

When `spool web` binds anywhere other than `127.0.0.1`, the server warns
at startup that file contents are now reachable. `/api/blob/:hash`
requires an auth token (new `web.bind_token` setting) when bound non-locally.

### 10.6 Probe authorization

Live Probe operations require the same local-machine assumption as the
rest of Spool. `POST /api/runs/:id/probe/*` endpoints accept any
request when bound to `127.0.0.1`; require `web.bind_token` when bound
elsewhere. No separate auth model.

---

## 11. Performance + limits

### 11.1 File size policy

| Size | Behavior |
|---|---|
| ≤ 5 MB | Full snapshot (both before and after). Default. |
| > 5 MB and ≤ 50 MB | Patch-only. Store `patch_text`, omit the larger of the two blobs. UI: "file too large for full snapshot." |
| > 50 MB | Skip entirely. Stub FileChange with `redacted` flag. |

Configurable via `capture.files.max_file_size_bytes` in
.spool/config.toml.

### 11.2 Storage cost expectations

Empirical model based on Claude Code's own file-history footprint:

- A typical 5-file edit run on a 10k-LOC repo adds **2–5×** the size of
  touched files in new blob bytes (vs ~50× for naive snapshot-per-step
  without dedup).
- A `package-lock.json`-heavy run: lockfile identical across most
  steps, stored once. Real-world dedup factor on lock-heavy repos:
  ~95%.
- Forks share the parent run's baseline tree manifest — zero
  additional baseline cost.

### 11.3 Capture latency

Per v0.2 §17 "fire-and-forget capture," file-change capture runs in the
existing `void persistCapture(...)` after the response returns. The
proxy grace delay on `close()` extends from 50 ms to 150 ms for file
I/O headroom.

### 11.4 Large repos at baseline time

Walking a 100k-file repo takes seconds, not milliseconds. The capture
pipeline:

- Captures baseline **lazily** on first FileChange, not at run start.
- Parallel file I/O bounded by `min(8, os.cpus())`.
- Emits `baseline_capturing` event on `/api/live` so UI can show
  "indexing project files..." for long initial walks.

Target: 100k-file Linux source tree, baseline in < 5 seconds on a 2024-
era laptop. Below this bar we'll publish; above we surface in `spool
doctor` and recommend `.spoolignore` tuning.

### 11.5 Probe latency

Pause-to-blocked-startStep latency: < 100 ms in the SDK (the next
`startStep` polls `probe_state` every 50 ms while paused, configurable
via the `probe.poll_interval_ms` setting). Resume-to-unblocked: same.
Inject application: instant (memory mutation only).

### 11.6 Line-ending and encoding normalization

Read bytes verbatim into the blob store; never modify them. This
preserves byte-exact reconstruction for v0.5 fork materialization.

Compute encoding / bom / line_endings as FileChange metadata. For diff
display: normalize to LF in the diff renderer only.

---

## 12. Trace format v0.3 deltas

`TRACE_FORMAT_VERSION = "0.3.0"`. v0.2 readers ignore unknown components
per the v0.2 §11 rule.

```json
{
  "spool_trace_version": "0.3.0",
  "run": { /* existing */
    "baseline_tree_id": "...",
    "probe_state": "resumed" | null
  },
  "steps": [ /* existing */ ],
  "file_changes": [ /* new — array of FileChange rows */ ],
  "baseline_trees": [ /* new — array of baseline_tree rows */ ],
  "annotations": [ /* existing; may contain probe_edit / probe_pause verdicts */ ],
  "blobs": {
    "<sha256>": "<base64>"
    // includes file blobs IFF --include-file-blobs was passed
    // includes baseline manifest blobs always (they're metadata, not content)
  }
}
```

`SUPPORTED_TRACE_VERSIONS = ["0.1.0", "0.2.0", "0.3.0"]`.

Backward compatibility:

- v0.2 readers ignore `file_changes`, `baseline_trees`,
  `run.baseline_tree_id`, `run.probe_state`. Per existing skip-unknown rule.
- v0.3 readers tolerate v0.2 traces by treating new arrays as `[]` and
  surfacing "no file-change data for this run."

---

## 13. Milestone phasing — v0.3 → v1

The single source of truth for what ships when. If §1.3, §3.7, or any
other section appears to contradict this table, this table wins.

### 13.1 v0.3 (this spec — weeks 1–8 from approval)

| Track | Deliverables |
|---|---|
| Track A — File capture | Binary-safety fix (PR 1) · schema v4 (file_change, baseline_tree, runs.baseline_tree_id) · Claude Code hook adapter for Edit/MultiEdit/Write/NotebookEdit · Bash stubs · lazy baseline capture · `working_tree_at` library · Files tab on step card · `/runs/:run_id/files` page · `spool files` CLI · trace format 0.3.0 · redaction extensions · `.spoolignore` defaults · `spool init` |
| Track B — Live Probe | `runs.probe_state` column · SDK pause/inject/resume in TS + Python · `spool probe` CLI · Probe panel on run detail page · SSE events · annotation conventions for probe_edit / probe_pause |
| Track C — OSS launch | Public repo · MIT license · `npm install -g @spool/cli` works on fresh machines · CONTRIBUTING + SECURITY · README < 5-min path · "fresh laptop" test by 3 outside reviewers · versioning + tagged releases · CI on macOS + Linux |

### 13.2 v0.4 — "Cross-vendor capture" (weeks 9–14)

| Deliverable | Notes |
|---|---|
| Codex CLI file capture | Parse `apply_patch_call` records from `~/.codex/sessions/.../*.jsonl` |
| Cursor file capture | Proxy + watcher only; documented limit |
| SDK helpers | `captureFilesystemDeltaDuring`, `WrappedTextEditorTool`, `WrappedApplyPatchTool` |
| File-watcher daemon | `spool watch --files`, opt-in; Bash side-effect capture |
| Proxy partials | Anthropic `text_editor` + OpenAI `apply_patch` capture from wire payload |
| Side-by-side diff | UI toggle on the unified-diff default |
| Cost dashboards | Carried from v0.2 debt — fleet-level cost breakdown views |

### 13.3 v0.5 — "Light up the wedge for coding agents" (weeks 15–22)

| Deliverable | Notes |
|---|---|
| Trajectory diff file-tree lane | §7 of the prior v0.3 draft, moved here |
| Fork `edit_file` edit type | New edit type carrying a unified diff or full content per file |
| Working-tree panel | Left-column file tree at any selected step |
| Working-tree scrubber | Drag-to-rewind across steps |
| Codex-style scope toggles | Last step / Since start / Since fork-point / vs parent run |
| Sandbox templates | Carried from v0.2 debt — pre-built isolated environments for `spool fork --continue live` |

### 13.4 v1 — "Broaden + harden" (months 7–10)

| Deliverable | Notes |
|---|---|
| Non-coding agents | Browser, voice, customer-support; new source_runtime values |
| Semantic diff with embedding alignment | High-divergence fork comparison |
| Model-upgrade workflow | Corpus replay against new model versions; diff report |
| Team tier | Multi-user, shared runs, RBAC |
| Enterprise tier | SSO, on-prem, audit logs |
| Vendor partnerships | Carried from original SPEC §22 |
| Dataset export | Carried from original SPEC §22 |

### 13.5 Discipline note

The v0.2 cycle promised more than it shipped. The v0.3-broad draft
repeated the pattern. This phasing chooses three things and protects
them. If a week-three review finds Track A slipping, **scope cuts come
from Track A first** (e.g., defer `/runs/:run_id/files` to v0.4, ship only
the Files tab) before Track B or Track C are reopened. Tracks B and C
defend themselves on smaller surface area for a reason.

---

## 14. Open questions

These need answers during build, not before approval, but track them:

1. **Sub-agent attribution.** Claude Code's `Task` tool spawns sub-agents
   whose edits land in `agent-<shortId>.jsonl`. v0.3 attaches them to
   the parent's `Task` step. Right model long-term, or should sub-agents
   become first-class runs with `parent_run_id`? *Likely v0.5+; depends
   on what the multi-agent debugger view wants.*

2. **Partial-diff UI affordance.** Showing "this step ran shell commands;
   contents not captured" on every Bash step risks feeling like nagging.
   Filter by default, surface via toggle? *Lean: filter by default,
   toggle to show.*

3. **`patch_text` storage location.** Cached derived artifact. Inline on
   the row, or as a content-addressed blob? Inline is simpler but bloats
   SQLite for runs with many large diffs. *v0.3: inline. Revisit if
   SQLite size becomes a problem.*

4. **Notebook structural diffs.** Treat `.ipynb` as binary with
   structural overlay, or fully parse cells in v0.3? *v0.3: binary blob
   with a notebook flag; full cell-level structural diff is v0.4.*

5. **Renames vs delete+create.** Some tools emit delete + create when
   renaming. Should the normalizer collapse `(D path A, A path B)`
   within one step into `R A → B` when blob contents are identical?
   *Yes, in the normalizer — but expose in the `normalizer_notes` field
   so we can audit when it fires.*

6. **Diff display limits.** A 50k-line diff is UI-hostile. Cap at N
   lines per file with "diff truncated, view raw blob" for the rest?
   *Yes; N = 5000 lines or 200 KB, whichever is smaller.*

7. **Probe interaction with `--continue live` forks.** A forked run with
   `--continue live` could in principle also be probed. Allowed in v0.3
   but only if the live continuation uses an SDK-instrumented agent (the
   default `spool fork --continue live` CLI uses a built-in safe-mode
   Bash executor that doesn't go through the SDK). Document; don't
   block.

8. **OSS launch and the trademark question.** "Spool" availability check
   per SPEC.md's "Working title" preface needs to clear *before* the
   public repo lands. If the name has to change, this is the gate.

---

## 15. Decisions journal

Appending to v0.2 §17.

### v0.3 scope

- **Three features, not five.** Codex audit and the v0.2 retrospective
  agreed: Spool's roadmaps consistently bite off more than a milestone
  can chew. v0.3 picks file capture, Live Probe, and OSS launch and
  protects them. Everything else defers to v0.4 / v0.5 / v1 on a
  schedule with one source of truth (§13).
- **File capture is Claude-Code-hook-only in v0.3.** Codex correctly
  flagged that cross-vendor capture + fork integration + diff lane was
  a four-feature milestone disguised as one. The cut keeps the dominant
  user (someone debugging a Claude Code session) and defers the rest
  with full schema support already in place — no migration tax in v0.4.
- **Live Probe lands in v0.3, not v0.4.** It's the only real debugger
  primitive on the v0.2 debt list. Fork is post-hoc; Live Probe is the
  breakpoint equivalent. Without it, Spool is "post-hoc inspector with
  fork"; with it, Spool is "debugger." Worth the 2-week investment to
  close that conceptual gap before the OSS launch.
- **OSS launch is a feature.** Calling it "go-to-market" lets it slip
  indefinitely. Calling it a forcing function for productionization
  debt gives the team incentive to fix the things strangers will trip
  on. Date-pinned to end of v0.3 cycle.

### Storage model (v0.3 file capture)

- **Content-addressed blob pairs over patch chains.** Random-access reads,
  natural dedup, deterministic replay, free fork-state pinning. Slightly
  larger per-step storage, mitigated to negligible by dedup.
- **`patch_text` is cached, not authoritative.** Source of truth is the
  blob pair. Future patch-rendering improvements don't require
  migration.
- **Baseline tree captured lazily.** First FileChange triggers it.
  Eager capture would penalize every run including non-coding ones.
- **Flat content-addressed manifest blob, not nested subtrees.** Git-tree-
  inspired but flatter; re-shred on read is free at the sizes we deal
  with.
- **Full enum coverage in v0.3 DDL.** `derived_from in
  ('tool_call','filesystem_watch','git_diff')` and all five ops even
  where only `tool_call` and three ops fire. Adding values to a SQLite
  CHECK later requires table rebuild, violating v0.2 §17.

### Capture model

- **Tool-call inspection primary; file-watcher v0.4 fallback.** Honest
  partial > dishonest full. Bash steps emit stub FileChanges with
  `partial_diff = true` so users know what's missing.
- **Claude Code re-uses upstream `file-history/` store.** It's already
  content-addressed; copy-by-SHA into Spool's store is cheap and dedups
  natively. We don't re-implement what upstream does well.
- **Sub-agent FileChanges attach to the parent's `Task` step in v0.3.**
  First-class sub-agent runs come later; attribution is correct enough
  for the inspection case.

### Live Probe

- **SDK-only in v0.3.** Proxy and hook modes can't pause cleanly.
  Honest about the limit; document the SDK migration path for users who
  want probe on those runtimes.
- **Reuses fork edit types.** Seven existing edit types cover every
  meaningful context mutation. Parallel "probe edit" enum would be
  duplication.
- **Probed-step edits record as annotations.** Existing
  `annotations` table, new conventional `verdict` values
  (`probe_edit`, `probe_pause`). No schema change.
- **`probeEnabled` defaults false.** Production agents don't want
  startup-time uncertainty. Dev/debug builds opt in.

### Security

- **Binary-safety fix ships first.** PR 1 before any FileChange row
  writes. Otherwise every PNG/font/lockfile captured gets corrupted.
  Skip-redact for non-text or explicit caller opt-out.
- **`--include-file-blobs` opt-in on export.** Default-on would leak
  code to bug reports.
- **Repo-level opt-in via .spool/config.toml.** Capturing code from a
  random `cd` should require deliberation. Matches v0.2 §17's
  local-first stance: user is in control.
- **Network-bind warning + auth token for blob and probe endpoints.**
  Exposing the web UI beyond `127.0.0.1` opens code contents and live
  control to the network. Warn loudly, require a token.

### UI

- **Files tab on the step card, not a separate page.** Coding-agent users
  want this integrated with decision/action/outcome inspection, not as
  a sidequest.
- **Reuse existing semantic colors.** Per v0.2 §12.5: "new status types
  have to fit one of mint/coral/amber/violet or argue why a fifth is
  needed." File ops fit: mint=create, amber=modify, coral=delete,
  violet=rename (same genealogy reading as fork).
- **One new token (`--cerulean-bg`).** Selected file row needs a tint.
  Matches existing `*-bg` pattern. Stays inside the "one accent color"
  rule.
- **Probe panel beneath the run header.** Co-located with the run's
  status pill and seal control — these are all "operate on this run"
  affordances. Conditional rendering avoids cluttering proxy/hook
  runs.
- **No working-tree panel or scrubber in v0.3.** Both are v0.5. Shipping
  them with file capture but before file-watcher coverage would
  underdeliver — you can scrub through Claude Code edits but Bash side
  effects would be invisible until v0.4. Wait until the capture story
  is complete enough that scrubbing means something.

### OSS launch

- **Date-pin to end of v0.3 cycle.** Indefinite deferral lets debt
  compound invisibly. Forcing function only works with a date.
- **"Fresh laptop" test by outsiders gates launch.** The team can't see
  the bugs they've adapted to. Outsource the install test to three
  reviewers who file at least one docs/install issue each before
  greenlight.
- **No API stability commitment in v0.3.** Pre-1.0. Trace format and
  schema rules continue (additive-only). TS/Python public API may break
  minor-to-minor until 1.0.
- **MIT license.** Permissive, fits the local-first posture, no
  ambiguity for enterprise adopters down the line.

---

## 16. Glossary additions

Appending to v0.2 §18.

- **FileChange.** A normalized, vendor-neutral event describing a single
  file mutation attributed to a Step. Fields: path, op
  (create/modify/delete/rename/chmod), before/after blob refs, cached
  patch text, file metadata, provenance.
- **Working tree.** The set of `(path, blob_ref)` pairs representing
  project state at a point in time. Reconstructed by applying
  FileChanges in order on top of a baseline tree.
- **Baseline tree.** A content-addressed snapshot of project files at
  Run start. Stored as a sorted flat manifest blob.
- **Partial diff.** A FileChange where capture was incomplete (a Bash
  step modified files but the v0.4 watcher wasn't enabled). The fact
  of the change is recorded; the content is approximate.
- **Op.** One of `create | modify | delete | rename | chmod` on a
  FileChange.
- **Tool-call-derived.** A FileChange whose provenance is a structured
  tool call in the agent's transcript. Attribution is exact.
- **Filesystem-watch-derived.** A FileChange whose provenance is an OS
  file-system event observed during a step's wall-clock window.
  Attribution is heuristic. (v0.4.)
- **`.spoolignore`.** A `.gitignore`-style file at repo root controlling
  which paths Spool captures. Defaults ship with the CLI.
- **Live Probe.** The pause-inject-resume primitive that operates on a
  currently-executing SDK-instrumented run. The breakpoint equivalent
  for agent debugging.
- **Probe edit.** A context mutation applied while a run is paused.
  Uses the same edit-type enum as fork (v0.2 §8.1). Recorded as an
  annotation on the step that resumes.
- **`probeEnabled`.** SDK flag (default false) that opts an agent loop
  into pause-on-`startStep` behavior.
- **Fresh-laptop test.** The OSS launch gate: three outside reviewers
  each install Spool from public docs on a clean machine, capture
  their first run, and file at least one issue before greenlight.

---

*End of v0.3 milestone spec. Once approved, file as the working
specification for the v0.3 cycle. After shipping, fold the as-built
deltas into a new `SPEC-V0_3.md` in the same shape as `SPEC-V0_2.md`.*
