# Spool — Product Specification

> **Looking for the current product?** This document is the **pre-build
> vision** as drafted before any code was written. For an accurate
> description of the product as it actually exists today (every CLI command,
> every web page, the proxy, the design system, the data model as
> implemented), read **[`SPEC-V0.2.md`](./SPEC-V0.2.md)**. This file is
> preserved unchanged so original intent stays auditable against shipped
> reality.
>
> **Working title.** "Spool" is a placeholder evoking capture, rewind, and threading runs together. Verify availability and trademark before any public surface. Other candidates: Spindle, Replay (taken — replay.io), Cassette, Stagecraft. Name is a v0-launch blocker, not a build blocker.
>
> **Status.** Pre-build. Spec written before code. Two kickoff gates (§18) must clear before week 1 of implementation.
>
> **Author.** Brantley. Drafted May 2026.

---

## 1. One-Line Product

**Spool is the debugger for AI agents.** Capture every run, inspect every decision, fork from any step, diff the trajectories.

The five-second elevator pitch: *Chrome DevTools, but the thing running isn't a webpage — it's an agent.*

---

## 2. The Problem

Agent runtimes are non-deterministic, multi-step, and stateful, but the tools we use to understand them are read-only post-hoc dashboards. Current "agent observability" products (Langfuse, Braintrust, LangSmith, Helicone, Arize Phoenix) treat runs as analytics events. They show you that something happened. They don't let you ask *why*, change one variable, and see what happens instead.

The friction this creates is visible in how the most sophisticated practitioners actually work:

- Boris Cherny (Claude Code, Anthropic) appends a new line to `CLAUDE.md` every time an agent does something wrong — manually maintaining a regression suite because no tool lets him assert "agent should not do X" and verify it.
- Peter Steinberger develops an internal "blast radius" intuition and hits escape when runs go long, becoming a human runtime profiler.
- Jesse Vincent runs an architect-implementer pair across two terminal tabs with manual copy-paste — orchestrating two agents because there's no shared workspace primitive.
- Simon Willison runs "scout" agents at hard tasks with no intent to ship the code, just to see which files they touch. He is running a debugger session without a debugger.
- The Dolthub team builds `bootstrap.sh` per-agent with full database isolation because there's no one-click "new debug sandbox."
- Everyone in the cohort tracks context utilization at the 50/70/90% thresholds manually because no tool exposes it as a live gauge.

ACM research from late 2025 puts Claude Code's logic-error rate at 1.75× human-written code. The cost of those errors compounds across fleet operation — Cherny ships 20–30 PRs per day, Steinberger ships ~100% AI-written code, and neither has a real debugger.

**The bet:** the people running fleets of 10–20 concurrent agents are operating without their generation's equivalent of Chrome DevTools, and the gap will only widen as agent adoption broadens past coding into customer support, browser automation, voice, and vertical workflows.

---

## 3. Product Vision: Three Surfaces

Spool ships as three integrated surfaces. They share a data model but serve distinct workflows.

### 3.1 Inspector — the live view

Real-time view of running agent sessions. The mental model: a window manager for an agent fleet.

For each active session: current task, context utilization, recent tool calls, model identity, suspected status (waiting on input, looping, making progress, drifted, errored). Click in for full DevTools panels scoped to that session.

Solves the "I have 10 agents running, which one needs me?" problem that Cherny solves today with iTerm2 system notifications and Steinberger solves with mental estimates plus an escape key.

### 3.2 Debugger — the post-hoc inspector

Open any past run. Inspect state at every step. Set breakpoints. Fork from any point. Replay with edits. Diff trajectories.

This is the highest-value surface and the v0 wedge. Every other practitioner pain point in §2 is downstream of "I can't replay this run with one thing changed."

### 3.3 Sandbox — the isolated playground

One-click ephemeral environments. Pre-configured agent + tools + verification harness, disposable, parallelizable. Dolthub's `bootstrap.sh` as a product.

Lowest priority for v0. Ships in v0.2 once the data plane is stable.

---

## 4. The Five DevTools Panels, Mapped

| Chrome DevTools | Spool equivalent | Status in current tools |
|---|---|---|
| **Elements** | Context Inspector — full bytes the model saw at every step, including system prompt, tool definitions, retrieved docs, conversation history, and any context-window compaction. | Mostly absent. Trace tools show summaries, not bytes. |
| **Console** | Live Probe — pause a running agent, query its state ("what tools have you considered for this step?"), inject a message, resume. | Absent. All current tools are read-only. |
| **Sources** | Step Debugger — breakpoints on tool calls, regex matches in output, context threshold crossings, sub-agent invocations. Step over / step into / step out. Watch expressions. Time-travel rewind. | Absent. |
| **Network** | I/O Inspector — every tool call, every model call, every retrieval, every MCP exchange, full payloads, timing, retries. | Partially present in Langfuse/Braintrust. Missing replay. |
| **Performance** | Run Profiler — flame graphs of token spend per step, cache hit rates, context utilization over time, time-to-completion attribution. | Token counts only. No structural attribution. |

The **fork-and-diff primitive** sits above all five: take a real run, change one input (prompt, tool description, context, tool order, system instruction), replay, see exactly where trajectories diverge. This is the unit of debugging for non-deterministic systems and it is structurally missing from every product in the category.

---

## 5. Target Users

### 5.1 Primary persona: the fleet operator

The cohort profiled in the Heavy Users report. Cherny, Steinberger, Ronacher, Vincent, Willison, Dolthub. Independent developers, solo founders, small teams running 3–20 concurrent agents on a single codebase.

**Tools today:** Claude Code or Codex CLI, terminal grid, git worktrees, `CLAUDE.md` / `Agents.md`, `gh` CLI, occasional MCP, manual post-mortem reading of failed sessions.

**Pain ranked:** (1) failed runs they can't diagnose, (2) regression — agent stops doing something it used to do well, (3) prompt iteration without a feedback loop, (4) parallel-agent coordination, (5) context-window mysteries (why did Claude forget X), (6) tool selection mysteries (why didn't it use the obvious tool).

**Buying authority:** themselves. Will pay personal subscriptions for tools that compound their throughput. Reference: Steinberger pays $1k/month for AI subs personally.

### 5.2 Secondary persona: the agent platform team

