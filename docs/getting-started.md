# Getting started

Spool is the debugger for AI agents. v0 captures Claude Code sessions and lets you inspect, fork, diff, and annotate them locally.

## Prereqs

- Node 18.4+
- A `~/.claude/` directory with at least one Claude Code session under `~/.claude/projects/`

## 60-second tour

```bash
# from a clone of this repo:
npm install
./bin/spool doctor
```

`doctor` runs the Gate 2 check from SPEC §18. If every line says PASS, the capture surface is live.

```bash
./bin/spool ingest claude-code --limit 5
```

Reads the newest 5 Claude Code sessions and turns each one into a Spool **Run**. Re-running is idempotent — only new bytes are processed.

```bash
./bin/spool list
```

Shows the captured runs, newest first. Each line:

```
run_4de2ad47  in_progress    99 steps    $31.18  main              Spool product specification draft
```

The 12-character prefix is what every other command accepts.

```bash
./bin/spool inspect run_4de2ad47
```

Prints a run header, a colored timeline, and every step's summary.

```bash
./bin/spool inspect run_4de2ad47 --at 5 --show all
```

Opens step #5 with all five tabs (decision, action, outcome, cost, context).

## Forking

The headline primitive:

```bash
./bin/spool fork run_4de2ad47 \
  --at 5 \
  --edit replace_user_message \
  --text "Focus only on the API layer" \
  --fake "Acknowledged — scoping to the API."
```

This:

1. Copies steps 0..5 of the origin run into a new run, applying the edit to step 5's context.
2. Appends one synthetic suffix step (the `--fake` payload). Replace with `--live` to make a real Anthropic API call (needs `ANTHROPIC_API_KEY`).

Then diff the trajectories:

```bash
./bin/spool diff run_4de2ad47 <new-fork-id>
```

You should see a shared prefix, a single divergence row at the edited step, and then `only_a` / `only_b` for the steps the two runs took afterwards.

## Web UI

```bash
./bin/spool web
```

Opens http://127.0.0.1:4317 with a run list, step timelines, and trajectory diffs. Step content is loaded on demand from the content-addressed blob store via `/api/blob/<sha>`.

## Annotate

```bash
./bin/spool annotate run_4de2ad47 --verdict good_decision --note "The architect made the right call here"
./bin/spool annotate stp_abc123 --verdict bad_decision --note "Should have stopped to ask before editing the test"
```

Annotations are the human signal that feeds the regression suite (v0.1).

## Export

```bash
./bin/spool export run_4de2ad47 -o run.spool.json
```

Writes the run as a single JSON file in the [Spool Trace Format](trace-format.md). Round-trippable, base64-inlined blobs by default.

## Where data lives

Default `$SPOOL_HOME` is `~/.spool`:

- `~/.spool/spool.db` — SQLite metadata (runs, steps, forks, annotations).
- `~/.spool/blobs/<aa>/<bb>/<sha256>` — content-addressed blob store.

Disable redaction with `SPOOL_REDACT=off` (default rules redact known secret patterns — see `packages/shared/src/redact.ts`).

## What's not in v0

- No live capture (open Claude Code, then `spool ingest`).
- No team / hosted backend.
- No scheduled regression suite.
- No sandbox templates.
- No semantic diff — structural only.

See SPEC §20–22 for the v0.1+ roadmap.
