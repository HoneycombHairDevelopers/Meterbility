# Live inspector & notifications

The fleet view from SPEC §3.1 — watch every running agent in one place, get alerted when something interesting happens.

## Run it

```bash
meter web --live
# → http://127.0.0.1:4317  (auto-opens browser)
```

The `--live` flag tells Meterbility to watch `~/.claude/projects/` for new sessions and growing session files. Every ~1.5s it scans, runs incremental ingest on anything new, and emits structured events over Server-Sent Events (`/api/live`). The fleet view updates without a page refresh.

### How live is it? (near-realtime, not instantaneous)

Ingest is a **poller, not a file-watcher** — the `LiveInspector` re-scans the projects directory on a fixed interval (`scanIntervalMs`, default 1500ms) rather than reacting to individual writes. So a step Claude Code writes shows up in the UI **within ~1.5s**, not the instant it happens. This is a deliberate floor, not the multi-minute delay of the old cold-start GO LIVE bug (that was a one-time backfill blocking the toggle; fixed — steady-state append latency is just the poll interval).

Why polling and not `fs.watch` here — three reasons the sentinel (which *does* use `fs.watch`) doesn't share:

1. **A write event is not an ingest boundary.** Claude Code appends to the JSONL continuously; a single logical step spans many writes. Firing ingest on every write would re-parse the file mid-record. The poller instead reads at a cadence where a step has settled.
2. **Ingest re-reads the whole file body, not just the tail.** `ingestSession` threads the parent-uuid chain across the record stream to assemble steps, so it isn't an append-only tail-follow — it re-derives from the file. Event-driven wakeups would just run that same O(file) work more often for no fidelity gain; the interval is the natural rate limiter, and the docs note `ingestSession` — not the timer — is the real bottleneck.
3. **fs.watch is lossy for this job.** It coalesces bursts and drops events under load (the sentinel tolerates that because a missed file event is a missed row, recoverable next event). A missed *session* growth event would strand a run's tail until the next unrelated write — a poller can't miss growth because it re-checks sizes every tick.

Cranking `scanIntervalMs` down tightens the floor but has diminishing returns (you just run the file re-read more often); the honest number to quote is **≤1.5s at default**.

### Latency: near-realtime, by design

Steps appear on the fleet and run pages within **~1.5 seconds** of Claude Code writing them — near-realtime, not zero-lag. Ingest is deliberately a **poller**, not an fs-watcher, for three reasons:

1. **A watcher wouldn't be faster where it counts.** The real cost floor is `ingestSession` itself, which re-reads the session body to thread the parent-uuid chain — event-driven *detection* wouldn't remove that. And Claude Code appends to the transcript continuously, so raw watch events arrive as a storm that needs debouncing right back down to something poll-shaped.
2. **Polling is self-healing.** A missed `fs.watch` event (coalesced, dropped on overflow — real platform behavior) silently loses a session until restart; a missed poll costs at most one tick, because every tick rescans from scratch. For capture-

## What you see

Each card in the grid:

- **Title** — the agent's first user message (or `ai-title` if Claude Code wrote one).
- **Status pill** — `progressing`, `awaiting_input`, `stalled`, `looping`, `errored`, `completed`. Computed by [`classifyRunStatus`](../packages/server/src/live-heuristics.ts).
- **Context bar** — % of the model's window used by the latest step. Color-codes at 70/90%.
- **Recent tools** — last 5 tool calls.
- **Age** — time since last step. Updates every second.
- **Alerts** — strip rendered when triggers fire.

## Alerts

`meter web --live` flags supported in v0.1:

```bash
# Fire an alert when any watched tool is called.
meter web --live --watch-tool Bash --watch-tool git_push

# Adjust the stall threshold (default 120s).
meter web --live --stall-seconds 60
```

Built-in heuristics (no flags needed):

- **Loop** — same tool with identical args ≥4 times in a row.
- **Context threshold** — first time a step crosses 50%, 70%, or 90% of the model's window.
- **Stall** — no step activity for `--stall-seconds`.

Each alert fires once per (run, signature) pair so you don't get spammed. Alerts are streamed to:

- The fleet view (banner above the grid for ~12s).
- The CLI process logs.
- Any SSE subscriber (`/api/live`).

## Live mode without the web UI

The same machinery is exposed programmatically:

```ts
import { Store } from "@meterbility/collector";
import { LiveInspector } from "@meterbility/server";

const store = Store.open();
const live = new LiveInspector(store, {
  watchTools: ["Bash"],
  stallSeconds: 60,
});
live.on("data", (e) => {
  if (e.type === "alert") console.log("alert:", e.kind, e.message);
  if (e.type === "run:created") console.log("new run:", e.run.run_id);
});
await live.start();
```

## Filesystem side-effect capture (v0.5)

Tool-call inspection captures what the agent *thinks* it changed; it can't see what a `Bash` step actually did to disk (`sed`, `mv`, `npm install`, build scripts). v0.5 closes that gap with two capture paths that share one engine:

| | Hook capture (`meter capture`) | FileSentinel (`meter watch --files`) |
|---|---|---|
| Works for | Claude Code | any runtime (Codex, Cursor, proxy, …) |
| Attribution | exact (the step whose Bash call it was) | heuristic (temporal proximity) |
| Process model | ephemeral, fired per tool call | resident watcher |
| Opt-in via | `meter init --hooks` | the `--files` flag |

Both paths emit `FileChange` rows with `derived_from = 'filesystem_watch'`, filter through `.meterbilityignore` + `.gitignore` + the shipped defaults, and defer to tool-call capture: when a step already has a full-fidelity `tool_call` row for a path, the filesystem observation is dropped (SPEC §3.1.3 — the partial Bash stubs are exactly what these supplement).

**Sensitive paths never carry contents — on any path.** The ignore stack keeps `.env` files, key material, and credential stores (`.aws/`, `.ssh/`, `.kube/config`, `.netrc`, `.npmrc`, …) out of filesystem observation entirely, and tool-call capture (which sees explicit agent edits regardless of ignores) stores such rows as redacted stubs: path + op + sizes, `redacted: true`, no blobs, no patch, no tool_input echo. The set is `SENSITIVE_METERBILITYIGNORE` in `@meterbility/shared` — deliberately narrower than the full defaults, so an agent explicitly patching `node_modules/` is still captured in full while its `.env` never is.

### Hook capture — exact, for Claude Code

```bash
meter init --hooks     # installs PreToolUse/PostToolUse(Bash) → meter capture pre|post
```

Every Bash call is bracketed: `pre` refreshes a persistent per-repo manifest (folding in ambient edits so they're never blamed on the agent), `post` diffs the tree against it. Because Claude Code's hook payload carries no `tool_use_id` and the transcript can lag the hook, observations are **stashed durably** — one file per record under `$METERBILITY_HOME/capture/pending/`, so parallel hooks can't clobber each other — and *drained* into rows once ingest can see the matching Bash step. Matching runs in three tiers, recorded on the row's `normalizer_notes.match`: exact tool-input equality, then Bash `command`-field equality, then a nearest-in-time fallback for parallel sibling calls (Claude Code collapses siblings into one step carrying only the first call's input). The temporal tier is age-gated (~60s) so a merely-lagging exact match always gets first claim. A record that can't be attributed within 15 minutes expires — attribution is dropped rather than guessed across the gap (its blobs stay in the store); run `meter capture drain` to retry a lagging session by hand. Capture never blocks the agent: the hook always exits 0, even on misconfiguration.

### FileSentinel — the cross-vendor fallback

```bash
meter watch --files                # watch every file under the current directory
meter watch --files --files-dir ~/code/my-app --attribution-window 300
```

`--files` takes no file argument — it watches the **entire directory tree recursively** (the current directory, or `--files-dir`). Every file is covered by default; the only things excluded are `.meterbilityignore` / `.gitignore` patterns, the shipped defaults (`node_modules/`, build artifacts, `.env`, keys, …), and `.git/` internals. To narrow what's captured, add patterns to `.meterbilityignore` — there is no per-file allowlist.

An OS-level watcher for runs Meterbility can only observe from the outside. On start it snapshots the watched directory so the *before* side of the first touch of any file is real bytes. Each event attaches to the most recent step of the freshest in-progress run whose cwd overlaps the watched directory, and only when that step is younger than the attribution window (default 120s); the attribution inputs are recorded on the row's `normalizer_notes`. Changes with no attributable run print as `file:unattributed` and are **not** recorded — ambient edits don't pollute the corpus.

Honest limits (both paths): renames surface as delete + create; files over 5 MB degrade to `partial_diff` stubs; symlinks, FIFOs, sockets, and other non-regular files are never read or recorded (a symlink retarget produces no row). Sentinel-specific: attribution is heuristic, and `fs.watch` platform quirks (coalesced events) can miss a row but never invent a wrong one. Hook-specific: parallel Bash calls can interleave a pre/post pair, in which case both steps' deltas land on the closest-matching step.

Release verification for both paths lives in the [manual test checklist](test-plan-v0_4-capture.md).

## Caveats

- Polling cadence is 1.5s by default, so live updates are near-realtime (≤~1.5s), not instantaneous — see [How live is it?](#how-live-is-it-near-realtime-not-instantaneous) for why ingest polls rather than watches. Faster intervals are possible (`scanIntervalMs`) but the bottleneck is `ingestSession`, which re-reads the file body to thread the parent-uuid chain.
- Loop detection uses `JSON.stringify(action.tool_input)` for the signature. Tool inputs that include non-deterministic values (timestamps, uuids) won't trip the heuristic — that's by design.
- Alert state is in-memory. Restarting `meter web --live` re-fires alerts that already triggered in the previous session.
- Codex CLI sessions **are** watched as of v0.5.1: the same tick loop discovers growing rollout files under `~/.codex` and tail-polls them alongside Claude Code sessions. Cursor is the remaining gap — it persists to a SQLite database (`state.vscdb`), not an append-only file, so it can't join the tail-poll loop; use `meter ingest cursor` for after-the-fact capture or `meter init --cursor-hooks` for real-time hook capture via `meter cursor-hook`.