Inside companies that have shipped non-coding agents to production. Customer support deployments (Intercom Fin, Decagon, Sierra), sales SDR agents (11x, Artisan), vertical agents (Harvey, Abridge), internal RPA-style workflows (Salesforce Agentforce, UiPath, Copilot Studio).

**Tools today:** vendor dashboards + custom-built internal observability, frequently a thin layer on top of Langfuse or Datadog.

**Pain ranked:** (1) production incidents — agent did the wrong thing for a real customer, why, (2) regression after model upgrade — vendor switched the underlying model and behavior changed, (3) prompt regression after their own change, (4) compliance / audit — show me why this decision was made, (5) cost attribution per workflow.

**Buying authority:** platform / infra eng leads, AI program owners. Multi-seat licenses, annual contracts.

### 5.3 Tertiary persona: the agent framework / runtime author

Authors of harnesses, frameworks, and runtimes — Anthropic (Claude Code), OpenAI (Codex CLI), Cursor team, LangChain, LlamaIndex, CrewAI, Mastra, Vercel AI SDK, plus custom in-house runtimes inside larger orgs.

**Why they matter:** they decide what their runtimes expose for introspection. Their adoption of an open trace format is the moat for cross-vendor positioning (§16).

**They are not customers.** They are integration partners. The relationship is closer to OpenTelemetry's relationship with cloud providers than to a vendor-customer relationship.

---

## 6. Core Concepts and Data Model

The data model is the most important part of the spec. It determines what every other surface can do.

### 6.1 Entity hierarchy

```
Project
  └── Agent (logical identity — "the support agent for customer X")
        └── Run (single end-to-end execution)
              └── Step (atomic decision boundary)
                    ├── Context Snapshot (what the model saw)
                    ├── Decision (what the model output)
                    ├── Action (tool call, message, sub-agent dispatch)
                    └── Outcome (tool result, error, state change)
```

### 6.2 Step

A Step is the unit of debugging. One Step represents one model invocation plus its immediate consequences.

Every Step captures:

- **`step_id`** — globally unique, stable across replay
- **`parent_step_id`** — for sub-agent invocations and forks
- **`fork_origin_id`** — if this step is the divergence point of a fork
- **`run_id`** — owning run
- **`sequence`** — ordinal within run
- **`timestamp`** — wall clock
- **`model`** — model identity including version (`claude-opus-4-5-20260301`, etc.)
- **`context_snapshot_id`** — pointer to full context bytes
- **`decision_id`** — pointer to model output bytes
- **`action`** — structured representation of what the agent decided to do
- **`outcome`** — structured representation of what happened
- **`tokens`** — input, output, cached, reasoning
- **`latency_ms`** — model time and end-to-end
- **`cost_cents`** — computed from model pricing table
- **`tags`** — free-form labels for searching

### 6.3 Context Snapshot

The full bytes the model saw. Not a summary. Not a redacted view. The actual input.

Stored content-addressed (SHA256 of the bytes) with dedup, because consecutive Steps share ~95% of their context. A 100-step run with 100k context per step doesn't take 10MB; it takes ~200KB after dedup plus the deltas.

Schema:

```yaml
context_snapshot:
  id: <sha256>
  components:
    - type: system_prompt
      content_ref: <sha256>
    - type: tool_definitions
      content_ref: <sha256>
    - type: conversation_history
      messages:
        - role: user | assistant | tool
          content_ref: <sha256>
          step_ref: <step_id>  # which step this came from
    - type: retrieved_documents
      docs:
        - source: <uri>
          content_ref: <sha256>
          retrieval_step_ref: <step_id>
    - type: compaction_summary
      replaces_steps: [<step_id>, ...]
      content_ref: <sha256>
```

Every component is independently addressable. This is what makes "diff two runs at step 12" tractable.

### 6.4 Fork

A Fork is a Run derived from another Run by replaying up to a step and applying an edit.

```yaml
fork:
  fork_id: <uuid>
  origin_run_id: <run_id>
  origin_step_id: <step_id>
  edit:
    type: replace_system_prompt | add_context | remove_tool | modify_tool_description | replace_user_message | inject_message
    payload: <type-specific>
  fork_run_id: <run_id>  # the new run produced by this fork
```

Forks compose. You can fork a fork.

### 6.5 Annotation

A user-attached label on a Step or Run.

```yaml
annotation:
  target: step_id | run_id
  author: <user>
  verdict: correct | incorrect | unclear | good_decision | bad_decision
  note: <freeform>
  created_at: <iso>
```

Annotations are the human-in-the-loop training signal. They feed regression suites (§7.3) and eventual model-evaluation tooling.

---

## 7. Feature Specification

### 7.1 Inspector (live)

**Fleet view.** Grid of active sessions. Each card shows:

- Agent identity + current task summary (first line of last user message)
- Context utilization bar with 50/70/90% threshold markers
- Last 3 tool calls (compact)
- Time since last activity
- Suspected status (heuristic): `progressing`, `stalled`, `looping`, `awaiting_input`, `errored`
- Estimated cost so far

**Notifications.** Subscribable triggers:

- Run completed
- Context crossed threshold
- Specific tool called (e.g., notify me when any agent calls `git push`)
- Loop detected (same tool with same args > N times)
- Stalled (no activity for > N minutes)

**Live Probe.** Open any active session, pause execution (graceful — wait for current model call to complete), inject a probe message visible only to the human ("what are you about to do next?"), or modify the next user message before sending. Resume.

**Steering.** A constrained version of Probe. Without pausing, append a steering note to the next agent prompt ("focus on the API layer first"). Lower-friction than full pause/probe.

### 7.2 Debugger (post-hoc)

**Run browser.** List of past runs with filters: agent, project, status, date range, model, tags, cost range, contains-error, contains-tool-call.

**Step timeline.** Horizontal timeline of a run. Each Step is a block. Click to inspect. Color-coded by outcome (success / error / abandoned). Width proportional to latency or token spend (toggle).

**Step inspector.** For the selected Step:

- **Context tab.** Full context the model saw, hierarchically organized (system, tools, history, retrieved). Click any component to see its bytes. Diff against previous step's context (what changed).
- **Decision tab.** Raw model output. Reasoning trace if available. Tool call structure.
- **Action tab.** Structured action representation. Tool name, args, expected outcome.
- **Outcome tab.** Tool result, error trace if failed, state delta.
- **Cost tab.** Tokens in/out/cached, latency, model, computed cost.

