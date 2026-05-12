# Spool

> **The debugger for AI agents.** Capture every run, inspect every decision, fork from any step, diff the trajectories.

Spool is the v0 implementation of [SPEC.md](SPEC.md). It turns Claude Code's per-project JSONL session logs into a queryable, replayable, forkable corpus and surfaces them through a terminal inspector and a local web UI.

## Status

- **v0.1** — Claude Code + Codex CLI capture, custom-agent SDK, live fleet view, notifications, regression suite, optional Postgres backend.
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

## What ships today

Against [SPEC §19](SPEC.md) (v0) and [§20](SPEC.md) (v0.1):

| Capability                                | Status |
| ----------------------------------------- | ------ |
| Claude Code session capture (hook mode)   | ✅ v0  |
| Codex CLI / Codex Desktop capture          | ✅ v0.1 |
| Cursor composer/Agents-window capture      | ✅ v0.1 (reads `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`) |
| Custom-agent SDK (`@spool/agent`)         | ✅ v0.1 |
| `traceAnthropic` SDK helper                | ✅ v0.1 |
| Local SQLite + filesystem blobs           | ✅ v0  |
| Postgres backend (optional, hosted)        | ✅ v0.1 (`spool db postgres-init/sync`) |
| `spool list` / `inspect` / `fork` / `diff` / `annotate` / `export` / `web` / `doctor` | ✅ v0 |
| Live inspector (real-time fleet view, SSE) | ✅ v0.1 (`spool web --live`) |
| Notifications (loop / threshold / stall / tool-watch) | ✅ v0.1 |
| Regression suite (`spool test ...`)       | ✅ v0.1 |
| Trace format spec v0.2                     | ✅ v0.1 |
| Replay engine (deterministic prefix)      | ✅ v0  |
| Live suffix (Anthropic API)                | ✅ v0  |
| Sandbox templates                         | ⏳ v0.2 |
| Live Probe (pause + inject + resume)       | ⏳ v0.2 |
| LangChain / Vercel AI SDK adapters         | ⏳ v0.2 |
| Python SDK                                 | ⏳ v0.2 |
| Team tier (multi-user, RBAC)               | ⏳ v0.2 |

## The five DevTools panels

Spool's value rests on whether the [fork-and-diff primitive](docs/architecture.md#forking) produces actionable signal. See [the spec](SPEC.md) §4 for the panel mapping. v0 delivers Elements (Context), Sources (Step inspector + fork), Network (I/O Inspector), and Performance (cost/tokens). Console (Live Probe) lands in v0.1.

## Layout

See [Appendix B in the spec](SPEC.md). Source tree:

```
packages/
  cli/               # `spool` command (commander)
  shared/            # types, hashing, redaction, paths
  spec/              # trace-format schema (v0.1 + v0.2) + pricing
  collector/         # SQLite + content-addressed blob store
  server/            # replay, fork, diff, web (Hono), live inspector, regression
  agent/             # custom-agent SDK (SpoolTracer + traceAnthropic)
  store-postgres/    # optional Postgres backend (sync from local SQLite)
  web/               # placeholder for future SPA
adapters/
  claude-code/       # JSONL → Spool Step model
  codex-cli/         # Codex / Codex Desktop rollout JSONL adapter
  cursor/            # Cursor composer/Agents reverse-engineered SQLite adapter
docs/
  getting-started.md
  trace-format.md
  architecture.md
  sdk.md
  live-inspector.md
  regression.md
  postgres.md
```

## Docs

- [Getting started](docs/getting-started.md) — 60-second tour.
- [SDK guide](docs/sdk.md) — instrument a custom TS agent.
- [Live inspector](docs/live-inspector.md) — `spool web --live` and notifications.
- [Regression suite](docs/regression.md) — promote canonicals + assertions.
- [Postgres backend](docs/postgres.md) — optional hosted store for team tier.
- [Trace format](docs/trace-format.md) — v0.1 + v0.2 wire format spec.
- [Architecture](docs/architecture.md) — how capture, storage, replay, and diff fit together.

## License

Source-available under the spirit of the spec — see SPEC §15.1 and §26 (open-source license decision is deferred).
