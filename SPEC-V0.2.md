# Spool — As-Built Specification (v0.2)

> **What this is.** An accurate description of the product as it exists in the
> codebase today. Use this when you want to know *what's shipped* — every
> command, every page, every API, every design token, every integration point
> and the decisions behind them.
>
> **What it isn't.** The vision/positioning/business document. That's
> [`SPEC.md`](./SPEC.md) — preserved unchanged as the pre-build artifact so
> intent stays auditable against reality.
>
> **Status.** v0.2 milestone shipped (Python SDK + Anthropic & OpenAI proxy +
> in-progress run sealing). 76 tests pass. ~12 packages live in the monorepo.
>
> **Audience.** Anyone joining the project, anyone integrating with Spool,
> anyone proposing a change that touches the data model, capture pipeline, or
> UI primitives.

---

## Table of Contents

1. [Product shape today](#1-product-shape-today)
2. [Capture surfaces — three modes](#2-capture-surfaces--three-modes)
3. [CLI reference](#3-cli-reference)
4. [Web UI reference](#4-web-ui-reference)
5. [Data model + storage](#5-data-model--storage)
6. [Cost engine](#6-cost-engine)
7. [Live mode + alerts + Slack](#7-live-mode--alerts--slack)
8. [Fork + replay + continuation](#8-fork--replay--continuation)
9. [Diff engine](#9-diff-engine)
10. [Regression suite](#10-regression-suite)
11. [Trace format v0.2 (export/import)](#11-trace-format-v02-exportimport)
12. [Cerulean Design System](#12-cerulean-design-system)
13. [Architecture — package map](#13-architecture--package-map)
14. [Run grouping (proxy heuristic)](#14-run-grouping-proxy-heuristic)
15. [Sealing in_progress runs](#15-sealing-in_progress-runs)
16. [Roadmap deltas vs original SPEC](#16-roadmap-deltas-vs-original-spec)
17. [Decisions journal](#17-decisions-journal)
18. [Glossary](#18-glossary)

---

## 1. Product shape today

Spool is **the debugger for AI agents**. It captures every model call your
agent makes, lets you inspect every step (with full context bytes), fork from
any step with an edit applied, and diff trajectories. The wedge is the
fork-and-diff primitive that no observability tool offers, layered on a faithful
DevTools-style inspector.

The product ships as **one CLI binary + one local web UI + a proxy + two SDKs**,
all writing into the same SQLite + content-addressed blob store at
`~/.spool/spool.db` and `~/.spool/blobs/`. Local-first; an optional Postgres
backend exists for team-tier scenarios.

**Three surfaces** (per original SPEC §3, all live):

- **Inspector — the live view.** `spool web --live` + `spool watch`. Tails
  `~/.claude/projects` and surfaces fleet status with SSE. Alerts on stalls,
  context thresholds, watched tool calls, identical-tool loops.
- **Debugger — the post-hoc inspector.** `spool inspect` + the web run
  detail page. Per-step decision/action/outcome/cost/context tabs. Resolved
  context viewer (renders the actual conversation, not the manifest).
- **Sandbox — the isolated playground.** Partially shipped via `spool fork`
  + `--continue` modes (simulate, live). Multi-step replay loop with cached
  prefix and live suffix.

**Three ways to get data in** (the major v0.2 expansion):

1. **Hook adapters** — read existing session logs from disk. Zero code change.
   Adapters: `claude-code`, `codex-cli`, `cursor`.
2. **SDK adapters** — wrap your model calls explicitly. TypeScript
   (`@spool-ai/agent`) and Python (`spool-agent`).
3. **HTTP proxy** — `spool proxy` or `spool run -- <cmd>`. Local forward
   proxy that captures the wire payload. **Anthropic + OpenAI from day one.**
   Streaming + non-streaming. No code change required from the agent author.

§2 covers each in detail.

---

## 2. Capture surfaces — three modes

Three ways to feed data into the same store. Pick by friction tolerance:

| Mode | Code change | Live? | Granularity | Best for |
|---|---|---|---|---|
| Hook | None | Polled (≤1.5s) | Whatever the runtime logs | You use Claude Code, Codex, or Cursor and just want to see what they did |
| SDK | Wrap each model call | Real-time | Custom — you control step boundaries, tags, extra context components | Building a custom agent and want fine-grained observability |
| Proxy | One env var (or none with `spool run`) | Real-time | Wire payload (system, history, tools, response, usage) | Existing langchain/llamaindex/dspy/raw-anthropic agents you don't want to refactor |

### 2.1 Hook mode (`spool ingest <runtime>`)

Reads runtime-published session files from disk. Idempotent — `ingest_progress`
table tracks last byte offset per file so re-running picks up only new bytes.

```
spool ingest claude-code              # ingests every ~/.claude/projects/**/*.jsonl
spool ingest claude-code --cwd /repo  # restrict to a project's sessions
spool ingest codex                    # ~/.codex sessions
spool ingest cursor                   # Cursor's local SQLite (read-only)
```

Adapters live in `adapters/<runtime>/`. Each exports `discoverSessions()` and
`ingestSession()` — that's the contract. Adding a new runtime is a self-
contained PR; nothing in the core packages needs to change.

### 2.2 SDK mode

**TypeScript** (`@spool-ai/agent`):
```ts
import { SpoolTracer, helpers } from "@spool-ai/agent";

const tracer = new SpoolTracer({ project: "my-app", agent: "support" });
const step = tracer.startStep({
  model: "claude-opus-4-7",
  systemPrompt: "you are helpful",
  history: [{ role: "user", content: "hello" }],
});
step
  .recordToolCall("Bash", { command: "ls" }, "tu1")
  .recordToolResult("file1\nfile2")
  .recordTokens({ tokens: { input: 100, output: 20, cached_read: 0, cache_creation: 0 } });
await step.end();
await tracer.end();
```

A convenience wrapper exists for the Anthropic SDK case:
```ts
import { traceAnthropic } from "@spool-ai/agent";
const traced = traceAnthropic(tracer, (req) => client.messages.create(req));
```

**Python** (`spool-agent`):
```python
from spool_agent import SpoolTracer, tool_call_action

with SpoolTracer(project="my-app", agent="support") as tracer:
    step = tracer.start_step(model="claude-opus-4-7", history=[...])
    step.record_action(tool_call_action("Bash", {"command": "ls"}, "tu1"))
    step.record_tool_result({"stdout": "file1\nfile2"})
    step.record_tokens(input=100, output=20)
    step.end()
```

The Python SDK is **stdlib-only at the core** (sqlite3, hashlib, json) — zero
runtime deps. It writes directly to the same SQLite + blob store the JS SDK
uses, so a Python agent shows up in `spool list`/`spool web` immediately.
Anthropic helper imports `anthropic` lazily — `pip install
'spool-agent[anthropic]'` opts in.

Cross-language byte parity is verified: `canonical_json` matches the TS
implementation byte-for-byte, so a content_ref hash from Python is identical
to the same logical value's hash from TS.

### 2.3 Proxy mode (the v0.2 expansion)

The biggest adoption-friction reduction in v0.2. The proxy captures everything
the proxy/SDK route would but **without any code change**.

```bash
# Long-lived daemon flow
spool proxy &
ANTHROPIC_BASE_URL=http://127.0.0.1:8765 python myagent.py
OPENAI_BASE_URL=http://127.0.0.1:8765/v1 python myagent.py

# One-shot wrapper flow (env vars auto-injected into the child)
spool run -- python myagent.py
spool run -- npm run my-agent
spool run --project my-app --agent prod -- node bot.js
```

Multi-provider on day one. Routing table (`packages/proxy/src/routes.ts`):

| Path | Provider | Default upstream |
|---|---|---|
| `/v1/messages` | anthropic | `https://api.anthropic.com` |
| `/v1/chat/completions` | openai | `https://api.openai.com` |

Both upstreams are overridable via `--anthropic-target` / `--openai-target`
for self-hosted gateways (vLLM, LiteLLM, Bedrock proxies, etc.).

What the proxy captures:
- **Full wire payload** — system prompt, message history, tool definitions,
  tool_use blocks, usage tokens (including 5m/1h cache split for Anthropic
  and `prompt_tokens_details.cached_tokens` for OpenAI), latency, status code.
- **Streaming** — tee'd stream so the client gets chunks as they arrive;
  capture buffers in parallel and reassembles a complete Message after the
  stream ends. Anthropic SSE handles `message_start`, `content_block_*`
  (including `input_json_delta` accumulation for tool_use input), and
  `message_delta`. OpenAI SSE handles delta concatenation + final usage chunk.
- **Tool results, retroactively.** When request N+1 arrives with a
  `tool_result` block that references a `tool_use_id` from request N, the
  proxy patches the originating step's outcome with the tool result blob.
  No data loss vs the SDK path.
- **HTTP errors** — 4xx/5xx responses become error steps with `outcome.summary
  = "HTTP <code>"`.

What the proxy *doesn't* know automatically:
- **Agent name / project label.** Defaults to `cwd`. Override with `--agent`
  and `--project` flags, or per-request via `x-spool-agent` and
  `x-spool-project` headers.
- **Run boundaries.** No equivalent of `tracer.end()` — proxy-captured runs
  stay `in_progress` until you seal them. See §15.

### 2.4 Run grouping in proxy mode

Three-tier strategy (`packages/proxy/src/grouping.ts`):

1. **Explicit grouping wins.** `x-spool-run-id: <id>` header.
2. **Conversation-seed hash + 30-min sliding window.** Hash =
   `sha256(model + system_prompt + first_user_message)`. Same seed within the
   window + new request's `messages.length >= last_messages_count` → same Run.
3. **Else, new Run.**

Rationale and trade-offs in §14.

### 2.5 Source runtime taxonomy

Every Run row carries a `source_runtime` field. Current values:
- `claude-code`, `codex-cli`, `cursor` — hook adapters
- `sdk-ts`, `sdk-py` — SDKs
- `proxy` — proxy capture
- `fork` — derived run from `spool fork`

Used for: filtering in `spool list`/`spool web`, label rendering on the run
detail page, retention policies (future), and `spool runs close --source` scoping.

---

## 3. CLI reference

The `spool` binary registers 18 commands today. They group into seven logical
buckets:

### 3.1 Capture
- **`spool ingest claude-code [path]`** — import Claude Code sessions.
- **`spool ingest codex [path]`** — import Codex CLI sessions.
- **`spool ingest cursor`** — import Cursor's local SQLite snapshots.
- **`spool proxy`** — long-running local LLM-API forward proxy. Flags:
  `--port`, `--host`, `--project`, `--agent`, `--anthropic-target`,
  `--openai-target`, `--quiet`. Logs each capture as
  `provider model → action (run · step · ms · in/out)`.
- **`spool run -- <command...>`** — one-shot wrap. Spawns proxy on a free
  port, injects `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` into the child env,
  forwards stdio, mirrors child exit code. SIGINT propagates. Flags:
  `--port`, `--project`, `--agent`, `--no-anthropic`, `--no-openai`,
  `--anthropic-target`, `--openai-target`, `--quiet`.

### 3.2 Inspect
- **`spool list [--limit N] [--status S] [--source S]`** — recent runs.
  Aliased as `spool ls`.
- **`spool inspect <run-id> [--at <seq-or-step-id>] [--show <tab>]`** —
  terminal-rendered timeline + step inspector. `--show` accepts
  `context | decision | action | outcome | cost | all`. The `context` tab
  resolves content_refs and renders the actual conversation with role badges
  + char counts (not the raw manifest).
- **`spool diff <run-a> <run-b>`** — terminal diff between two runs.
- **`spool watch [--filter <kinds>] [--run <id>] [--json]`** — terminal
  counterpart to the web UI's SSE stream. Emits `run:created`, `run:updated`,
  `run:completed`, `alert`, `fleet:snapshot` events.
- **`spool open <run-id> [--at <step>] [--context]`** — browser bridge.
  Resolves the run locally, builds the right URL (`/runs/:id#step-…` or
  `/contexts/:id`), pings the web server, auto-spawns `spool web --no-open`
  if it's down. `--print` for clipboard piping.

### 3.3 Mutate
- **`spool annotate <target>`** — attach a verdict + note to a step or run.
- **`spool fork <run-id> --at <step> --edit <type> [--payload|--text|--payload-file] [--continue simulate|live] [--max-iterations N]`** —
  the fork primitive. Edit types:
  `replace_system_prompt | add_context | remove_tool | modify_tool_description | replace_user_message | inject_message | change_model`.
  `--continue` runs a multi-step continuation loop after the suffix step.
- **`spool runs close [id]`** — seal an in-progress run (proxy-captured runs
  most often). Flags: `--status ok|error|abandoned` (default ok),
  `--all [--source proxy] [--older-than <minutes>] [--dry-run]`.

### 3.4 Test
- **`spool test`** — regression assertions over captured runs. Subcommands
  for create / list / run / delete (see §10).

### 3.5 Serve
- **`spool web [--port N] [--host H] [--no-open] [--live]`** — boots the
  Hono web server. `--live` enables the file-watcher fleet view.

### 3.6 Operate
- **`spool config get|set|list|rm <key>`** — read/write the `settings`
  table. Mirrors the web UI's Settings page; secrets masked unless
  `--reveal` is passed.
- **`spool doctor [--json]`** — environment check. JSON output suitable for
  CI gates (`jq -e '.summary.fail == 0'`).
- **`spool slack`** — Slack webhook test + send.
- **`spool db postgres-init|postgres-sync`** — hosted backend setup.
- **`spool export <run-id> [--no-blobs]`** — dump a run as Spool Trace
  Format v0.2 JSON (with inlined blobs by default).

### 3.7 Settings fallback chain

Several flags fall back to the `settings` table when not explicitly set, so
the same values configured via the web UI's Settings page apply to CLI
commands automatically:

| Flag | Setting key | Env var (env wins over settings) |
|---|---|---|
| `spool web --slack-webhook` | `slack.webhook` | `SPOOL_SLACK_WEBHOOK` |
| `spool web --watch-tool` | `live.watch_tools` (comma-list) | — |
| `spool web --stall-seconds` | `live.stall_seconds` | — |
| `spool fork --live-model` | `fork.default_model` | — |
| `spool fork --max-iterations` | `fork.default_max_iterations` | — |
| `spool db --url` | `postgres.url` | `SPOOL_DB_URL` |

`spool config` is the single source of truth for setting these.

---

## 4. Web UI reference

Single Hono app at `packages/server/src/web.ts`, server-rendered HTML
(`packages/server/src/html.ts`) with surgical client-side JS for mutations.
No SPA framework. Pages share the Cerulean shell (§12).

### 4.1 Pages

| URL | Purpose |
|---|---|
| `/` | Home. Recent runs + fleet snapshot card. |
| `/runs` | Filterable runs list. Filters: status, tool name, project substring. Per-row **Seal** button on `in_progress`. **Seal stale…** bulk action in the filter bar. |
| `/runs/:id` | Run detail. Header (status pill, cost, tokens, branch, project, run id, export links). Timeline of step blocks (color-coded by status). Filter chips (All / Tools / Messages / Errors) + text filter + keyboard nav (`j/k`, `g/G`, `?`). Run annotations. Forks-of-this-run list. One step card per step with Decision / Action / Outcome / Cost / Context tabs. **Seal control** when run is in_progress (status picker + action button — tinted by selection). |
| `/diff?a=&b=` | Trajectory diff. Toggles for show-shared / JSON download. |
| `/contexts/:id` | Resolved context viewer. Walks the `ContextSnapshot` manifest, fetches every `content_ref`, renders system_prompt / tool_definitions / conversation_history (with role badges + char counts) / retrieved_documents / compaction_summary. |
| `/tests` | Regression suite UI. Test list + assertion editor + per-result detail. Run-on-this-run / run-on-all / delete actions. |
| `/settings` | Slack webhook, default fork model, watched tools, stall threshold, Anthropic key, Postgres URL. Secrets masked by default. |

### 4.2 SSE streams

- **`GET /api/live`** — server-sent events from `LiveInspector`. Events:
  `run:created`, `run:updated`, `run:completed`, `alert`, `fleet:snapshot`.
  Driven by the `~/.claude/projects` file watcher when `spool web --live`
  is on.

### 4.3 JSON APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/runs` | list (limit 200) |
| GET | `/api/runs/:id` | one run |
| GET | `/api/runs/:id/steps` | steps for one run |
| GET | `/api/runs/:id/export` | trace.json (with inlined blobs) |
| GET | `/api/runs/:id/annotations` | annotations on a run |
| GET | `/api/steps/:id` | one step |
| GET | `/api/steps/:id/annotations` | annotations on a step |
| GET | `/api/blob/:hash` | raw blob content (read-only) |
| GET | `/api/diff?a=&b=` | structural diff JSON |
| GET | `/api/tests` | list regression tests |
| GET | `/api/tests/:name` | test detail |
| GET | `/api/tests/:name/results` | recent runs of one test |
| GET | `/api/doctor` | environment check (same data as `spool doctor --json`) |
| POST | `/api/runs/:id/close` | seal one in_progress run. body: `{status?: ok\|error\|abandoned}` |
| POST | `/api/runs/close-stale` | bulk seal. body: `{older_than_minutes?, source?, status?}` |
| POST | `/api/annotate` | create annotation |
| POST | `/api/fork` | fork-and-replay (with optional live suffix) |
| POST | `/api/tests` | create regression test |
| POST | `/api/tests/:name/assertions` | replace a test's assertions |
| POST | `/api/tests/:name/run` | run test against one or all matching runs |
| POST | `/api/settings` | upsert setting |
| POST | `/api/ingest` | trigger an ingest from the UI |
| POST | `/api/slack/test` | webhook test |
| POST | `/api/db/postgres-init` | init Postgres schema |
| POST | `/api/db/postgres-sync` | sync SQLite → Postgres |

### 4.4 Mutation patterns

All POST endpoints accept JSON, return JSON, surface errors with a clear
`{error: string}` body and an appropriate HTTP code. The HTML uses
small inline `fetch()` helpers (`closeRun`, `submitAnnotation`,
`submitFork`, etc.) — no SPA framework, no client-side router.

`confirm()` / `prompt()` for destructive or ambiguous actions
(seal-as-status, bulk seal-stale window). Page reloads after success
so the rendered HTML is the source of truth.

---

## 5. Data model + storage

### 5.1 Entity hierarchy

```
Project
  └── Agent (logical identity per project)
        └── Run (single end-to-end execution)
              ├── Step (atomic decision boundary)
              │     ├── ContextSnapshot (the bytes the model saw)
              │     ├── Decision  (model output blob)
              │     ├── Action    (tool_call | message | thinking_only | none | sub_agent_dispatch)
              │     └── Outcome   (status + optional tool_result_ref)
              ├── Annotation (verdict + note, on Run or Step)
              └── Fork (relationship to derived Runs)
```

### 5.2 Schema (`packages/collector/src/schema.ts`)

Schema version: **3**. Tables:

- `meta` — `(key, value)`. Stores `schema_version`.
- `projects` — `project_id`, `name`, `cwd UNIQUE`, `created_at`.
- `agents` — `agent_id`, `project_id`, `name`. `UNIQUE(project_id, name)`.
- `runs` — full run row, JSON-encoded `tags`, denormalized totals
  (`tokens_total_*`, `cost_cents`, `step_count`).
- `steps` — full step row, JSON `action_json`/`outcome_json`/`tags`,
  per-step token columns (input/output/cached_read/cache_creation/
  cache_creation_1h/reasoning), `cost_cents`. `UNIQUE(run_id, sequence)`.
- `context_snapshots` — `(snapshot_id, blob_ref, component_count, created_at)`.
  Maps logical snapshot id (hash of components) to physical blob ref.
- `forks` — `(fork_id, origin_run_id, origin_step_id, fork_run_id, edit_type, edit_payload_json, created_at)`.
- `annotations` — `(annotation_id, target_kind, target_id, author, verdict, note, created_at)`.
- `ingest_progress` — `(source_runtime, source_path, last_offset, last_ingested_at)`.
- `settings` — `(key, value, updated_at)`.
- `redaction_log` — `(blob_ref, rule, count, created_at)` — every redaction
  rule that fired.
- `regression_tests` — `(test_id, name UNIQUE, description, assertions_json, canonical_run_id, created_at)`.
- `regression_results` — `(result_id, test_id, run_id, passed, details_json, created_at)`.

Migration policy: schema is **idempotent additive**. Every `CREATE TABLE
IF NOT EXISTS`, every column-add behind a `PRAGMA table_info` check. No
destructive migrations to date.

### 5.3 Content-addressed blob store

Layout: `~/.spool/blobs/<aa>/<bb>/<sha256>`. Two-level sharding (256 × 256)
keeps any single directory bounded.

- **Write semantics**: write-once. If the file exists at the sharded path,
  trust the SHA. Atomic via tempfile + `rename(2)`.
- **Dedup**: SHA256 — identical content stored once, regardless of how many
  steps reference it.
- **Redaction**: every blob passes through the redaction pass before write.
  Six default rules (`anthropic-key`, `openai-key`, `github-token`,
  `aws-access-key`, `bearer`, `private-key`). Replaces matches with
  `«spool:redacted:<rule>»` placeholders. Disable globally with
  `SPOOL_REDACT=off`. Each firing logs a row in `redaction_log`.
- **Cross-language parity**: TS and Python both implement the same
  `canonical_json` (sorted keys, no whitespace, ensure_ascii=False) so the
  same logical value content-addresses to the same SHA on either side.

### 5.4 Snapshot vs blob refs

A `ContextSnapshot` has two identities:
- `id` — `hashJson(components)`, the logical identity.
- `blob_ref` — the SHA of the JSON-serialized snapshot file as actually
  written. Mapping persisted in `context_snapshots`.

These can differ when a snapshot is round-tripped through export/import
and serialized differently than the original. `resolveSnapshotBlobRef`
handles the lookup.

### 5.5 Postgres backend (optional)

`@spool-ai/store-postgres` mirrors the SQLite schema in Postgres (DDL in
`packages/store-postgres/src/schema.ts`). `spool db postgres-sync` copies
runs/steps/blobs from local SQLite into Postgres for team-tier scenarios.
Not the default — local SQLite is the day-one experience.

---

## 6. Cost engine

`packages/spec/src/pricing.ts` — single source of truth for token-to-cents
math. Used by the SDKs, the proxy, and `spool inspect`/`spool list`. All
writers go through `costCents(model, usage)` so a step's cost is consistent
no matter who recorded it.

### 6.1 Anthropic pricing

Cents per million tokens. Cache writes split 5m vs 1h (the dominant cost
line on long Claude Code sessions). 1h rate falls back to 2× input when
unspecified to avoid silent zero-pricing.

| Model | input | output | cached_read | 5m create | 1h create |
|---|---:|---:|---:|---:|---:|
| `claude-opus-4-7` | 1500 | 7500 | 150 | 1875 | 3000 |
| `claude-opus-4-6` | 1500 | 7500 | 150 | 1875 | 3000 |
| `claude-opus-4-5` | 1500 | 7500 | 150 | 1875 | 3000 |
| `claude-sonnet-4-6` | 300 | 1500 | 30 | 375 | 600 |
| `claude-sonnet-4-5` | 300 | 1500 | 30 | 375 | 600 |
| `claude-haiku-4-5-20251001` | 80 | 400 | 8 | 100 | 160 |

### 6.2 OpenAI pricing

OpenAI exposes one cache tier (no 5m/1h split), so `cache_creation` matches
input rate (writes are free) and `cached_read` gets the discounted rate.

| Model | input | output | cached_read | cache create |
|---|---:|---:|---:|---:|
| `gpt-5` | 125 | 1000 | 12 | 125 |
| `gpt-5-mini` | 25 | 200 | 2 | 25 |
| `gpt-4o` | 250 | 1000 | 125 | 250 |
| `gpt-4o-mini` | 15 | 60 | 7 | 15 |
| `gpt-4-turbo` | 1000 | 3000 | 500 | 1000 |
| `o1` | 1500 | 6000 | 750 | 1500 |
| `o1-mini` | 110 | 440 | 55 | 110 |
| `o3` | 1000 | 4000 | 250 | 1000 |
| `o3-mini` | 110 | 440 | 55 | 110 |

### 6.3 Fallback + approx tagging

Unknown models fall through to `PRICING_FALLBACK` (Opus rates) and the
step gets a `cost:approx` tag. Surfaced in the UI so users know the number
isn't authoritative.

### 6.4 Display convention

**Always dollars, never cents.** The original UI mixed `$0.02` and `5¢`
which made comparisons ambiguous. v0.2 normalized to `$0.05` everywhere
including the table footers, fleet cards, and `spool list` output. The
cost footnote on every page reads: *Costs reflect current vendor pricing
which is broadly understood to be VC-subsidized and may not reflect long-
term economics.*

---

## 7. Live mode + alerts + Slack

### 7.1 LiveInspector (`packages/server/src/live.ts`)

When `spool web --live` is on, `LiveInspector` polls `~/.claude/projects`
every 1500ms and emits `LiveEvent`s (an `EventEmitter`):

```ts
type LiveEvent =
  | { type: "run:created"; run: Run }
  | { type: "run:updated"; run: Run; new_steps: Step[] }
  | { type: "run:completed"; run: Run }
  | { type: "fleet:snapshot"; entries: FleetEntry[] }
  | { type: "alert"; run_id: string; kind: "loop" | "stall" | "context_threshold" | "tool_called"; message: string; meta?: object };
```

These flow to: `/api/live` SSE for the web UI, the in-process `slack.attach()`
for Slack, and `spool watch` for terminal users.

**Silent backfill**: on startup, the inspector ingests existing sessions
without firing events — important so a fresh `spool web --live` against an
old corpus doesn't produce a notification storm. Only post-startup activity
emits events.

### 7.2 Alert kinds

- **`stall`** — no new step in N seconds (default 120, configurable via
  `--stall-seconds` or `live.stall_seconds` setting).
- **`context_threshold`** — context utilization crossed 50/70/90% (default
  thresholds, configurable).
- **`tool_called`** — a watched tool was invoked. Configured via
  `--watch-tool <name>` (repeatable) or `live.watch_tools` setting (comma-
  separated).
- **`loop`** — N identical consecutive tool calls (default window 4).

### 7.3 Slack notifier (`packages/server/src/slack.ts`)

Subscribes to LiveInspector events and POSTs Block Kit attachments to a
webhook URL. Configurable event types (default: `alert` only; can also
forward `run:created` and `run:completed`). Built-in 60s rate-limit window
to avoid storming a channel when a run is in trouble. Validates webhook
URLs (rejects non-Slack hosts) and redacts Anthropic keys before send.

Configure via `slack.webhook` setting (preferred) or `SPOOL_SLACK_WEBHOOK`
env var. Test from the Settings page or `spool slack test`.

---

## 8. Fork + replay + continuation

### 8.1 Fork primitive

`spool fork <run-id> --at <seq> --edit <type>` — the headline feature.

Edit types (`packages/shared/src/types.ts`):

- `replace_system_prompt` — swap the system prompt at the fork point.
- `add_context` — inject an extra context component.
- `remove_tool` — strip a tool from the tool definitions.
- `modify_tool_description` — change a tool's description text.
- `replace_user_message` — overwrite a specific user turn's content.
- `inject_message` — insert a new message at a specific point in history.
- `change_model` — swap to a different model for the suffix.

Mechanics:
1. Walk steps `[0..fork_point)` from the origin run, share their content
   (no copy — content-addressed).
2. Apply the edit to the context snapshot at the fork point.
3. Either:
   - Stop (no suffix — useful for diff'ing the prefix only), or
   - Add one live suffix step via `--live` (calls Anthropic with the
     edited context), or
   - Add one fake suffix step via `--fake "<text>"` (deterministic, for
     tests), or
   - Run a continuation loop via `--continue simulate` or `--continue live`.

The fork is recorded in the `forks` table with `origin_run_id`,
`origin_step_id`, `fork_run_id`, `edit_type`, and the edit payload.

### 8.2 Continuation loop (`packages/server/src/continuation.ts`)

Multi-step replay. Two modes:

- **`simulate`** — model runs live but tool calls are answered from the
  origin run's cached outcomes. Terminal reasons: `model_completed`,
  `simulate_miss` (model picked a tool the origin run never called),
  `max_iterations`, `model_error`.
- **`live`** — model and tools both run live. Tool execution uses a
  caller-provided `ToolExecutor`; the CLI ships a Bash-only safe-mode
  executor that requires explicit `--allow-tool` opt-in and rejects
  obviously-destructive commands. Terminal reasons add `tool_error`.

Both modes cap at `--max-iterations` (default 25) to prevent runaway loops.

---

## 9. Diff engine

`packages/server/src/diff.ts` produces a structural diff aligned by step
sequence after the fork point.

What's compared per step:
- Action (kind, tool name, tool input).
- Outcome (status, summary, presence of error).
- Decision text (truncated to 4000 chars).
- Token usage and cost.
- Context snapshot id (so component changes are visible).

Web UI (`/diff?a=&b=`) renders side-by-side with toggles for:
- **Show shared steps** — by default only diverging steps are shown; toggle
  to see the cached prefix too.
- **JSON download** — full diff payload for offline analysis.

Terminal version: `spool diff <a> <b>`.

Semantic diff (embedding-based alignment for high-divergence forks) is
on the v1 roadmap, not yet shipped.

---

## 10. Regression suite

`packages/server/src/regression.ts` — assertions over captured runs.

### 10.1 Test shape

```ts
interface RegressionTest {
  test_id: string;
  name: string;
  description?: string;
  assertions: Assertion[];
  canonical_run_id?: string;  // optional reference to "the run that defined this test"
  created_at: string;
}
```

### 10.2 Assertion kinds

| Kind | Field | Op | Example |
|---|---|---|---|
| `decision_text_matches` | regex | `match` / `not_match` | "decision contains 'rate limit'" |
| `tool_called` | tool_name | `present` / `absent` | "did/did not call Bash" |
| `tool_call_count` | tool_name | `eq` / `gte` / `lte` | "called Read at most 3 times" |
| `step_count` | — | `eq` / `lte` / `gte` | "completed in ≤10 steps" |
| `final_status` | — | `eq` | "ended ok" |
| `cost_cents_total` | — | `lte` / `gte` | "stayed under $0.50" |

### 10.3 Workflow

- Annotate a "good" run as the canonical example.
- `spool test create <name> --from <run-id>` — auto-derives a starter
  assertion set from the canonical run.
- Edit assertions in the web UI's `/tests` page.
- `spool test run <name>` — runs assertions against every captured run
  whose first user message matches the canonical's, records pass/fail
  in `regression_results`.

Used today to catch model-upgrade regressions and prompt regressions on
your own changes.

---

## 11. Trace format v0.2 (export/import)

`TRACE_FORMAT_VERSION = "0.2.0"`. Exported by
`spool export <run-id>` or `GET /api/runs/:id/export`.

```json
{
  "spool_trace_version": "0.2.0",
  "run":   { /* full Run row */ },
  "steps": [ /* full Step rows in sequence order */ ],
  "blobs": {
    "<sha256>": "<base64-encoded UTF-8 bytes>",
    ...
  }
}
```

Inline blobs by default for self-contained traces. `--no-blobs` (or
`?blobs=0`) ships refs only — much smaller, useful when sharing within
the same machine.

`SUPPORTED_TRACE_VERSIONS = ["0.1.0", "0.2.0"]`. The 0.1 → 0.2 delta is
purely additive (cross-vendor `source_runtime` values, fork/regression
metadata, true content_ref hashes everywhere). Older readers should fall
back to skipping unknown components rather than failing.

---

## 12. Cerulean Design System

The web UI's visual language. Modal-inspired, dark-first, single accent.
All tokens live at the top of `packages/server/src/html.ts` as CSS
variables — the entire UI is a server-rendered HTML string, no
preprocessing step.

### 12.1 Color tokens

**Cerulean (the accent)** — the only saturated color in the system.
Anything that needs to draw the eye (links, primary buttons, focus rings,
section labels, the active tab) is cerulean.

```
--cerulean-50:  #EBF7FC    /* lightest tint */
--cerulean-100: #CFEAF6
--cerulean-200: #A5D9EE
--cerulean-300: #6FC1E1    /* hover */
--cerulean-400: #38BDF8    /* primary accent */
--cerulean-500: #00A6E0    /* active */
--cerulean-600 → 900: deeper / unused at present
```

**Surfaces (dark-first)** — five strict layers, no gradients in the
underlying palette.
```
--surface-0: #08090B       /* page bg */
--surface-1: #0E1014       /* cards / inputs */
--surface-2: #161A21       /* hover, secondary panels */
--surface-3: #1F2630
--surface-4: #2A3340
```

**Text** — five tiers for clear hierarchy.
```
--text-primary:    #E8ECEF
--text-secondary:  #9AA5B5
--text-tertiary:   #5F6B7C
--text-disabled:   #3F4856
--text-on-accent:  #04141E    /* dark text on cerulean fills */
```

**Semantic colors** — only used for status. Never as decoration.
```
--mint-400:   #34D399    /* ok / success */
--coral-400:  #F87171    /* error */
--amber-400:  #FBBF24    /* warn / abandoned */
--violet-400: #A78BFA    /* fork (genealogy) */
```

Each semantic color has a paired `*-bg` token at 8% alpha for tinted
backgrounds (e.g. `rgba(52,211,153,0.08)` for the row-seal hover).

### 12.2 Typography

```
--font-sans: "Geist", "Söhne", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif
--font-mono: "Geist Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace
```

- Body: 14px / 1.5.
- Mono: 12.5px (slightly smaller — IDs and code read densely).
- `font-feature-settings: "ss01", "cv11"` enabled on body for Geist's
  alt sets.
- `-webkit-font-smoothing: antialiased` everywhere.

### 12.3 Spacing + radius + motion

```
--space-1: 4px   --space-2: 8px   --space-3: 12px   --space-4: 16px
--space-5: 20px  --space-6: 24px  --space-8: 32px   --space-10: 40px
--space-12: 48px --space-16: 64px

--radius-xs: 2px  --radius-sm: 4px  --radius-md: 6px
--radius-lg: 8px  --radius-xl: 12px

--duration-fast: 120ms
--duration-default: 200ms
--duration-slow: 400ms
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)

--focus-ring: 0 0 0 2px var(--surface-0), 0 0 0 4px var(--cerulean-400)
```

All hover/focus transitions use `var(--duration-fast) var(--ease-out)`.
Motion is consistent across every interactive element.

### 12.4 Component paradigms

**Section labels** — uppercase tracked mono in cerulean, sit above page
headings. Modal-style. Used for "All runs", "Run notes", "Forks of this
run", etc.

**Pills** — status indicators. Uniform size, color from semantic palette,
optional 6px dot prefix for "live" variants (`pill.live-progressing`,
`pill.live-looping`, etc.).

**Buttons** — three tiers:
- Default: transparent w/ default border, primary text. Fills `surface-2`
  on hover.
- `.primary`: cerulean-400 fill, `text-on-accent` text. The strongest
  call-to-action. Used sparingly (one per page, ideally).
- `.tertiary`: ghost button, cerulean text, transparent border. Used
  for inline secondary actions ("Seal stale…", "clear filter").

**Inputs** — `surface-1` background, default border, cerulean focus ring
via `--focus-ring`. Selects share input styling; native chevron is hidden
on the seal-control's status picker in favor of a CSS-rendered chevron
that matches the visual language.

**Modals** — centered, `surface-1` backdrop with `backdrop-filter: blur`.
Header, body, footer (Cancel + primary action). Used for Annotate,
Fork-from-here, multi-step Fork.

**Step cards** — bordered container per step. Header with sequence
anchor, action kind chip, status pill, model pill, copy-step-id button,
row actions. Body with tab bar (Decision / Action / Outcome / Cost /
Context). Tabs are server-rendered; visibility toggled via
`onclick="showTab(...)"`.

**Seal control** (the §15 split-button) — the exemplar of how to combine
a status picker and an action button into one cohesive control. Status
selection tints the picker by semantic color. See §15 for the markup
template.

**Row-hover ghost buttons** — `opacity: 0.55` default, `opacity: 1` on
parent row hover. Used for actions that aren't always relevant (e.g.
the per-row "Seal" button — only meaningful for `in_progress` runs).
Reduces visual noise on long tables.

### 12.5 Consistency rules

- One accent color (cerulean). Status uses semantic colors; nothing else
  should be saturated.
- Five surface layers — no in-between values. If you want depth, pick the
  next layer.
- Hover/focus motion always `--duration-fast` `--ease-out`.
- Mono font for: all IDs, branch names, file paths, code, timestamps,
  numeric counts in metadata.
- Section labels above every page heading. They're how the user always
  knows where they are.
- Destructive actions (delete) borrow `--coral-400` for border + text
  (the "Delete test" pattern). Sealing/closing is **not destructive** —
  uses the semantic color of the *target status* (mint/coral/amber).

---

## 13. Architecture — package map

Monorepo (`npm workspaces`). 12 packages today.

```
packages/
├── shared/              # Types, hashing, paths, redaction. Zero runtime deps.
├── spec/                # Trace format version + pricing tables.
├── collector/           # SQLite Store + BlobStore + queries + settings + schema.
├── agent/               # TypeScript SDK (SpoolTracer, SpoolStep, traceAnthropic).
├── agent-py/            # Python SDK (spool-agent on PyPI).
├── proxy/               # HTTP forward proxy (Anthropic + OpenAI capture).
├── server/              # Hono app, web UI HTML, live inspector, fork/replay,
│                        # diff, regression, Slack notifier, continuation.
├── store-postgres/      # Optional Postgres backend (mirrors SQLite schema).
├── cli/                 # `spool` binary. All commands, util, store-open.
├── web/                 # (placeholder for future SPA / Tauri renderer)
└── ...

adapters/
├── claude-code/         # Hook-mode adapter (~/.claude/projects/**/*.jsonl)
├── codex-cli/           # Hook-mode adapter (~/.codex)
└── cursor/              # Hook-mode adapter (Cursor's local SQLite)
```

### 13.1 Dependency graph

```
shared ◀── spec ◀── collector ◀── server ◀── cli
                                    ▲
                                    │
                                    └── proxy ◀── cli
                                    └── agent
                                    └── adapters/* ◀── cli
                                    └── store-postgres ◀── cli
agent-py: standalone; writes the same SQLite file directly.
```

`shared` and `spec` are leaves (zero or one internal dep). `collector` is
the storage hub — every writer goes through it. `server` holds all the
heavy logic (web UI, live, fork, replay, regression, Slack, continuation).
`cli` orchestrates; it's the one place that knows about every other package.

### 13.2 Test runner

`scripts/run-tests.ts` walks `packages/` and `adapters/` for `*.test.ts`
files, hands them to `node --test --test-reporter=spec`. One process, one
cold start. Current count: **76 tests, all passing.**

Python tests run separately via `python -m unittest discover -s tests` from
within `packages/agent-py/`. Stdlib unittest only — zero install footprint.

---

## 14. Run grouping (proxy heuristic)

The proxy's hardest design problem: with no `tracer.start()`/`tracer.end()`
brackets, when does request N belong to the same Run as request N-1?

### 14.1 Strategy (priority-ordered)

1. **Explicit grouping wins.** Request carries `x-spool-run-id: <id>` →
   use it. Caller is opting in to authoritative grouping.
2. **Conversation-seed match within window.** Compute
   `seed = sha256(model + system_prompt + first_user_message)`. Look up
   in an in-memory map of `seed → {run_id, step_count, last_messages_count, last_seen_ms}`.
   If found, AND `now - last_seen_ms < 30 minutes`, AND
   `new_request.messages.length >= last_messages_count`, append as next
   step. (The last condition catches the common "user appended a turn"
   shape and rejects unrelated requests that happen to share a first
   message.)
3. **Else, new Run.** Fresh `run_id`, register in the map.

Map cap: 1024 entries. Eviction: drop the oldest 10% by `last_seen_ms`
when full.

### 14.2 Why this and not something cleverer

- **PID attribution doesn't work** — the proxy doesn't see the client's
  pid; it sees a TCP connection. Two processes on the same machine look
  identical.
- **Strict prefix matching** (request N's `messages[0..K]` must equal
  request N-1's full message list) is more precise but breaks when the
  client truncates history for context-window reasons. Conversation-seed
  matching is forgiving of this.
- **Time window of 30 minutes** is a guess. Longer = over-merge unrelated
  conversations that happened to share a prompt. Shorter = split natural
  conversations across coffee breaks. 30 min felt like the right default;
  configurable later if real usage tells us otherwise.

### 14.3 Known limits

- Two parallel agents started with the same prompt within 30 minutes will
  merge into one Run. Mitigation: pass `x-spool-run-id` header per process
  (the `spool run` wrapper could do this automatically — punted to future
  work).
- A user resuming a long-paused conversation after the window expires
  starts a new Run. This is probably correct (the conversation logically
  restarted), but worth flagging.

### 14.4 Tool-result retro-attach

When a request's `messages` array contains `tool_result` blocks (Anthropic)
or `tool` role messages (OpenAI), the proxy parses them as
`pendingToolResults` and patches the originating step's `outcome` row
in-place via `INSERT OR REPLACE`. Steps map: `Map<run_id, Map<tool_use_id,
{step_id, sequence}>>`, populated when a step's action is a `tool_call`.

Net effect: proxy capture loses no information vs the SDK path. Tool
results land on the right step, just with a one-request delay.

---

## 15. Sealing in_progress runs

Proxy-captured runs (and any tracer that exited without calling `.end()`)
have no upstream "I'm done" signal. v0.2 ships **manual sealing** as the
escape hatch.

### 15.1 CLI

```bash
spool runs close <run-id>                                  # default: status=ok
spool runs close <run-id> --status abandoned               # honest about failures
spool runs close --all --source proxy                      # bulk-close every proxy run
spool runs close --all --source proxy --older-than 60      # only those >60min old
spool runs close --all --source proxy --dry-run            # preview without writing
```

Refuses to act on already-sealed runs (with a friendly message).
Recomputes Run totals after sealing — catches any in-flight async proxy
writes that landed between capture and close.

### 15.2 Web UI

- **Run detail page** — "Seal control" appears next to the title when
  `run.status === "in_progress"`. A single rounded segmented control:
  status picker on the left (mono font, custom CSS chevron, tints itself
  by selection — mint for ok, coral for error, amber for abandoned) plus
  a "Seal run" action button on the right with a checkmark icon. Whole
  thing reads as one cohesive unit.
- **Runs list** — `.row-seal` ghost button on each `in_progress` row.
  Opacity 0.55 default, fades to 1 on row hover. Mono font, tight padding,
  prefixed with `✓` on its own hover. Defaults to "ok" — the less-common
  error/abandoned cases live on the run detail page where the picker is.
- **Bulk action** — `.tertiary` link-style button labeled "Seal stale…"
  in the filter bar's right cluster (next to the run count). Only renders
  when at least one in_progress run is on the page. Prompts for an age
  threshold, hits `POST /api/runs/close-stale`.

### 15.3 Endpoints

- `POST /api/runs/:id/close` — body `{status?: "ok"|"error"|"abandoned"}`.
  Returns the updated Run. Validates status; 400 on invalid, 404 on
  unknown id.
- `POST /api/runs/close-stale` — body `{older_than_minutes?: 60, source?,
  status?: "ok"}`. Returns `{closed, run_ids, status}`. Idempotent.

### 15.4 Future direction

Auto-seal sweeper is not shipped. Two reasons:
1. We don't know what the right inactivity window is yet — guessing risks
   sealing a real long-running agent prematurely.
2. The manual UX is one click. If users complain, that's the signal to
   add the sweeper.

If/when added, it'll live as a `LiveInspector` periodic task with a
configurable threshold (default 4h?), and only touches `proxy` /
`sdk-*` source_runtimes (never `claude-code` etc., where the source-of-
truth lives elsewhere).

---

## 16. Roadmap deltas vs original SPEC

The original SPEC.md projected a v0 / v0.1 / v0.2 / v1 path. Status as of
now (v0.2 milestone):

### Shipped (matches SPEC)
- v0: CLI + Claude Code adapter + SQLite + blob store + inspect/list/fork/
  diff/annotate + replay engine + redaction + basic web UI + trace format v0.1
- v0.1: Codex + Cursor adapters · TS SDK · Postgres backend · Live inspector ·
  Notifications · Regression suite · Trace format v0.2
- v0.2 (planned): Python SDK · Cost surfacing (in inspect/list/web)

### Shipped beyond original SPEC
- **Proxy capture** (Anthropic + OpenAI, streaming + non-streaming) — not
  in the original SPEC at all. Major adoption-friction reduction.
- **`spool run -- <command>`** wrapper — auto-injects env vars.
- **`spool watch`**, **`spool open`**, **`spool config`**, **`spool runs
  close`**, **`spool doctor --json`** — terminal QoL improvements.
- **Multi-step fork continuation** (`--continue simulate|live`) — full
  agent loop replay with cached or live tool execution.
- **Anthropic 5m vs 1h cache pricing split** — caught a ~30% under-charge
  on long Claude Code sessions.
- **Settings table** + UI page — shared config between CLI and web.
- **Cerulean Design System** — the original SPEC didn't specify a visual
  language at all. v0.2 has one and it's documented.
- **Resolved-context viewer** — both CLI (`spool inspect --show context`)
  and web (`/contexts/:id`). Walks the manifest, fetches blobs, renders
  the actual conversation.

### Still on the v0.2 list but not shipped
- LangChain / LangGraph adapter (proxy partially covers this — any
  langchain agent that uses the underlying anthropic/openai SDK is captured).
- Vercel AI SDK adapter (same — proxy captures it).
- Sandbox templates.
- Team tier multi-user features.
- Live Probe (pause + inject + resume).
- Public OSS launch.

### v1 (next milestone)
- Semantic diff with embedding-based step alignment.
- Model-upgrade workflow (corpus replay against new model versions with
  diff report). Foundation already exists via the regression suite.
- Browser-agent capture + screenshot timeline.
- Voice-agent capture.
- Enterprise tier (SSO, on-prem, audit logs).
- Auto-seal sweeper for `in_progress` proxy runs (§15.4).
- Conversation-continuity grouping refinements (per-process attribution
  via `x-spool-run-id` header in `spool run`).

---

## 17. Decisions journal

The "why we did it this way" log. Useful when a future change wants to
revisit something.

### Architecture
- **Local-first SQLite + filesystem blobs.** Everything else — Postgres,
  hosted backend, web UI — is a layer on top. A user with no network can
  still capture, inspect, fork, diff. (Original SPEC was firm on this.
  Reaffirmed.)
- **Content-addressed blobs with SHA256.** Free dedup, free integrity
  check, free portability (a blob ref is the same on any machine that
  has the bytes). Tradeoff: can't update content in place (you'd write
  a new blob and update the ref). For an immutable trace store this is
  the right shape.
- **Schema version is additive-only.** Column-adds gated behind
  `PRAGMA table_info` checks. Never rename, never drop. Lets us roll
  forward without coordination across CLI/web/SDK versions.
- **One repo, npm workspaces, no build step.** TypeScript runs via
  `tsx/esm` directly — no `tsc --build` ladder, no compiled `dist/`. Ship
  source. Faster iteration; cost is "you can't `import` without a TS
  runtime", which doesn't apply to the SDK consumers (they import
  compiled JS once published).

### Capture
- **Three modes (hook / SDK / proxy), not one.** Each fits a different
  friction profile. Hook for runtimes you don't own. SDK when you want
  step boundaries you control. Proxy when you want zero code change.
  The original SPEC only had hook + SDK; proxy was added in v0.2 once
  it became clear that "I just want to see what my langchain agent is
  doing" was the dominant non-Claude-Code ask.
- **Direct SQLite from Python, not JSONL emit-and-ingest.** Same
  liveness as the TS SDK — Python runs show up in `spool list`/`spool web`
  immediately. Cost: schema duplication (Python re-implements the DDL).
  Mitigation: idempotent `IF NOT EXISTS` everywhere, and a verbatim copy
  with comments pointing back to the TS source of truth.
- **Stdlib-only Python core.** `pip install spool-agent` should work in a
  venv with no compile step. The Anthropic helper imports `anthropic`
  lazily; `pip install 'spool-agent[anthropic]'` opts in.

### Proxy
- **Multi-provider day one.** Adopting one and deferring the other would
  signal the design wasn't generalizable. Pluggable routing table
  (`PROVIDER_ROUTES`) makes adding a third provider a single-file PR.
- **Stream tee, don't buffer.** Buffering an entire SSE response before
  forwarding to the client breaks the user's UX (no token-by-token
  display). Tee'd stream means the client sees chunks as they arrive;
  capture buffers in parallel.
- **Conversation-continuity grouping over PID/process attribution.**
  PIDs aren't visible from the proxy's TCP perspective. Conversation seed
  is the most reliable signal we have. Acknowledge limits explicitly
  (§14.3), provide explicit override (`x-spool-run-id`) for users who
  need precision.
- **Fire-and-forget capture.** Persist work happens in
  `void persistCapture(...)` after the response returns to the client.
  Adds minor risk of capture-vs-close races (mitigated by a 50ms grace
  delay on `proxy.close()`); buys zero-latency client-facing path.

### Cost
- **5m vs 1h cache split.** Caught only by reading Anthropic's billing
  docs carefully. Original code bucketed all cache writes as 5m, which
  under-charged by ~30% on Claude Code sessions where the system prompt
  + tool defs use the 1h cache. Fix: split tokens by `cache_creation
  .ephemeral_5m_input_tokens` vs `.ephemeral_1h_input_tokens` from the
  usage payload.
- **Dollars everywhere, never cents.** Mixing `$0.02` and `5¢` in the
  same view forced the reader to mentally convert. v0.2 normalized to
  dollars across CLI, web, fleet cards. `fmtCents` returns `$X.XX` (with
  more decimal places for sub-cent values).
- **VC-subsidized cost footnote.** Sub-cent costs make the system look
  cheap. The footnote acknowledges current pricing may not reflect long-
  term economics — important context for capacity-planning conversations.

### Web UI
- **Server-rendered HTML, no SPA framework.** Load is fast, source is one
  file, deep links work, view source still works. Mutations use small
  inline `fetch()` helpers + `location.reload()`. Cost: less interactive
  than a React app would be; benefit: zero build step, zero hydration
  bugs, the whole UI fits in a 2000-line file.
- **Confirm before mutating.** Seal, delete, bulk-close all use
  `confirm()` / `prompt()`. Browser-native, accessible, doesn't need a
  modal component. Less elegant than custom modals but the cost/benefit
  was clear.
- **One accent color (cerulean).** Resists feature creep on the visual
  language. New status types have to fit one of mint/coral/amber/violet
  or argue why a fifth semantic color is needed.

### Run sealing
- **"Seal" not "Close".** `Close` is overloaded in web UIs (modals,
  tabs). `Seal` more accurately describes what happens (state is fixed,
  ended_at written) and avoids the false analogy with closing a window.
- **Status picker tints itself.** The seal control's chevron + label
  picks up the semantic color of the selected status. Click the dropdown
  → see ahead of time what color the row's pill will be after sealing.
- **Manual sealing, no auto-sweeper yet.** §15.4 explains. Defaults to a
  single-click action with sensible status default; bulk action exists
  for the long-tail of forgotten proxy runs.

---

## 18. Glossary

- **Agent.** Logical AI worker identity, persistent across runs.
- **Run.** One end-to-end execution of an agent on a task.
- **Step.** One model invocation plus its consequences. The unit of
  debugging.
- **Context Snapshot.** Full bytes the model saw at a step. Stored as a
  manifest of `ContextComponent`s, each pointing to a content_ref blob.
- **Decision.** The model's raw output at a step (the `decision_ref` blob).
- **Action.** Structured representation of the agent's chosen action —
  one of `tool_call`, `message`, `thinking_only`, `sub_agent_dispatch`,
  `none`.
- **Outcome.** Result of the action (`status: pending|ok|error`,
  optional `tool_result_ref`, optional `is_error`, optional `summary`).
- **Fork.** A new Run derived from an existing Run by replaying to a
  step and applying an edit at that point.
- **Trajectory diff.** Side-by-side comparison of two Runs.
- **Canonical Run.** A Run promoted to expected-behavior status (used
  by the regression suite as the baseline for derived assertions).
- **Hook mode.** Capture by reading runtime-published session logs from
  disk (Claude Code, Codex, Cursor).
- **SDK mode.** Capture by wrapping model and tool calls at instrumentation
  points (`@spool-ai/agent`, `spool-agent`).
- **Proxy mode.** Capture by intercepting HTTP requests to LLM provider
  APIs (`spool proxy`, `spool run`).
- **Source runtime.** The capture origin: `claude-code | codex-cli | cursor
  | sdk-ts | sdk-py | proxy | fork`.
- **Sealing.** Manually transitioning a Run from `in_progress` to a
  terminal status (`ok | error | abandoned`).
- **content_ref.** A SHA256 hash of a blob, used everywhere a value is
  referenced rather than inlined.
- **Snapshot id.** `hashJson(components)` — the logical identity of a
  context snapshot, distinct from its physical `blob_ref`.
- **Cerulean.** The single accent color of the design system. Also the
  name of the design system itself.

---

*End of v0.2 as-built spec. The vision/positioning/business spec is
[`SPEC.md`](./SPEC.md) — preserved unchanged.*