**Search within run.** Full-text search across all Steps. "Find all Steps where the agent called `bash` with `rm`."

**Breakpoints (on replay).** Conditions under which a replayed run pauses for inspection:

- On tool call (name match or args regex match)
- On output regex match
- On context threshold crossing
- On step index
- On error
- On model reasoning containing keyword

**Watch expressions.** User-defined extractors that surface a value on every step. Examples: "current value of the `plan` variable as last referenced in agent reasoning," "files modified so far," "tokens used."

**Fork interface.** Right-click any Step → "Fork from here with edit." Edit types:

- Replace system prompt
- Add tool / remove tool / edit tool description
- Replace user message at this step
- Inject message before this step
- Replace retrieved document
- Change model
- Change model parameters (temperature, top_p, reasoning mode)

After edit, choose replay mode:

- **Deterministic prefix, fresh suffix.** Replay up to fork point using cached responses. Run live from fork point. (Default.)
- **Fully live.** Re-run from start with the edit applied. More accurate but expensive.

**Trajectory diff.** Open two runs (typically a run and its fork). Side-by-side step timeline. Steps with identical context align. Divergence points highlighted. Click a divergence to see the context diff and the resulting decision diff.

### 7.3 Regression suite (built on Debugger primitives)

A Run can be promoted to a **Canonical Run** — frozen expected behavior. Future runs of the same agent on a similar task can be compared against canonicals.

A **Regression Test** is:

- An input (user message + initial state)
- An expected behavior, expressed as:
  - Specific tool calls that must occur (`includes_tool_call("git_commit")`)
  - Specific outputs that must / must not appear (`output_contains("approved")`, `output_does_not_contain("sorry, I cannot")`)
  - Decisions matching annotated good steps from a canonical run
  - Final state matching a target spec
- A pass/fail evaluator (assertion-style, plus optionally an LLM judge)

Regression suites run on a schedule, on model upgrade, on prompt change, on tool change.

This is the productized version of Cherny's "add a line to `CLAUDE.md` every time the agent does something wrong."

### 7.4 Sandbox (v0.2+)

**Environment templates.** Reusable definitions of an agent runtime — Dockerfile, bootstrap script, agent harness config, tool config, env vars.

**One-click ephemeral env.** Spin up a fresh isolated environment from a template. Disposable. Parallel.

**Bring-your-own-runtime.** For users who want to use their own infra (local Docker, their own cloud), Spool provides the data plane only.

---

## 8. Detailed User Flows

### 8.1 Flow: debugging a failed run

1. Cherny opens Spool, sees yesterday's run with status `errored`.
2. Opens run. Step timeline shows 47 steps; last step is red (error).
3. Clicks last step. Action tab shows `bash("npm test")`. Outcome tab shows test failure with stack trace.
4. Clicks previous step. Action tab shows file edit. Decision tab shows the model's reasoning for the edit.
5. Sets a breakpoint on the previous step. Forks the run with an edit: replace the user message at step 30 to be more specific about which tests to update.
6. Replays. New run completes successfully in 38 steps.
7. Opens trajectory diff. Sees that the divergence happened at step 33 — with clearer instructions, the agent took a different approach to the file edit.
8. Promotes the original failed step to a regression test: "given this user message, the agent should NOT modify the test file in this way."

### 8.2 Flow: prompt iteration

1. Vincent has an architect agent prompt he's been tuning for two weeks.
2. He has a corpus of 8 past runs where the architect produced output he was happy with, all annotated.
3. He edits the system prompt to be tighter.
4. He clicks "rerun corpus" — Spool re-runs all 8 historical user messages with the new system prompt.
5. Trajectory diff shows 6 runs converged to similar good outputs, 2 diverged.
6. He opens the 2 divergent runs. Sees that the tighter prompt over-constrains the architect on planning-heavy tasks.
7. Adjusts the prompt. Reruns. All 8 converge.
8. Promotes the new prompt to production.

### 8.3 Flow: model upgrade regression

1. Anthropic ships Opus 4.6.
2. A platform team running a customer support agent in production wants to validate the upgrade.
3. They take the last 1000 production runs (anonymized, replayed locally), re-run them against Opus 4.6, and produce a diff report.
4. 94% of runs converge to similar outputs. 6% diverge.
5. Of the 6% divergent, Spool clusters them into ~12 buckets. Three buckets are improvements (4.6 handles edge cases 4.5 mishandled). Nine buckets are regressions.
6. Team decides to roll out 4.6 with a hard route to 4.5 for the 9 regression buckets, plus open three regression tests for the new behavior.

### 8.4 Flow: tool design

1. Steinberger has added a new `database_query` tool to his agent.
2. He runs his standard task corpus.
3. Opens the Run Profiler. The new tool is rarely selected; the agent reaches for `bash("psql ...")` instead.
4. Opens a representative run, inspects the step where the agent chose `bash`. The reasoning shows the model didn't see the new tool's purpose clearly.
5. Forks the run with a clearer tool description. Replays.
6. New run uses `database_query` correctly.
7. Updates the production tool description.

### 8.5 Flow: live intervention

1. Cherny launches 12 agents on parallel tasks.
2. Spool notification: agent #7 is in a suspected loop (same tool with same args 4 times).
3. Opens Inspector for #7. Confirms the loop — agent is retrying a failing test with the same fix.
4. Live Probe: injects a message — "the test is failing because of a stale fixture, not your change. Reset fixtures with `npm run reset:fixtures` before running the test again."
5. Resumes. Agent completes the task on the next attempt.

### 8.6 Flow: team handoff

1. Vincent ends his work day with three agents mid-task.
2. He generates a handoff summary from Spool: status of each, what's been tried, what's pending.
3. Coworker picks up in the morning, opens the handoff, sees the full state, decides which to continue and which to abandon.

---

## 9. Success Modes (use cases where Spool wins)

