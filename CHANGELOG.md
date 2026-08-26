# Changelog

Notable changes to Meterbility. Versions are lockstep across the
`@meterbility/*` npm packages and `meterbility-agent` on PyPI.

## [0.6.4] - 2026-08-24

### Added

- **GitHub Copilot CLI adapter** (`@meterbility/github-copilot-adapter`).
  `meter ingest github-copilot` parses Copilot CLI sessions
  (`~/.copilot/session-state/*/events.jsonl`, legacy root probed too) into
  runs and steps, with tool calls, per-turn token usage priced under the
  v0.6 cost-honesty rules (`provider: "github"`, `cost:unpriced` for
  opaque models, premium requests recorded), file-change rows derived
  from mutating tool inputs (secrets redacted, honest `redacted` flag),
  context-compaction markers, and a day-one shape probe that warns on
  format drift instead of crashing. `meter live` and the web ingest
  endpoint pick Copilot sessions up automatically.
- **Multi-agent fleet carving (schema v8).** A Copilot session that
  dispatches sub-agents (squad-style) is carved into a parent run plus
  one child run per agent — each with its own steps, tokens, and
  exclusive cost, correlated strictly by recorded event ancestry (never
  inferred). Agent names and roles parse from spawn prompts
  ("You are {Name}, the {Role}…") into run titles and tags. The whole
  carve commits in one transaction and re-carving a grown, shrunk, or
  rewritten session file converges to byte-identical state — steps that
  re-route between runs are reconciled, never double-counted.
- **Fleet views.** `meter list` and the web run list nest agent runs
  under their parent (nested delegation renders too) with a
  display-time fleet cost rollup; run detail shows "Agent of" lineage
  and the agents list; the live fleet and event stream cover each agent
  run individually. `GET /api/runs` gains `?children=1` for the flat set.
- **Forward-compat guard.** Opening a database written by a newer
  Meterbility build now fails with a clear upgrade message — before any
  DDL runs, on both SQLite and Postgres — instead of silently misreading
  newer semantics.

### Changed

- **Run listings default to top-level runs.** `listRuns` and
  `GET /api/runs` exclude carved child runs by default (they render
  nested under their parent); aggregation, exports, live bookkeeping,
  and batch operations still include them. Pass `includeChildren`
  (library) or `?children=1` (API) for the old flat behavior.
- `diffLines` moved to `@meterbility/shared` (re-exported from the
  claude-code adapter for compatibility); diff inputs from untrusted
  session files are size-capped.
- Copilot run status inference is session-level with a staleness
  window: sessions that die mid-turn resolve to `abandoned` instead of
  sitting `in_progress` forever, and a live squad's streaming agents
  are never mislabeled abandoned.

### Fixed

- The v8 migration rebuilds the annotations table on databases created
  at v5–v7, whose baked-in CHECK constraint would otherwise reject
  compaction markers and abort Copilot ingest.
- A corrupted or adversarial `events.jsonl` line with a cyclic
  `parentId` can no longer hang the live poll; cyclic chains route to
  the parent tagged `copilot:unrouted`.
- Postgres: the lineage index no longer breaks `ensurePostgresSchema`
  on upgraded databases, and syncing a squad session no longer violates
  a foreign key on fresh databases.
- Per-agent tool-call-id collisions no longer attribute one agent's
  tool result to another agent's run.

## [0.6.3] - 2026-08-24

### Fixed

- **Test runs no longer fill your disk.** Every test file created throwaway
  fixture stores (SQLite DB + blob store) in the OS temp dir and never
  removed them — months of `npm test` runs could accumulate gigabytes and
  eventually fail mid-run with ENOSPC. The runner now redirects the whole
  run into one temp root and deletes it when the run passes; on failure the
  root is kept (and named in the output) so fixtures stay inspectable, then
  reclaimed after 24h. The Playwright fixture server likewise reaps its
  leftover temp homes: each is tagged with its owner pid, dead owners are
  swept at the next boot, and a live server's home is left alone (up to a
  24-hour ceiling that guards against pid reuse).

## [0.6.2] - 2026-08-24

### Added

- **`meter live` — the front door.** One command starts session ingest and
  file side-effect capture together: a self-explaining header (active
  sessions, capture mode, provider identity for proxy runs, DB path), an
  honest `SYNCING → SYNCED` state while history backfills, and a live
  stream of `step 42 · Edit src/foo.ts · +12 −3` lines as they happen.
  Late-arriving Bash evidence prints as `(update)` delta rows instead of
  duplicate step lines.
- **Capture-health line.** `meter live` tells you when file capture is
  degraded instead of silently missing changes: warn at >5s of filesystem
  event silence, degraded at >15s (only with definite write activity — a
  read-only Bash loop never false-alarms), a loss counter for events that
  arrived too late to attribute, and a `coalesced_events` count recorded
  on rows that net several filesystem events into one diff (rendered as
  `net of N events` on step-attributed rows). `--json` streams a typed
  `capture:health` event.
- **Step-range file summary.** `meter files <run> --from X [--to Y]` now
  works without `--diff`: a git-status-style summary of everything that
  changed in a step window, across all files. `--to` omitted means "to the
  current step" and re-runs cleanly against a live session. Synthetic-band
  changes (hook/admin/checkpoint) are included by wall-clock mapping and
  tagged; `--main-band-only` opts out.
- **One-sentinel-per-root guard.** `meter live` and `meter watch --files`
  share a per-root, owner-identified heartbeat so two watchers can never
  double-capture the same tree; a second instance attaches as a viewer
  (`--force-capture` overrides), and an orphaned viewer warns loudly when
  its capture holder disappears.
- **Attach hints.** When recent file capture has landed with no live
  viewer attached, the next `meter` command prints a one-line hint to
  attach; `meter run` prints its own hint the moment its proxy starts.

### Changed

- `meter watch` is now the raw event-stream tool for scripting; its help
  points humans at `meter live`. Output is unchanged.
- README leads with the two front doors: `meter run` (launch and capture)
  and `meter live` (watch and capture).
- Terminal output sanitizes control, ANSI/OSC, and bidi characters from
  untrusted strings (file paths, run titles, alert messages).

### Fixed

- Codex CLI ingest no longer crashes on rollouts whose tool output is a
  structured object rather than a string (real-world schema drift from
  2026-07 rollouts) — the live backfill previously logged an ingest
  failure for such sessions on every tick.
- `meter files` step bounds now error clearly when a step id belongs to a
  different run, when bounds are empty, or when `--at` is combined with a
  range or `--diff` — instead of silently producing a wrong window.
