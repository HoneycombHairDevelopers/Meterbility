# Meterbility

> **The debugger for AI agents.** Capture every run, inspect every decision, pause and inject live, fork from any step, diff the trajectories.

Meterbility turns AI agent runs into a queryable, replayable, forkable corpus and surfaces them through a terminal inspector, a local web UI, and a Live Probe operator surface. It works against Claude Code, Codex CLI, Cursor, the Anthropic and OpenAI proxies, and any custom agent that uses the TypeScript or Python SDK.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![License: ELv2](https://img.shields.io/badge/EE_License-ELv2-orange.svg)](ee/LICENSE) [![Node](https://img.shields.io/badge/Node-24%2B-339933.svg)](.nvmrc) [![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB.svg)](packages/agent-py/pyproject.toml)

---

## Status

**v0.5.1 — cross-vendor parity.** Working end-to-end. On npm as [`@meterbility/cli`](https://www.npmjs.com/package/@meterbility/cli).

Latest milestones (v0.5.1):

- **Codex CLI rollout parity** — Codex ingests now carry per-step tokens with cache and reasoning splits, real per-turn model ids (from `turn_context`), per-turn latency, and structured file changes from `patch_apply_end` (creates carry full content; updates/deletes/renames record the unified diff as `partial_diff` rows — the rollout has no before-content). Codex sessions also appear in the live fleet view (`meter web --live`) via tail-poll discovery of `~/.codex` rollouts.
- **Cursor three-channel capture** — (1) deep-diff extraction from `state.vscdb`, including `edit_file_v2` before/after blobs and accept/reject fates, with checkpoint fallback evidence and `aiCodeTrackingLines` AI-authorship annotations; (2) real-time capture via Cursor Hooks — `meter init --cursor-hooks` installs `.cursor/hooks.json` entries that route `afterFileEdit`/`beforeShellExecution`/`stop` through `meter cursor-hook` (never blocks the agent); (3) real billed cost via `meter cursor-usage`, which pulls the Cursor Admin API (Teams/Business, `meter config set cursor.admin_api_key …`) and joins billed tokens + cache splits to ingested runs on conversationId, tagged `cost:actual` vs the local `cost:value` estimate.
- **Proxy edge metadata** — `meter proxy` clients can send `x-meterbility-cwd` / `x-meterbility-git-branch` headers so proxy-captured runs carry real workspace context; proxy session ids are namespaced.
- **Probe honesty** — the Live Probe panel and its pause/inject/resume endpoints are gated to runtimes that actually implement pause/ack (the TS/Python SDKs); transcript- and proxy-sourced runs no longer render a pause button that would wedge them. (Reading probe state stays open to all runs.)
- **Inline capture redaction** — cursor/codex `patch_text` and `source_tool_input` now pass through the same secret-pattern redaction as everything else.

Earlier milestones (v0.5):

- **Bash side-effect capture** (closes SPEC §3.1.3): what tool-call inspection can't see (`sed`, `mv`, `npm install`, build scripts) now lands as `filesystem_watch` FileChange rows, two ways — **hook capture** for Claude Code (`meter init --hooks` → `meter capture`, exact per-step attribution) and the **FileSentinel** (`meter watch --files`, cross-vendor fallback with temporal-proximity attribution). Both watch the **whole project tree by default** — every file under the current directory (or `--files-dir`), recursively, filtered only by `.meterbilityignore`/`.gitignore`; there's nothing per-file to configure. See [Live inspector docs](docs/live-inspector.md#filesystem-side-effect-capture-v05).
- **Markdown-aware pretty printing** — `meter inspect --pretty-print` and the web step cards detect markdown in messages, thinking, tool results, and decisions, and style headings/bold/code/lists/links in place.
- **Sensitive-path content policy** — explicit agent edits to `.env`, keys, and credential stores record the *fact* of the change (path, op, size) but never the contents.

Earlier still:

- **v0.3 — file capture + Live Probe.** Claude Code `file-history-snapshot` diffs in the Files tab; Live Probe pause/inject/resume across TypeScript + Python SDKs, `meter probe` CLI, and web panel; OSS launch deliverables (licenses, dependency audit, [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), fresh-laptop test).

[60-second tour →](docs/getting-started.md)

---

## Install

Requires **Node 24+** (rebuilds `better-sqlite3` natively). Python SDK additionally requires **Python 3.9+** (stdlib only — no install-time deps).

```bash
npm install -g @meterbility/cli

meter doctor                 # verify the Claude Code surface
meter ingest claude-code --limit 5
meter list
meter inspect <run-id> --at 5 --show context   # exactly what the model saw at step 5
meter web                    # open the inspector at http://127.0.0.1:4317
```

Instrumenting your own agent? Add the SDK to your project instead: `npm install @meterbility/agent` (TypeScript) or `pip install meterbility-agent` (Python).

### From a clone

For development, or to run ahead of the latest release:

```bash
git clone https://github.com/HoneycombHairDevelopers/Meterbility
cd Meterbility
nvm use                      # picks up .nvmrc → Node 24
npm install
./bin/meter doctor           # same CLI, run from source
```

`./bin/meter` is the launcher. To put it on `$PATH`, symlink it into `~/.local/bin/` or wherever you keep scripts.

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
| Codex rollout parity (tokens/cache/reasoning, real model ids, latency, `patch_apply_end` file changes) | ✅ v0.5.1 |
| Cursor composer + Agents-window capture | ✅ v0.1 |
| Cursor deep-diff file capture (`edit_file_v2` before/after + accept/reject fates, checkpoint fallback) | ✅ v0.5.1 |
| Cursor real-time hooks (`meter init --cursor-hooks` → `meter cursor-hook`) | ✅ v0.5.1 |
| Cursor billed cost via Admin API (`meter cursor-usage`, `cost:actual` tags) | ✅ v0.5.1 |
| Anthropic + OpenAI proxy capture (`meter proxy`) | ✅ v0.2 |
| Proxy edge metadata (`x-meterbility-cwd` / `x-meterbility-git-branch` headers) | ✅ v0.5.1 |
| Claude Code file-change capture (Write/Edit/MultiEdit/Bash-rm) | ✅ v0.3 |
| Bash side-effect capture — `meter capture` hooks (exact) + `meter watch --files` FileSentinel (fallback) | ✅ v0.5 |
| Sensitive-path content redaction (`.env` / keys record fact, not contents) | ✅ v0.5 |
| **SDK** | |
| TypeScript SDK (`@meterbility/agent`) | ✅ v0.1 |
| Python SDK (`meterbility-agent`) | ✅ v0.3 |
| `traceAnthropic` / `trace_anthropic` helpers | ✅ v0.1 / v0.3 |
| Live Probe in SDK (pause / inject / resume) | ✅ v0.3 |
| **Inspector** | |
| `meter list` / `inspect` / `fork` / `diff` / `annotate` / `export` / `web` / `doctor` | ✅ v0 |
| Live fleet view (`meter web --live`, `meter watch`) — Claude Code + Codex CLI sessions | ✅ v0.1 / v0.5.1 |
| Notifications (loop / threshold / stall / tool-watch) | ✅ v0.1 |
| Files tab (per-step + per-run summary) | ✅ v0.3 |
| Live Probe operator surface (`meter probe`, web panel) | ✅ v0.3 |
| **Storage** | |
| Local SQLite + content-addressed filesystem blobs | ✅ v0 |
| Postgres backend (single-operator multi-machine sync) | ✅ v0.1 |
| Trace format v0.2 (export/import) | ✅ v0.1 |
| **Workflows** | |
| Fork + replay (deterministic prefix, Anthropic live suffix) | ✅ v0 |
| Multi-step fork continuation (`--continue simulate\|live`) | ✅ v0.2 |
| Regression suite (`meter test ...`) | ✅ v0.1 |
| **Pretty-print** | |
| Markdown-aware pretty printing (`--pretty-print`, web step cards) | ✅ v0.5 |
| **On the roadmap** | |
| Markdown pretty-print for inline code / tables in the terminal | ⏳ next |
| Sandbox templates | ⏳ next |
| LangChain / Vercel AI SDK first-class adapters | ⏳ next |
| Team tier (multi-tenant, SSO, RBAC, audit) | ⏳ ee/ |

Full milestone history: [SPEC-V0.2.md §16](SPEC-V0.2.md), [docs/v0-3-followups.md](docs/v0-3-followups.md).

---

## The five DevTools panels

Meterbility maps the browser DevTools mental model onto agents. See [SPEC §4](SPEC.md) for the full mapping; all five are delivered:

| DevTools | Meterbility | Status |
|---|---|---|
| Elements | Resolved context viewer (`/contexts/:id`) | ✅ |
| Sources | Step inspector + fork-from-here (`meter inspect`, `meter fork`); add `--pretty-print` for schema-aware tab rendering | ✅ |
| Network | I/O Inspector (decision blob, tool results, files changed) | ✅ |
| Performance | Cost + token + latency timeline (per step + per run) | ✅ |
| Console | **Live Probe** — pause, inject, resume (`meter probe`, web panel) | ✅ |

---

## Repo layout

```
packages/
  cli/                # `meter` command (commander)
  shared/             # types, hashing, redaction, paths, probe protocol
  spec/               # trace-format schema + pricing tables
  collector/          # SQLite + content-addressed blob store
  server/             # replay, fork, diff, web (Hono), live inspector, probe panel
  agent/              # TypeScript SDK (MeterbilityTracer + traceAnthropic + probe hook)
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
  live-inspector.md   # meter web --live + notifications
  regression.md       # promote canonicals + assertions
  postgres.md         # optional Postgres backend
  trace-format.md     # v0.2 wire format spec
  v0-3-followups.md   # known limitations + their resolution paths
  test-plan-v0_4-capture.md  # manual release checklist for the Bash capture paths
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
| [Roadmap follow-ups](docs/v0-3-followups.md) | What's deliberately deferred + why |
| [Capture test plan](docs/test-plan-v0_4-capture.md) | Manual release verification for hook capture + FileSentinel |
| [CONTRIBUTING](CONTRIBUTING.md) | Development setup, PR conventions |
| [SECURITY](SECURITY.md) | Vulnerability disclosure |
| [Third-party licenses](LICENSES-third-party.md) | Dependency audit |

---

## License

Meterbility ships under an **open-core** model:

- **MIT** ([`LICENSE`](LICENSE)) — everything outside the `/ee` directory. The capture surfaces, trace format, replay engine, Inspector + Debugger UI, Live Probe, and CLI. The full single-operator product.
- **Elastic License 2.0** ([`ee/LICENSE`](ee/LICENSE)) — anything inside `/ee` (empty today; reserved for multi-tenant fleet orchestration, SSO, RBAC, audit logs, long-retention modules).
- **Commercial** — the hosted cloud (when it ships).

Every dependency in the tree is permissive (MIT / ISC / Apache-2.0 / BSD). Zero copyleft. See [`LICENSES-third-party.md`](LICENSES-third-party.md) and run [`./scripts/license-audit.sh`](scripts/license-audit.sh) to re-verify.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
git clone https://github.com/HoneycombHairDevelopers/Meterbility
cd Meterbility && nvm use && npm install
npm test                                   # TypeScript suite
cd packages/agent-py && python3 -m unittest discover tests
```

1,380+ tests across both runtimes. Add tests with every change. Keep
the suite green before you ask for review.

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md). Please do not file public issues for exploitable bugs.