1. **Failed run debugging.** The acute pain. Every fleet operator has multiple of these per week.
2. **Prompt iteration with a real feedback loop.** Replaces vibes-based iteration with corpus-based regression.
3. **Tool design.** Inspect why the agent doesn't use a tool you built for it.
4. **Context engineering.** See what's actually in the window. Diagnose compaction and retrieval failures.
5. **Cross-session pattern discovery.** "What approaches has this agent tried before for similar tasks?" Adjacent to the Profile / fleet-memory thesis but post-hoc rather than injected.
6. **Model upgrade validation.** Run a corpus against a new model. Diff at scale.
7. **Cost attribution.** Per-task, per-tool, per-model spend with structural breakdown.
8. **Compliance / audit.** For regulated industries: a queryable record of why an agent made each decision.
9. **Regression testing.** Promoted runs become tests. Catch behavioral drift.
10. **Multi-agent coordination debugging.** Inspect parent-child agent relationships, find where coordination broke down.
11. **Performance optimization.** Find the slow steps. Find the cache-miss steps. Find the redundant tool calls.
12. **New-team-member onboarding.** Browse a senior engineer's past runs to learn how they prompt and steer agents.
13. **Adversarial testing.** Fork production runs with malicious inputs. See how the agent handles them.
14. **Migration between harnesses.** Run the same task on Claude Code and Codex CLI. Diff behavior.

---

## 10. Failure Modes (product fails to deliver value)

These are ordered by likelihood.

### 10.1 The data capture is too expensive or too lossy

If Spool captures everything, runs slow down and storage costs balloon. If it captures less, the Debugger loses fidelity.

**Mitigation:** content-addressed storage with aggressive dedup. Async write path so capture doesn't block agent execution. Configurable retention (full bytes for last 30 days, summaries beyond that). Open-source agent for self-hosted capture so storage cost is the user's choice.

### 10.2 Fork-and-replay produces useless diffs

If LLM responses are too non-deterministic, replaying with one variable changed might produce wildly different trajectories for reasons unrelated to the change. The diff becomes noise.

**Mitigation:** support cached-prefix replay (deterministic until the fork point, fresh after). For users on models with seeded inference, capture seeds. For others, run forks multiple times and surface a probabilistic divergence map ("this change consistently leads to X" vs "this change has mixed effects").

This is the single biggest technical risk. If forks don't produce signal, the headline product is broken.

### 10.3 Users want analytics, not debugging

Many "agent observability" buyers want a dashboard with metrics for a weekly review meeting, not a debugger for individual runs. They are not the same buyer.

**Mitigation:** explicitly position against analytics tools. Don't ship a metrics dashboard in v0. Force the value prop into "we are the IDE for agent execution; analytics is downstream."

### 10.4 Anthropic / OpenAI ship native debugging

The named threat. Anthropic could announce a Claude Code debug view at any time. OpenAI ships Codex Cloud features rapidly.

**Mitigation (defensive):** cross-vendor positioning from day one. Spool's value compounds across runtimes; a native tool by definition cannot. Ship integrations for at least three runtimes before any of them ship their own debugger.

**Mitigation (offensive):** stay ahead on the *workflow* (fork-and-diff, regression suites, fleet view), not just the data view. A native Anthropic debugger is likely to show traces well but unlikely to ship a cross-run regression suite or a vendor-agnostic fork primitive.

### 10.5 Privacy / security blocks enterprise adoption

Spool captures full context bytes — prompts, retrieved docs, conversation history. For enterprise buyers this is sensitive. Production runs may include PII, source code, customer data.

**Mitigation:** self-hosted from day one. Local-only mode for the v0 (CLI + local SQLite). Enterprise tier with on-prem or VPC deployment. Optional automatic PII redaction pass on capture.

### 10.6 The cross-vendor moat doesn't materialize

OpenTelemetry succeeded because tracing was already heterogeneous. Agent runtime debugging may consolidate around 2–3 vendors who own the runtime and the debug surface together. The "open spec" play assumes fragmentation that may not happen.

**Mitigation:** publish the trace format as an open spec early. Court framework authors (LangChain, Mastra, Vercel AI SDK) as integration partners before they ship their own. This is a relationship game, not a product game.

### 10.7 Coding-agents-only is too narrow but expansion is hard

The dev tool aesthetic that works for Cherny and Steinberger doesn't translate to a customer support ops manager.

**Mitigation:** verticalize the UI but share the data plane. v1 ships a separate UI surface for non-coding agents while reusing the entire capture/storage/replay backend. Pricing scales with the non-coding vertical because the buyer is enterprise, not individual.

### 10.8 The "debugger" framing is too engineer-coded

Senior engineering managers, AI program owners, and compliance leads don't open a debugger. They open a dashboard. If the only entry point is a debugger, the buyer-user gap kills enterprise expansion.

**Mitigation:** the same data model supports both surfaces. v1 introduces an "Audit" view that's queryable and report-generating for non-engineer buyers, sharing the underlying captures.

### 10.9 Founder bandwidth

Concurrent ventures: Gilld, Donaldson Lake, Hotpath (or this), property project, NVIDIA application. Spool is a real platform product that demands focused execution.

**Mitigation:** explicit decision required before kickoff. See §22.

### 10.10 Naming, packaging, distribution missteps

Solvable but underestimated. The CLI must `npx`-install in one command. The web UI must work offline (local mode). The trace format must be readable in 5 minutes by a new integrator. Bad ergonomics at any of these layers kills adoption before the product is evaluated on merit.

---

## 11. Failure Modes (agent failures Spool helps debug)

A taxonomy of what goes wrong in agent runs, with notes on how Spool addresses each.

