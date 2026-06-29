# Getting started

Meterbility is the debugger for AI agents. v0 captures Claude Code sessions and lets you inspect, fork, diff, and annotate them locally.

## Prereqs

- Node 20.6+ (the repo's `.nvmrc` pins to Node 20)
- A `~/.claude/` directory with at least one Claude Code session under `~/.claude/projects/`

## 60-second tour

```bash
# from a clone of this repo:
npm install
./bin/meter doctor
```

`doctor` runs the Gate 2 check from SPEC §18. If every line says PASS, the capture surface is live.

```bash
./bin/meter ingest claude-code --limit 5
```

Reads the newest 5 Claude Code sessions and turns each one into a Meterbility **Run**. Re-running is idempotent — only new bytes are processed.

```bash
./bin/meter list
```

Shows the captured runs, newest first. Each line:

```
run_4de2ad47  in_progress    99 steps    $31.18  main              Meterbility product specification draft
```

The 12-character prefix is what every other command accepts.

```bash
./bin/meter inspect run_4de2ad47
```

Prints a run header, a colored timeline, and every step's summary.

```bash
./bin/meter inspect run_4de2ad47 --at 5 --show all
```

Opens step #5 with all five tabs (decision, action, outcome, cost, context).

## Forking

The headline primitive:

```bash
./bin/meter fork run_4de2ad47 \
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
./bin/meter diff run_4de2ad47 <new-fork-id>
```

You should see a shared prefix, a single divergence row at the edited step, and then `only_a` / `only_b` for the steps the two runs took afterwards.

## Web UI

```bash
./bin/meter web
```

Opens http://127.0.0.1:4317 with a run list, step timelines, and trajectory diffs. Step content is loaded on demand from the content-addressed blob store via `/api/blob/<sha>`.

## Annotate

```bash
./bin/meter annotate run_4de2ad47 --verdict good_decision --note "The architect made the right call here"
./bin/meter annotate stp_abc123 --verdict bad_decision --note "Should have stopped to ask before editing the test"
```

Annotations are the human signal that feeds the regression suite (v0.1).

## Export

```bash
./bin/meter export run_4de2ad47 -o run.meter.json
```

Writes the run as a single JSON file in the [Meterbility Trace Format](trace-format.md). Round-trippable, base64-inlined blobs by default.

## Where data lives

Default `$METERBILITY_HOME` is `~/.meterbility`:

- `~/.meterbility/meterbility.db` — SQLite metadata (runs, steps, forks, annotations).
- `~/.meterbility/blobs/<aa>/<bb>/<sha256>` — content-addressed blob store.

Disable redaction with `METERBILITY_REDACT=off` (default rules redact known secret patterns — see `packages/shared/src/redact.ts`).

## What's not in v0

- No live capture (open Claude Code, then `meter ingest`).
- No team / hosted backend.
- No scheduled regression suite.
- No sandbox templates.
- No semantic diff — structural only.

See SPEC §20–22 for the v0.1+ roadmap.
