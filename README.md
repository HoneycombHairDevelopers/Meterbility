# Spool

> **The debugger for AI agents.** Capture every run, inspect every decision, fork from any step, diff the trajectories.

Spool is the v0 implementation of [SPEC.md](SPEC.md). It turns Claude Code's per-project JSONL session logs into a queryable, replayable, forkable corpus and surfaces them through a terminal inspector and a local web UI.

## Status

- **v0** — Claude Code, local-only, post-hoc inspection.
- **Working end-to-end.** Try the [60-second tour](docs/getting-started.md).
- **Not on npm yet.** Run from a clone (see below).

## Install (from this repo)

Requires **Node 20.6+** (uses `node --import` for tsx loading; rebuilds `better-sqlite3` natively).

```bash
nvm use                      # picks up .nvmrc → Node 20
npm install
./bin/spool doctor           # verify the Claude Code surface
./bin/spool ingest claude-code --limit 5
./bin/spool list
./bin/spool web              # open the inspector at http://127.0.0.1:4317
```

`./bin/spool` is the launcher. To put it on `$PATH`, symlink it into `~/.local/bin/` or wherever you keep scripts.

## What v0 ships

Mapped against [SPEC §19](SPEC.md):

| Capability                          | Status |
| ----------------------------------- | ------ |
| Claude Code session capture (hook)  | ✅     |
| Local SQLite + filesystem blobs     | ✅     |
| `spool list`                         | ✅     |
| `spool inspect`                      | ✅     |
| `spool fork`                         | ✅     |
| `spool diff` (structural)            | ✅     |
| `spool annotate`                     | ✅     |
| `spool export` (open trace format)   | ✅     |
| `spool web` (local UI)               | ✅     |
| Redaction pass on capture            | ✅     |
| Replay engine (deterministic prefix) | ✅     |
| Live suffix (Anthropic API)          | ✅ (opt-in via `--live`) |
| Live inspector (real-time)           | ⏳ v0.1 |
| Multi-runtime support                | ⏳ v0.1 |
| Hosted backend / team features       | ⏳ v0.1+ |

## The five DevTools panels

Spool's value rests on whether the [fork-and-diff primitive](docs/architecture.md#forking) produces actionable signal. See [the spec](SPEC.md) §4 for the panel mapping. v0 delivers Elements (Context), Sources (Step inspector + fork), Network (I/O Inspector), and Performance (cost/tokens). Console (Live Probe) lands in v0.1.

## Layout

See [Appendix B in the spec](SPEC.md). Source tree:

```
packages/
  cli/               # `spool` command (commander)
  shared/            # types, hashing, redaction, paths
  spec/              # trace-format schema + model pricing
  collector/         # SQLite + content-addressed blob store
  server/            # replay, fork, diff, web (Hono)
  web/               # placeholder for future SPA
adapters/
  claude-code/       # JSONL → Spool Step model
docs/
  getting-started.md
  trace-format.md
  architecture.md
```

## Docs

- [Getting started](docs/getting-started.md) — 60-second tour.
- [Trace format v0.1](docs/trace-format.md) — wire format spec.
- [Architecture](docs/architecture.md) — how capture, storage, replay, and diff fit together.

## License

Source-available under the spirit of the spec — see SPEC §15.1 and §26 (open-source license decision is deferred).