| Failure category | Symptom | How Spool helps |
|---|---|---|
| **Tool misuse** | Agent calls a tool with wrong args, ignores a tool that fits, calls a tool repeatedly | I/O Inspector + tool-call breakpoints + tool-design fork flow (§8.4) |
| **Hallucinated capability** | Agent claims it did something it didn't | Step-by-step action vs outcome diff; outcome assertions in regression suite |
| **Context compaction loss** | Agent forgets critical info from earlier in run | Context Inspector shows compaction summaries and what they replaced |
| **Retrieval failure** | RAG returned wrong docs or no docs | Context Inspector exposes retrieved doc set; fork with corrected retrieval |
| **Reasoning drift** | Agent abandons original plan mid-run | Watch expressions on plan state; fork from point of drift |
| **Looping** | Same action repeated with same args | Live Probe loop detection; breakpoint on N-repeat |
| **Premature completion** | Agent claims task done with incomplete work | Outcome assertions; regression test for required-step coverage |
| **Stuck on permissions** | Agent waiting for human approval on a benign action | Inspector status `awaiting_input` surfaces this immediately |
| **Sub-agent misdispatch** | Parent picks wrong sub-agent or wrong scope | Parent-child step graph in Debugger |
| **Cost runaway** | Long thinking loop, expensive model used unnecessarily | Cost tab per step; cost-threshold breakpoint |
| **Race conditions in parallel work** | Two agents make incompatible edits to shared file | Inspector fleet view exposes concurrent file targets |
| **Model regression after vendor update** | Same prompt produces worse output on new model version | Corpus replay + trajectory diff (§8.3) |
| **Prompt regression after own edit** | User's prompt change breaks previously-working tasks | Corpus replay against canonicals |
| **Brittle test interpretation** | Agent declares success on a passing-but-meaningless test | Outcome inspection + assertion-based regression tests |
| **Credulous review acceptance** | Agent implements bad suggestions from review tools (Vincent's pattern) | Decision inspection at review-handling step + behavioral breakpoints |

---

## 12. Technical Architecture

### 12.1 Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Runtime                            │
│  (Claude Code / Codex CLI / Cursor / custom SDK / vertical)     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ instrumentation
                           ▼
                ┌──────────────────────┐
                │   Spool Agent (SDK)  │  ← language-specific
                │  - intercepts I/O    │     (TS, Python first)
                │  - captures bytes    │
                │  - emits OTel-style  │
                │    spans + payloads  │
                └──────────┬───────────┘
                           │ traces + content blobs
                           ▼
                ┌──────────────────────┐
                │   Spool Collector    │  ← local CLI process
                │  - dedup + compress  │     or hosted endpoint
                │  - SHA addressing    │
                │  - schema validate   │
                └──────────┬───────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌──────────────┐         ┌──────────────────┐
     │   SQLite     │         │  Object Store    │
     │  (metadata)  │         │  (content bytes) │
     └──────┬───────┘         └────────┬─────────┘
            │                          │
            └──────────┬───────────────┘
                       ▼
            ┌────────────────────┐
            │   Spool Server     │  ← local or hosted
            │  - query API       │
            │  - replay engine   │
            │  - fork engine     │
            │  - diff engine     │
            └─────────┬──────────┘
                      │
              ┌───────┴────────┐
              ▼                ▼
        ┌─────────┐      ┌───────────┐
        │   Web   │      │    CLI    │
        │   UI    │      │           │
        └─────────┘      └───────────┘
```

### 12.2 Capture

Two capture modes:

**Hook mode (zero-code).** For runtimes that publish session logs (Claude Code writes JSON sessions to local storage), Spool reads from disk. No instrumentation needed. Latency: end-of-session or polled.

**SDK mode (live).** For custom agents and runtimes that support hooks, the SDK wraps model calls and tool calls. Emits OTel-format spans with full payload bytes. Latency: real-time.

Hook mode ships first because it covers Claude Code without integration work. SDK mode ships in v0.1 for custom-harness users.

### 12.3 Storage

**Metadata layer:** SQLite (local) or Postgres (hosted/team). Stores entity hierarchy, indexes, annotations, fork relationships, regression suite definitions.

**Content layer:** content-addressed blob store. Local mode: filesystem with SHA-prefix sharding. Hosted mode: S3-compatible. All content immutable. Dedup by SHA256.

Storage budget: ~1MB per 100 steps after dedup for typical coding-agent runs. A heavy user with 30 runs per day at 50 steps each = ~15MB per day. Cheap.

### 12.4 Replay engine

Deterministic prefix replay:

1. Load original run's step sequence.
2. Walk from step 0 to fork point.
3. For each step, replay tool calls using cached outcomes (if tool is pure) or live calls (if tool is impure — and warn user).
4. For each model call before fork point, return the cached response.

Fresh suffix:

5. At fork point, apply the edit to the context.
6. Resume live execution from the modified state.
7. Capture the new run as a child of the original.

Determinism is best-effort. Tools that depend on external state (filesystem, network, time) are flagged. Users can opt into "snapshot the world" before fork for full reproducibility (heavy, optional).

### 12.5 Fork mechanism

Forks share the prefix Steps of their origin (content-addressed, no copy). They diverge at the fork point. The fork relationship is stored as a graph; trajectory diff walks both runs in parallel.

### 12.6 Diff engine

Two diff modes:

**Structural diff.** Aligns steps by sequence number after the fork point. Shows context changes, decision changes, action changes, outcome changes. Best when forks stay roughly parallel.

**Semantic diff.** Uses embedding similarity to align steps when sequence diverges (one fork takes 20 steps, the other takes 35). Surfaces "this step in fork A corresponds to that step in fork B." Less precise; useful for high-divergence cases.

---

## 13. Integration Matrix

| Runtime | Capture mode | v0 | v0.1 | v0.2 | v1 |
|---|---|---|---|---|---|
| Claude Code | Hook | ✅ | | | |
| Codex CLI | Hook | | ✅ | | |
| Cursor (Agents window) | Hook | | ✅ | | |
| Aider | Hook | | | ✅ | |
| Custom SDK (TS) | SDK | | ✅ | | |
| Custom SDK (Python) | SDK | | | ✅ | |
| LangChain / LangGraph | SDK | | | ✅ | |
| Vercel AI SDK | SDK | | | ✅ | |
| Mastra | SDK | | | ✅ | |
| Browser agents (Stagehand, Browser Use) | SDK | | | | ✅ |
| Voice agents (Vapi, Retell) | SDK | | | | ✅ |
| Sierra / Decagon / vertical CS | Partner SDK | | | | ✅ |

v0 is Claude Code only. This is intentional: dogfoodable, the highest-density user cohort, smallest integration surface.

---

## 14. Non-Coding Agent Extension

The data model in §6 is agent-runtime-agnostic. The differences across verticals are in **I/O modality** and **verification harness**, not in the entity hierarchy.

### 14.1 Browser agents

- **Action type:** DOM operations (click, type, navigate, wait).
- **Outcome type:** DOM diff + screenshot + URL state.
- **Special inspector:** screenshot timeline; click-to-DOM-state.
- **Special breakpoint:** on navigation, on form submit, on selector match.
- **Use case spike:** captcha loop debugging, login-wall failures, dynamic content timing.

### 14.2 Voice agents

- **Action type:** speech output, function call.
- **Outcome type:** user speech input (transcribed + audio reference).
- **Special inspector:** audio timeline scrubbable in sync with transcript.
- **Special breakpoint:** on silence threshold, on barge-in, on sentiment shift, on specific user phrase.
- **Use case spike:** unhandled interrupt debugging, escalation trigger analysis.

### 14.3 Customer support agents

- **Action type:** message send, escalation, ticket update, knowledge retrieval.
- **Outcome type:** customer response, ticket state, resolution status.
- **Special inspector:** conversation timeline; KB retrieval source list.
- **Special breakpoint:** on escalation decision, on policy lookup, on refund issued.
- **Use case spike:** "why did the agent escalate this when policy says it shouldn't have"; compliance audit.

### 14.4 Sales / SDR agents

- **Action type:** email send, CRM update, calendar action.
- **Outcome type:** recipient response, deliverability, CRM state.
- **Special inspector:** outreach timeline; persona tagging.
- **Use case spike:** "why did the agent send a templated email when it had personalized data available."

### 14.5 Vertical agents (legal, healthcare, accounting)

- **Action type:** domain-specific (cite case, summarize record, extract entity).
- **Outcome type:** human reviewer verdict.
- **Special inspector:** citation graph, source highlighting.
- **Use case spike:** compliance audit, hallucination detection, source attribution.

Across all of these, the **fork primitive** retains value: change one input, see how the agent's decision changes. This is the universal axis.

---

## 15. Pricing & Business Model

Three tiers, ordered by buyer.

### 15.1 Open Source (free)

The Spool Agent (SDK) and Spool Collector are MIT-licensed and self-hostable.

What's open: capture, storage, replay primitives, CLI inspector, trace format spec.

What's not: hosted UI, team collaboration, regression suite scheduler, model-upgrade diff workflows, audit reporting, vendor adapters for closed-source runtimes.

Goal: maximize adoption, establish the trace format as a standard, get integration partners on-board.

### 15.2 Individual ($20/mo)

Hosted backend, web UI, unlimited local-run history, single-user only.

Reference point: Cursor at $20, Linear at $8, Raycast at $8. Individual developers pay for tools that compound their throughput; price-anchored to the lower end because the value prop is augmentation, not seat-cost-replacement.

Target audience: Cherny-type, Steinberger-type. Solo founders, indie developers, freelancers.

### 15.3 Team ($50/seat/mo)

Multi-user, shared runs, team-level regression suites, role-based access, shared annotations, fleet dashboards across teammates.

Target audience: small engineering teams using coding agents heavily; AI platform teams shipping non-coding agents to internal users.

### 15.4 Enterprise (custom)

Self-hosted or VPC deployment, SSO, audit logs, custom retention, custom integrations (vendor adapters for in-house runtimes), compliance certifications.

Target audience: regulated industries (legal, healthcare, financial services); large companies running production agent deployments at scale.

Reference ACV: $50k–$500k depending on scale. Two-quarter sales cycle.

### 15.5 Why this works financially

Coding-agent users are price-insensitive at the individual tier (already paying $200/mo+ for Claude/Codex). Team-tier monetization tracks team growth in agent ops. Enterprise tier funds the deep work.

The open-source agent is a Trojan horse: capture is the moat. Once a team's data lives in Spool's trace format, switching costs are real even though the format is open.

---

## 16. Competitive Landscape

### 16.1 Direct competitors (agent observability)

- **Langfuse** — open-source, strong tracing, weak debugging. Analytics-first.
- **Braintrust** — strong evals, weaker live debugging. Eval-first.
- **LangSmith** — LangChain-coupled. Reasonable tracing, weak fork/diff.
- **Helicone** — proxy-based, light observability.
- **Arize Phoenix** — open-source, ML-eval roots, now agent-adjacent.

None of these have fork-and-replay. None of these have a live debugger. Most are read-only post-hoc dashboards.

### 16.2 Adjacent competitors

- **Datadog APM / New Relic** — generic APM is starting to add LLM hooks but is too generalist for agent debugging.
- **Cursor / Claude Code native logs** — runtime-specific, not cross-vendor, no fork primitive.
- **Replay.io** — browser-focused time-travel debugging, conceptually adjacent, different market.

### 16.3 Indirect competitors

- **Eval frameworks** (Inspect, OpenAI evals, Promptfoo) — evaluation, not debugging. Different workflow.
- **Tracing standards** (OpenLLMetry, OpenInference) — open standards for trace format. Spool should adopt or extend rather than compete.

### 16.4 The "killed by the platform" risk

- **Anthropic** ships native Claude Code debugger.
- **OpenAI** ships Codex Cloud trace view.
- **Cursor** ships Agents Window inspector.

In each case, Spool's value differentiates on (a) cross-vendor, (b) workflow depth (fork, diff, regression), (c) production / enterprise features the runtime vendors will deprioritize relative to their own market.

---

## 17. Go-To-Market

### 17.1 Phase 0: cold outreach (pre-build)

Three founders reach out to:

- Boris Cherny (Anthropic, Claude Code) — highest leverage; if Spool gets his blessing, integration risk drops.
- Peter Steinberger — most public on workflow; Codex CLI user, validates cross-vendor.
- Jesse Vincent — architect/implementer pattern is the canonical multi-agent workflow.
- Simon Willison — cautious-convert voice; if he writes about Spool, signal compounds.
- Armin Ronacher — opinionated on tooling; YOLO mode user, validates capture in heavy-permission setups.
- Tim Sehn (Dolthub) — platform-team perspective; validates self-hosted enterprise angle.

Message: not a pitch. A question. "What do you wish existed for inspecting and debugging your agent fleet? What have you hand-rolled?"

Threshold: one reply within 14 days = signal to build. Zero replies = iterate on channel or rethink.

### 17.2 Phase 1: dogfood (4–6 weeks)

Founder uses Spool on every Claude Code session for 4 weeks. Daily. Targets: ≥3 multi-session tasks per week. Generates ≥10 forks across 4 weeks. Identifies ≥5 cases where the Debugger surfaced something they wouldn't have found otherwise.

### 17.3 Phase 2: closed alpha (weeks 6–10)

10 hand-picked users from the §17.1 outreach. Direct Slack contact. Weekly office hours. Heavy listening.

Goal: turn at least 3 into public users (blog post, X thread, podcast mention).

### 17.4 Phase 3: open source launch (weeks 10–14)

Show HN. Blog post: "We built the debugger we wanted for AI agents." Open-source the agent and collector. Free hosted backend for individual users.

Distribution channels: HN, Anthropic Discord, /r/ClaudeAI, /r/LocalLLaMA, OpenAI dev forum, Steinberger / Willison / Ronacher boost.

### 17.5 Phase 4: paid tier launch (weeks 14–24)

Individual tier first. Then team. Enterprise pipeline starts via inbound from open-source users at large companies.

---

## 18. Kickoff Gates (kill criteria before week 1)

Two gates. If either fails, the design is wrong before code is written.

### Gate 1: founder is a heavy Claude Code user on non-Spool work

≥3 multi-session tasks per week on real projects that are not Spool itself. Building Spool on Spool is a degenerate corpus.

**Resolution:** write down the last 10 multi-session agent tasks across other projects. If fewer than 10 in the last 30 days, the founder is not the user.

### Gate 2: capture surface is verified for Claude Code

Read a real Claude Code session log from disk. Confirm presence of tool calls, file edits, errors, turn boundaries, and thinking blocks. Verify session storage location is stable across versions. Write a marker into a Spool-managed area of `.claude/`. Start a fresh session. Confirm via probe that the marker is visible.

**Resolution:** a 200-line script that produces a sample captured trace from a real session.

### Gate 3 (added): one named practitioner contact

≥1 reply from the §17.1 cold outreach inside 14 days.

**Resolution:** if zero replies after two outreach waves, the user persona is not reachable through founder channels and the GTM assumption needs rework before build.

---

## 19. v0 Scope (Weeks 1–6)

Single-user, local-only, Claude Code only, post-hoc only.

**Ships:**

- Spool CLI (`spool` command, `npx`-installable, TS).
- Claude Code session capture (hook mode, reads from `~/.claude/` session storage).
- Local SQLite + filesystem blob storage.
- `spool inspect <run-id>` — terminal-rendered step timeline + step inspector. Pass `--pretty-print` to render `decision`, `action`, `outcome`, and `cost` as schema-aware field layouts instead of raw JSON; the `context` and `files` tabs are unchanged. Default output stays raw so grep/jq pipelines keep working. The web step cards expose the same toggle per-step via a `Pretty (all tabs)` button that persists in `localStorage`.
- `spool list` — recent runs with filters.
- `spool fork <run-id> --at <step-id> --edit <edit-type>` — fork mechanism.
- `spool diff <run-id-a> <run-id-b>` — trajectory diff.
- `spool annotate <step-id> --verdict ... --note ...` — annotation.
- Replay engine (deterministic prefix + fresh suffix).
- One redaction pass before any blob is stored (regex list).
- Basic web UI served from CLI (`spool web`) for the inspector and timeline views (the CLI is fine for power users but the web UI sells the demo).
- Documentation: getting started, trace format spec v0.1, integration guide for "build your own capture."

**Does NOT ship in v0:**

- Live inspector (post-hoc only).
- Multi-runtime support beyond Claude Code.
- Hosted backend.
- Team features.
- Regression suite scheduler.
- Sandbox templates.
- Notifications.
- Cost dashboards (cost data is captured but not surfaced in a dashboard).
- Semantic diff (structural diff only).
- Embedding-based step alignment.
- Browser / voice / vertical-agent UIs.
- Compliance certifications.

### v0 success criteria

Founder dogfood: ≥6 multi-session tasks debugged with Spool over a 2-week window.

Headline qualitative success: founder can recall ≥3 concrete moments where the Debugger surfaced something they would not have found without it.

Quantitative-flavoring (directional, not statistically powered):

- ≥5 forks created.
- ≥1 fork resulted in a clearly better trajectory than the origin.
- ≥10 annotations applied.
- Capture overhead < 50ms per step on average.
- Storage footprint < 25MB per 30-day window of typical usage.

### v0 failure verdict

If after 2 weeks of dogfood (a) zero forks produced a meaningfully different trajectory AND (b) the founder cannot identify ≥1 moment of unique debugging value, the fork-and-replay primitive is broken and the thesis must be rethought.

---

## 20. v0.1 Scope (Weeks 7–10)

- Codex CLI capture.
- Cursor (Agents window) capture.
- SDK mode for custom TS agents.
- Hosted backend (Postgres + S3-compatible) — optional, local mode remains default.
- Live inspector (real-time fleet view).
- Notifications (loop detection, threshold crossings, stall detection).
- Regression suite — basic version (run a corpus, assert on output regex / tool-call presence).
- Trace format spec v0.2 (with cross-vendor feedback).

---

## 21. v0.2 Scope (Weeks 11–16)

- Python SDK.
- LangChain / LangGraph adapter.
- Vercel AI SDK adapter.
- Sandbox templates.
- Team tier (multi-user, shared runs, RBAC).
- Live Probe (pause + inject + resume).
- Cost dashboards.
- Public OSS launch.

---

## 22. v1 (Months 6–9)

- Non-coding-agent surfaces: browser, voice, customer support.
- Enterprise tier (SSO, on-prem, audit logs).
- Semantic diff with embedding-based alignment.
- Model-upgrade workflow (corpus replay against new model versions with diff report).
- Annotated dataset export (for fine-tuning use cases).
- First vendor partnerships announced.

---

## 23. Long-term Trajectory (12+ Months)

The endpoint is not "a debugger." The endpoint is **the standard observation and control plane for agent runtimes**, with the debugger as the wedge.

Once Spool owns the trace format and the workflow on top:

- Evaluation product (run agents against eval suites with full Debugger introspection).
- Training data product (use annotated runs as preference data).
- Compliance product (auditable agent decision trail for regulated industries).
- Marketplace product (share regression suites, share tool definitions, share annotated runs across teams).

The Company Brain RFS thesis converges with Spool's trajectory: the institutional memory layer for an org's agent fleet is the natural v2 product.

---

## 24. Strategic Positioning Summary

- **vs. Langfuse / Braintrust:** we are the debugger; they are the dashboard.
- **vs. native Anthropic / OpenAI debuggers:** we are cross-vendor; we own the workflow (fork, diff, regression) not just the data view.
- **vs. Datadog / New Relic LLM modules:** we are agent-native; they are LLM-tracing bolted onto generic APM.
- **vs. eval frameworks (Inspect, Promptfoo):** we are the introspection layer; eval frameworks become a verb inside Spool.
- **vs. Replay.io:** they own browser time-travel; we own agent time-travel.

The defensible position is: own the trace format spec, own the fork primitive, own the workflow that compounds across the entire agent stack regardless of which runtime, vertical, or model is in play.

---

## 25. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic ships native Claude Code debugger inside 90 days | High | Cross-vendor positioning; ship Codex CLI integration by v0.1; relationship investment with Cherny pre-launch |
| Fork-and-replay is too noisy to be useful | High | Cached-prefix replay; probabilistic divergence mapping; explicit v0 failure verdict |
| Capture overhead degrades agent performance | Medium | Async write path; benchmark gate (<50ms/step in v0) |
| Storage cost balloons for heavy users | Medium | Content-addressed dedup; configurable retention; local-only default |
| Cross-vendor moat doesn't materialize | Medium | Open spec early; framework-author relationships before runtime-author competition |
| Privacy / security blocks enterprise | Medium | Self-hosted from day one; PII redaction pass; SOC2 in v1 timeline |
| Non-coding-agent expansion fails | Medium | Data model is agent-agnostic by design; UI verticalization in v1, not data plane changes |
| Debugger framing alienates non-engineer buyers | Medium | Audit / dashboard view in v1 sharing the data layer |
| Founder bandwidth | High | Explicit single-venture decision before kickoff (§26) |
| Trace format becomes commoditized (OpenLLMetry wins) | Low | Adopt and extend the winning standard rather than compete; differentiate on workflow |

---

## 26. Open Questions

Real questions, not rhetorical ones. Each needs a decision before the corresponding milestone.

1. **Naming.** Decision needed before §17.4 (week 10). Candidates: Spool, Spindle, Cassette. Trademark search required.
2. **TS vs Python first SDK.** Currently TS-first. Reconsider if the closed-alpha cohort is Python-heavy.
3. **Hosted backend in v0.1 or v0.2.** Hosted in v0.1 adds complexity. Local-only forever is purer but harder to monetize early. Current call: hosted in v0.1, behind a feature flag.
4. **Open-source license.** MIT vs Apache 2.0 vs Elastic License v2. MIT for the agent and collector. Elastic License v2 for the web UI? Defer to v0.2 OSS launch decision.
5. **Whether to ship a hosted free tier.** Risks support load. Helps adoption. Defer to v0.2.
6. **Anthropic relationship strategy.** Court as partner from day one, or build first and approach later? Current call: a single low-key conversation in week 1 via the cold outreach, no formal partnership ask until v0.1.
7. **Pricing for individual tier.** $20/mo vs $30/mo. Defer until first 10 alpha users surface willingness-to-pay signal.
8. **Hotpath relationship.** If Spool ships, Hotpath either gets folded into Spool (as the Performance panel) or sunset. Current call: fold. Hotpath as a standalone product is dominated by Spool's broader surface.
9. **Profile relationship.** Spool's data plane subsumes Profile's use case (cross-session hint injection becomes a Spool feature, not a separate product). Current call: Profile becomes a Spool feature in v0.1 ("auto-distill yesterday's runs into context hints for today's").
10. **Naming the trace format spec.** "Spool Trace Format" vs proposing an extension to OpenInference / OpenLLMetry. Engaging with the standards bodies before launch is the right move.

---

## 27. The Honest Decision Memo

Before week 1, the founder commits to one of three paths:

**Path A: Spool is the single venture.** Hotpath gets folded in. Profile gets folded in. Gilld and Donaldson Lake remain but go on maintenance footing. NVIDIA application is withdrawn (or accepted and then declined). YC application leads with Spool under the Software for Agents RFS.

**Path B: Spool is the YC swing; Hotpath continues as a parallel ship.** Higher risk, lower probability of either succeeding well. Not recommended.

**Path C: Don't build Spool. Ship Hotpath. Or ship the Profile spec. Or ship the shadow-workspace play from RFS #2. Or take the NVIDIA job and run Gilld + Donaldson Lake nights and weekends.**

Path A is the recommended path if and only if Gates 1, 2, and 3 (§18) clear inside two weeks. If any gate fails, Path C is the right answer.

This spec is not a commitment to build Spool. It is the artifact that lets the founder make an informed decision in two weeks instead of two months.

---

## Appendix A: Cold Outreach Template (Phase 0)

Three sentences. No pitch. Sent individually, not blasted.

> Subject: question about your agent setup
>
> Hey [name] — saw your [specific reference: post / X thread / blog]. I'm exploring building a debugger for AI agent runs — not analytics, more like Chrome DevTools (inspect any step, fork from any point, diff the trajectories). Before I build anything, I'd love to know what you wish existed for inspecting your fleet and what you've hand-rolled yourself. Reply or skip — either is a useful signal.
>
> Brantley

## Appendix B: v0 File Layout

```
spool/
├── packages/
│   ├── cli/                   # `spool` command
│   ├── agent/                 # capture SDK (TS)
│   ├── collector/             # local collector daemon
│   ├── server/                # query API + replay engine
│   ├── web/                   # web UI (Next.js or Astro)
│   ├── spec/                  # trace format JSON schemas
│   └── shared/                # types + utilities
├── adapters/
│   └── claude-code/           # Claude Code hook mode integration
├── docs/
│   ├── getting-started.md
│   ├── trace-format.md
│   ├── integrations/
│   └── architecture.md
└── examples/
    └── claude-code-debug/
```

## Appendix C: Glossary

- **Agent.** A logical AI worker identity; persistent across runs.
- **Run.** One end-to-end execution of an agent on a task.
- **Step.** One model invocation plus its consequences. The unit of debugging.
- **Context snapshot.** Full bytes the model saw at a step.
- **Decision.** The model's output at a step.
- **Action.** Structured representation of the agent's chosen action.
- **Outcome.** Result of the action (tool result, error, state delta).
- **Fork.** A new Run derived from an existing Run by replaying to a step and applying an edit.
- **Trajectory diff.** Side-by-side comparison of two Runs.
- **Canonical Run.** A Run promoted to expected-behavior status.
- **Regression Test.** Input + expected behavior assertions.
- **Hook mode.** Capture by reading runtime-published session logs.
- **SDK mode.** Capture by wrapping model and tool calls at instrumentation points.

---

*End of spec.*
