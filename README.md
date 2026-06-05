# Spool

> **The debugger for AI agents.** Capture every run, inspect every decision, pause and inject live, fork from any step, diff the trajectories.

Spool turns AI agent runs into a queryable, replayable, forkable corpus and surfaces them through a terminal inspector, a local web UI, and a Live Probe operator surface. It works against Claude Code, Codex CLI, Cursor, the Anthropic and OpenAI proxies, and any custom agent that uses the TypeScript or Python SDK.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![License: ELv2](https://img.shields.io/badge/EE_License-ELv2-orange.svg)](ee/LICENSE) [![Node](https://img.shields.io/badge/Node-20.6%2B-339933.svg)](.nvmrc) [![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB.svg)](packages/agent-py/pyproject.toml)

---

## Status

**v0.3 — file capture + Live Probe.** Working end-to-end. Not on npm yet — run from a clone.

Latest milestones (Tracks A–C of v0.3):

- **Track A** — file-change capture from Claude Code's `file-history-snapshot` JSONL. Every Write / Edit / MultiEdit shows up with full diffs in the Files tab. Pure-`rm` Bash deletes detected.
- **Track B** — Live Probe (this milestone). Pause a running agent, inject a message, resume. TypeScript + Python SDKs, `spool probe` CLI, web panel — all driving one shared file-based protocol so any combination of clients can drive the same run.
- **Track C** — OSS launch deliverables (license files, dependency audit, this README, [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), fresh-laptop test).

[60-second tour →](docs/getting-started.md)

---

## Install (from this repo)

Requires **Node 20.6+** (uses `node --import` for tsx loading; rebuilds `better-sqlite3` natively). Python SDK additionally requires **Python 3.9+** (stdlib only — no install-time deps).

```bash
git clone https://github.com/HoneycombHairDevelopers/spool
cd spool
nvm use                      # picks up .nvmrc → Node 20
npm install
./bin/spool doctor           # verify the Claude Code surface
./bin/spool ingest claude-code --limit 5
./bin/spool list
./bin/spool web              # open the inspector at http://127.0.0.1:4317
```

`./bin/spool` is the launcher. To put it on `$PATH`, symlink it into `~/.local/bin/` or wherever you keep scripts.

For the cleanest possible install verification, run:

```bash
./scripts/fresh-laptop-test.sh
```

This is the same script CI runs — clones into a tempdir, installs, runs the full test suite, exercises every documented command, and tears down.

---

## What ships today

| Capability | Status |
|---|---|
| **Capture** | |
| Claude Code session capture (JSONL hook) | ✅ v0 |
| Codex CLI / Codex Desktop capture | ✅ v0.1 |
| Cursor composer + Agents-window capture | ✅ v0.1 |
| Anthropic + OpenAI proxy capture (`spool proxy`) | ✅ v0.2 |
| Claude Code file-change capture (Write/Edit/MultiEdit/Bash-rm) | ✅ v0.3 |
| **SDK** | |
| TypeScript SDK (`@spool/agent`) | ✅ v0.1 |
| Python SDK (`spool-agent`) | ✅ v0.3 |
| `traceAnthropic` / `trace_anthropic` helpers | ✅ v0.1 / v0.3 |
| Live Probe in SDK (pause / inject / resume) | ✅ v0.3 |
| **Inspector** | |
| `spool list` / `inspect` / `fork` / `diff` / `annotate` / `export` / `web` / `doctor` | ✅ v0 |
| Live fleet view (`spool web --live`, `spool watch`) | ✅ v0.1 |
| Notifications (loop / threshold / stall / tool-watch) | ✅ v0.1 |
| Files tab (per-step + per-run summary) | ✅ v0.3 |
| Live Probe operator surface (`spool probe`, web panel) | ✅ v0.3 |
| **Storage** | |
| Local SQLite + content-addressed filesystem blobs | ✅ v0 |
| Postgres backend (single-operator multi-machine sync) | ✅ v0.1 |
| Trace format v0.2 (export/import) | ✅ v0.1 |
| **Workflows** | |
| Fork + replay (deterministic prefix, Anthropic live suffix) | ✅ v0 |
| Multi-step fork continuation (`--continue simulate\|live`) | ✅ v0.2 |
| Regression suite (`spool test ...`) | ✅ v0.1 |
| **Deferred to v0.4+** | |
| `spool watch --files` file-system daemon (per-run change recovery) | ⏳ v0.4 |
| Sandbox templates | ⏳ v0.4 |
| LangChain / Vercel AI SDK first-class adapters | ⏳ v0.4 |
| Team tier (multi-tenant, SSO, RBAC, audit) | ⏳ ee/ |

Full milestone history: [SPEC-V0.2.md §16](SPEC-V0.2.md), [docs/v0-3-followups.md](docs/v0-3-followups.md).

---

## The five DevTools panels

Spool maps the browser DevTools mental model onto agents. See [SPEC §4](SPEC.md) for the full mapping; v0.3 delivers four of five:

| DevTools | Spool | v0.3 |
|---|---|---|
| Elements | Resolved context viewer (`/contexts/:id`) | ✅ |
| Sources | Step inspector + fork-from-here (`spool inspect`, `spool fork`); add `--pretty-print` for schema-aware tab rendering | ✅ |
| Network | I/O Inspector (decision blob, tool results, files changed) | ✅ |
| Performance | Cost + token + latency timeline (per step + per run) | ✅ |
| Console | **Live Probe** — pause, inject, resume (`spool probe`, web panel) | ✅ |

---

## Repo layout

```
packages/
  cli/                # `spool` command (commander)
  shared/             # types, hashing, redaction, paths, probe protocol
  spec/               # trace-format schema + pricing tables
  collector/          # SQLite + content-addressed blob store
  server/             # replay, fork, diff, web (Hono), live inspector, probe panel
  agent/              # TypeScript SDK (SpoolTracer + traceAnthropic + probe hook)
  agent-py/           # Python SDK — stdlib only, same shape as TS
  proxy/              # Anthropic + OpenAI HTTP proxies with capture
  store-postgres/     # optional Postgres backend
  web/                # placeholder for future SPA

adapters/
  claude-code/        # Claude Code JSONL + file-history-snapshot adapter
  codex-cli/          # Codex / Codex Desktop rollout JSONL adapter
  cursor/             # Cursor composer/Agents reverse-engineered SQLite adapter

ee/                   # Enterprise Edition modules (ELv2 — empty today)

docs/
  getting-started.md  # 60-second tour
  architecture.md     # how capture, storage, replay, diff fit together
  sdk.md              # instrument a custom TS agent
  live-inspector.md   # spool web --live + notifications
  regression.md       # promote canonicals + assertions
  postgres.md         # optional Postgres backend
  trace-format.md     # v0.2 wire format spec
  v0-3-followups.md   # known limitations + their v0.4 resolution paths
```

---

## Docs

| Doc | When to read |
|---|---|
| [Getting started](docs/getting-started.md) | First-time setup, 60-second tour |
| [SDK guide](docs/sdk.md) | Instrumenting a TypeScript agent |
| [Architecture](docs/architecture.md) | How the pieces fit together |
| [Live inspector](docs/live-inspector.md) | Fleet view, SSE, notifications |
| [Regression suite](docs/regression.md) | Promote canonicals, write assertions |
| [Postgres backend](docs/postgres.md) | Multi-machine sync, hosted backend |
| [Trace format](docs/trace-format.md) | Wire-format spec (export/import) |
| [v0.3 follow-ups](docs/v0-3-followups.md) | What's deliberately deferred + why |
| [CONTRIBUTING](CONTRIBUTING.md) | Development setup, PR conventions |
| [SECURITY](SECURITY.md) | Vulnerability disclosure |
| [Third-party licenses](LICENSES-third-party.md) | Dependency audit |

---

## License

Spool ships under an **open-core** model:

- **MIT** ([`LICENSE`](LICENSE)) — everything outside the `/ee` directory. The capture surfaces, trace format, replay engine, Inspector + Debugger UI, Live Probe, and CLI. The full single-operator product.
- **Elastic License 2.0** ([`ee/LICENSE`](ee/LICENSE)) — anything inside `/ee` (empty today; reserved for multi-tenant fleet orchestration, SSO, RBAC, audit logs, long-retention modules).
- **Commercial** — the hosted cloud (when it ships).

Every dependency in the tree is permissive (MIT / ISC / Apache-2.0 / BSD). Zero copyleft. See [`LICENSES-third-party.md`](LICENSES-third-party.md) and run [`./scripts/license-audit.sh`](scripts/license-audit.sh) to re-verify.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
git clone https://github.com/HoneycombHairDevelopers/spool
cd spool && nvm use && npm install
npm test                                   # TypeScript suite
cd packages/agent-py && python3 -m unittest discover tests
```

285+ tests across both runtimes. Add tests with every change. Keep
the suite green before you ask for review.

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md). Please do not file public issues for exploitable bugs.
