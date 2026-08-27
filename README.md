# Meterbility

> **The debugger for AI agents.** Capture every run, inspect every decision, pause and inject live, fork from any step, diff the trajectories.

Meterbility turns AI agent runs into a queryable, replayable, forkable corpus and surfaces them through a terminal inspector, a local web UI, and a Live Probe operator surface. It works against Claude Code, Codex CLI, Cursor, GitHub Copilot CLI, the Anthropic and OpenAI proxies, and any custom agent that uses the TypeScript or Python SDK.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![License: ELv2](https://img.shields.io/badge/EE_License-ELv2-orange.svg)](ee/LICENSE) [![Node](https://img.shields.io/badge/Node-24%2B-339933.svg)](.nvmrc) [![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB.svg)](packages/agent-py/pyproject.toml)

---

## Status

**v0.6.6 — GitHub Copilot + multi-agent fleets, hardened release publishing.** Working end-to-end. On npm as [`@meterbility/cli`](https://www.npmjs.com/package/@meterbility/cli).

Latest milestones (v0.6.4–v0.6.6):

- **GitHub Copilot CLI adapter** — `meter ingest github-copilot` parses Copilot CLI sessions (`~/.copilot/session-state/*/events.jsonl`) into runs and steps: tool calls, per-turn token usage priced under the cost-honesty rules (`cost:unpriced` for opaque models, premium requests recorded), file changes derived from mutating tool inputs with secret redaction, context-compaction markers, and a shape probe that warns on format drift instead of crashing. `meter live` and the web ingest endpoint pick Copilot sessions up automatically.
- **Multi-agent fleet carving (schema v8)** — a Copilot session that dispatches sub-agents (squad-style) is carved into a parent run plus one child run per agent, each with its own steps, tokens, and exclusive cost, correlated strictly by recorded events. Re-carving a grown or rewritten session file converges to byte-identical state.
- **Real-shape Copilot routing (v0.6.5)** — validated against live Copilot CLI 1.0.80 sessions: per-agent streams route by `interactionId`, agent identity parses from the task dispatch prompt, usage is priced from where the CLI actually records it, and agents cut off by a session shutdown resolve to `abandoned` immediately.
- **Fleet views** — `meter list` and the web run list nest agent runs under their parent with a fleet cost rollup; run detail shows "Agent of" lineage and the agents list; the live fleet covers each agent run individually. `listRuns` and `GET /api/runs` now default to top-level runs — pass `includeChildren` (library) or `?children=1` (API) for the flat set.
- **Resumable release publishing (v0.6.6)** — the npm and PyPI publish workflows skip versions already on the registry, complete partial PyPI uploads, refuse to run on version drift, and queue concurrent runs, so a release that dies halfway is re-dispatched, not hand-repaired. See [docs/publishing.md](docs/publishing.md).
- **Forward-compat guard** — opening a database written by a newer Meterbility build fails with a clear upgrade message instead of silently misreading newer semantics, on both SQLite and Postgres.

Earlier milestones (v0.6.2 — the live front door):

- **`meter live` — the front door** — one command starts session ingest and file side-effect capture together: a self-explaining header, an honest `SYNCING → SYNCED` backfill state, a live `step 42 · Edit src/foo.ts · +12 −3` stream, and a capture-health line that reports watcher degradation instead of silently missing changes.
- **Step-range file summary** — `meter files <run> --from X [--to Y]` without `--diff`: a git-status-style view of everything a step window changed, re-runnable against a live session; synthetic bands (hook/admin/checkpoint) are mapped in by wall clock, `--main-band-only` opts out.
- **One sentinel per root** — `meter live` and `meter watch --files` share a per-root, owner-identified heartbeat so two watchers never double-capture the same tree; a second instance attaches as a viewer, and an attach hint points you at recent capture nobody is watching.

Earlier milestones (v0.6.1):

- **Reasoning text parity** — streamed `reasoning_content` deltas (NVIDIA NIM-style reasoning models) now fold into the captured decision blob, matching what non-streamed responses already carried. The model's thinking is no longer lost the moment it streams.
- **Time-to-first-token** — the proxy tee stamps per-chunk arrival marks; every streamed step records `ttft_ms` (first delta of any kind — when thinking began) and `ttft_visible_ms` (first token a user sees). The gap is the invisible **reasoning burn**, now visible in the proxy log line, the step card's Cost tab, and the store.
- **Cache-report honesty** — a host that omits `prompt_tokens_details` entirely tags the step `usage:cache-unreported`, so "0 cached tokens" is never conflated with "didn't say" (same absent-≠-zero principle as unpriced costs).

Earlier milestones (v0.6.0):

- **Any OpenAI/Anthropic-dialect upstream** — `meter proxy` is no longer hardcoded to api.anthropic.com + api.openai.com. Register any compatible host (NVIDIA, Groq, Together, Ollama, vLLM, self-hosted gateways) as a named provider with the repeatable `--upstream` flag; each answers at its own `/<name>/` prefix, concurrently on one port, and bare paths behave exactly as before. Verified live against NVIDIA (`integrate.api.nvidia.com`) — its real stream shape is pinned in the test suite.
- **First-class provider identity** — captured runs and steps carry a `provider` column (plus `upstream_host` provenance on runs), shown as a badge in the web UI. Same prompt + model through two different upstreams lands in two distinct runs.
- **Cost honesty for open models** — vendor-namespaced models (`meta/llama-…`) with no pricing-table entry render as **unpriced** everywhere, never `$0.00` and never a fabricated frontier-rate guess; ok-steps with zero token usage get a persistent `usage:missing` tag.
- **Proxy hardening** — upstream redirects are relayed to the client, never followed (no auth replay); a hop-marker loop guard 508s chained/self-referential proxies; encoded path separators are rejected before the upstream join.

### Capturing a non-OpenAI/Anthropic upstream

The flag grammar is `--upstream <name>[:<dialect>]=<url>` — `name` becomes the URL prefix and the persisted provider label, `dialect` picks the capture parser (`openai`, the default, or `anthropic`), and `url` is the upstream base (origins with a path are fine, e.g. `https://api.groq.com/openai`; credentials in the URL are rejected — keys stay in your client's headers, which the proxy forwards but never stores).

One-shot, zero config — `meter run` wires the child's env for you:

```bash
meter run --upstream nvidia=https://integrate.api.nvidia.com -- python myagent.py
```

Long-running proxy — export the printed base URL yourself:

```bash
meter proxy --upstream nvidia=https://integrate.api.nvidia.com
export OPENAI_BASE_URL=http://127.0.0.1:8765/nvidia/v1   # openai-dialect: /v1 included
python myagent.py
```

Multiple providers on one port (each gets its own prefix; clients pick by base URL):

```bash
meter proxy \
  --upstream nvidia=https://integrate.api.nvidia.com \
  --upstream groq=https://api.groq.com/openai \
  --upstream local:openai=http://localhost:11434 \
  --upstream mygw:anthropic=https://claude-gw.internal
# → /nvidia/v1/..., /groq/v1/..., /local/v1/..., /mygw/v1/...
# anthropic-dialect base URLs omit the /v1 (the Anthropic SDK appends it):
#   export ANTHROPIC_BASE_URL=http://127.0.0.1:8765/mygw
```

Rules worth knowing: the built-ins are also prefix-reachable (`/openai/…`, `/anthropic/…`), and `--openai-target`/`--anthropic-target` re-point the whole provider — bare and prefixed aliases follow together. `meter run` wires at most **one upstream per dialect** (env vars are singular; it errors with guidance if you pass two), and `--no-openai`/`--no-anthropic` suppress only the built-in wiring, never an `--upstream` you asked for. Non-capture paths under a prefix (`/nvidia/v1/models`) pass through without writing anything.

Earlier milestones (v0.5.1):

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
meter live                   # watch sessions + file side effects (foreground — run in a second terminal)
meter ingest claude-code --limit 5
meter list
meter inspect <run-id> --at 5 --show context   # exactly what the model saw at step 5
meter web                    # open the inspector at http://127.0.0.1:4317
```

Instrumenting your own agent? Add the SDK to your project instead: `npm install @meterbility/agent` (TypeScript) or `pip install meterbility-agent` (Python).

### The flow — two front doors

Everything in Meterbility hangs off two commands. Pick by where your agent runs:

- **`meter run -- <cmd>`** — *launch and capture.* Wraps any script or agent with the capture proxy auto-wired (Anthropic, OpenAI, or any OpenAI-compatible upstream via `--upstream nvidia=…`). API traffic becomes runs with first-class provider identity. Zero code change.
- **`meter live`** — *watch and capture.* For sessions Meterbility observes from the outside (Claude Code, Codex CLI, GitHub Copilot CLI — Cursor persists to SQLite, so it joins via `meter ingest cursor` or `meter init --cursor-hooks` instead): one command starts session ingest **and** file side-effect capture together, streams `step 42 · Edit src/foo.ts · +12 −3` lines as they happen, and prints a capture-health line that tells you honestly when the filesystem watcher is degraded. Run it in your repo before (or during — it attaches) an agent session.

Then interrogate what happened:

```bash
meter files <run-id> --at 5          # what did step 5 change?
meter files <run-id> --from 3        # everything changed from step 3 to now (live runs too)
meter files <run-id> --diff src/x.ts --from 3 --to 7   # one file's diffs across a window
```

One-time setup for exact (hook-based) Bash capture in a repo: `meter init --hooks`. Without it, `meter live`'s filesystem sentinel is the cross-vendor fallback.

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
| GitHub Copilot CLI capture (`meter ingest github-copilot`, live tail-poll, web ingest) | ✅ v0.6.4 |
| Multi-agent fleet carving (squad sessions → parent + per-agent child runs, schema v8) | ✅ v0.6.4 |
| Anthropic + OpenAI proxy capture (`meter proxy`) | ✅ v0.2 |
| Multi-upstream proxy capture (`--upstream <name>[:<dialect>]=<url>` — any OpenAI/Anthropic-dialect host behind a `/<name>/` prefix, concurrent on one port, first-class `provider` on runs/steps; verified: NVIDIA `integrate.api.nvidia.com`) | ✅ v0.6 |
| Proxy edge metadata (`x-meterbility-cwd` / `x-meterbility-git-branch` headers) | ✅ v0.5.1 |
| Claude Code file-change capture (Write/Edit/MultiEdit/Bash-rm) | ✅ v0.3 |
| Bash side-effect capture — `meter capture` hooks (exact) + FileSentinel (fallback) | ✅ v0.5 |
| `meter live` — one-command ingest + file capture, capture-health line, viewer guard | ✅ v0.6 |
| Step-range file summary (`meter files --from/--to`, band-aware) + attach nudge | ✅ v0.6 |
| Sensitive-path content redaction (`.env` / keys record fact, not contents) | ✅ v0.5 |
| **SDK** | |
| TypeScript SDK (`@meterbility/agent`) | ✅ v0.1 |
| Python SDK (`meterbility-agent`) | ✅ v0.3 |
| `traceAnthropic` / `trace_anthropic` helpers | ✅ v0.1 / v0.3 |
| Live Probe in SDK (pause / inject / resume) | ✅ v0.3 |
| **Inspector** | |
| `meter list` / `inspect` / `fork` / `diff` / `annotate` / `export` / `web` / `doctor` | ✅ v0 |
| Live fleet view (`meter web --live`, `meter watch`) — Claude Code + Codex CLI + GitHub Copilot CLI sessions | ✅ v0.1 / v0.5.1 / v0.6.4 |
| Nested fleet display (`meter list` + web run list nest agent runs under their parent, fleet cost rollup, `?children=1` for the flat set) | ✅ v0.6.4 |
| Notifications (loop / threshold / stall / tool-watch) | ✅ v0.1 |
| Files tab (per-step + per-run summary) | ✅ v0.3 |
| Live Probe operator surface (`meter probe`, web panel) | ✅ v0.3 |
| **Storage** | |
| Local SQLite + content-addressed filesystem blobs | ✅ v0 |
| Postgres backend (single-operator multi-machine sync) | ✅ v0.1 |
| Forward-compat schema guard (newer-DB detection before any DDL, SQLite + Postgres) | ✅ v0.6.4 |
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
  proxy/              # LLM-API forward proxy with capture (named upstreams via --upstream)
  store-postgres/     # optional Postgres backend
  web/                # placeholder for future SPA

adapters/
  claude-code/        # Claude Code JSONL + file-history-snapshot adapter
  codex-cli/          # Codex / Codex Desktop rollout JSONL adapter
  cursor/             # Cursor composer/Agents reverse-engineered SQLite adapter
  github-copilot/     # GitHub Copilot CLI events.jsonl adapter + squad fleet carving

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
  publishing.md       # npm + PyPI release process (trusted publishing, resumable runs)
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
| [Publishing](docs/publishing.md) | Cutting an npm + PyPI release, trusted publishing setup |
| [CHANGELOG](CHANGELOG.md) | What shipped in each release |
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
