# Changelog

Notable changes to Meterbility. Versions are lockstep across the
`@meterbility/*` npm packages and `meterbility-agent` on PyPI.

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
  arrived too late to attribute, and a `coalesced_events` badge on rows
  that net several filesystem events into one diff. `--json` streams a
  typed `capture:health` event.
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
- **Attach hints.** When capture is running with no viewer attached, the
  next `meter` command prints a one-line hint to attach; `meter run`
  prints its own hint the moment its proxy starts.

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
