# Architecture

A walkthrough of the v0 data plane: how a Claude Code session turns into a Spool Run, where the bytes live, and how the fork primitive replays them.

For the product-shaped picture, see [SPEC §12](../SPEC.md). This doc is the implementation map.

## Pipeline

```
~/.claude/projects/<encoded-cwd>/<session>.jsonl
                │
                ▼  (adapters/claude-code: parser.ts)
    parsed records {type, message, parentUuid, ...}
                │
                ▼  (adapters/claude-code: ingest.ts)
    group by requestId → one logical Step per API call
                │
                ▼
    rebuild Context Snapshot via parentUuid chain
                │
                ▼  (packages/collector: blobs.ts)
    redact ▶ hash ▶ write to $SPOOL_HOME/blobs/<aa>/<bb>/<sha>
                │
                ▼  (packages/collector: queries.ts)
    SQLite rows: runs, steps, context_snapshots, redaction_log
```

### Why group by `requestId`?

Claude Code emits **one JSONL record per content block**. A single assistant response with `thinking` + `tool_use` shows up as two records, each carrying the *same* `usage` numbers. Naive ingest doubles the token count.

Every record from the same model call shares `requestId`, so we collapse those into one logical Step. The combined `content[]` becomes the basis for the Action (preferring `tool_use` over text over thinking-only).

### Context Snapshots

A Step's context is a list of `ContextComponent`s:

- `system_prompt` (content-ref)
- `tool_definitions` (content-ref)
- `conversation_history` (list of role + content-ref + step-ref pointers)
- `retrieved_documents`
- `compaction_summary`

The snapshot is canonicalized (sorted keys) and SHA-hashed. Two Steps with byte-identical context share an id and dedup automatically. A 100-step run with ~95% context overlap stores ~5% of the raw bytes.

The Claude Code adapter v0 only fills `conversation_history` — Claude Code injects the system prompt server-side and doesn't write tool defs into the JSONL. SDK-mode capture in v0.1 fills the other components from the wrapped Anthropic call.

## Storage

| Layer        | Backend                              | What's there                                 |
| ------------ | ------------------------------------ | -------------------------------------------- |
| Metadata     | SQLite (`$SPOOL_HOME/spool.db`)      | Runs, steps, forks, annotations, indexes     |
| Blob content | Filesystem (`$SPOOL_HOME/blobs/...`) | Decision bodies, context snapshots, results  |
| Redaction log| SQLite (`redaction_log` table)       | Which rules fired on which blob              |

WAL mode + foreign keys on. Two-level shard (`<aa>/<bb>/<sha>`) keeps any single dir under a few thousand files even after months of capture.

## Replay

Two modes (SPEC §12.4):

### `deterministic_prefix`

`materializePrefix(originRunId, forkStepId, edit)`:

1. Look up every Step ≤ `forkStepId` from the origin run.
2. Insert a new Run row with `fork_origin_run_id = origin`, `source_runtime = "fork"`.
3. Copy each prefix step into the new run with a fresh `step_id`, same content refs (the prefix shares all blobs with the origin — no copying, just rows).
4. At the fork point, rewrite the context snapshot to apply the edit and re-hash. The new snapshot id and its serialized bytes are written to the blob store.
5. The fork point step's Outcome is marked `pending` — we don't yet have a model response for the rewritten context.

### Live suffix

`forkRun` accepts an optional `LiveResponder`. v0 ships two implementations:

- `fakeResponder(text)` — emits a deterministic `message` step. Used in tests and demos.
- `anthropicResponder(store, { apiKey, model })` — reads the fork's history out of the snapshot, calls `messages.create`, captures the response as one Step with real token/cost numbers.

Both append via `appendLiveStep` which materializes the new bytes and recomputes run totals.

## Forking

`forkRun(store, { origin_run_id, at, edit }, responder?)`:

1. Resolve `origin_run_id` (supports 12-char prefixes).
2. Resolve `at` (numeric → step sequence, string → step id with prefix fallback).
3. Validate the edit type.
4. `materializePrefix` → new run.
5. Insert a `forks` row recording the parent-child relationship.
6. (Optional) Run the responder, append one suffix step.

The fork relationship is part of the data model — `spool inspect <origin>` lists every fork derived from it, and `spool diff <origin> <fork>` shows where the two trajectories diverge.

## Diff

`diffRuns(store, runA, runB)` walks both runs in sequence order. For each `(i, stepA, stepB)`:

- Identical `context_snapshot_id` AND identical `decision_ref` → `shared`.
- Different snapshots → `context_diff`.
- Same snapshot, different decision → `decision_diff`.
- Same context, same decision, different action shape → `action_diff`.
- Same action, different outcome → `outcome_diff`.
- One side missing → `only_a` / `only_b`.
- Past the first divergence → `diverged` (the structural alignment is no longer meaningful).

This is **structural diff**. v1 adds **semantic diff** — embedding-based alignment when sequence indices have drifted (one run took 20 steps, the other 35) (SPEC §12.6).

## Web UI

`spool web` mounts a Hono app over the local Store on `127.0.0.1:4317`:

- `/` — run list (HTML).
- `/runs/:id` — run detail with timeline + per-step tabs.
- `/diff?a=<run>&b=<run>` — trajectory diff.
- `/api/runs`, `/api/runs/:id/steps`, `/api/steps/:id`, `/api/diff` — JSON API.
- `/api/blob/:hash` — fetch a blob (handles snapshot-id → blob-ref translation).
- `POST /api/annotate` — attach a verdict + note.

The HTML is a single-file render (no framework, no bundler). Styles + tiny vanilla JS for tab switching and step jumping. Designed for fast iteration at the spec-vs-reality interface, not for production scale.

## Idempotency

Two surfaces care about this:

1. **Ingest** keeps a per-file `ingest_progress` row with the last byte offset. Re-running `spool ingest claude-code` only processes the tail of each session — adapter cost grows with new bytes, not total bytes.
2. **Blob writes** are content-addressed and write-once. Re-ingest cannot duplicate content; the blob store is naturally a Merkle DAG.

## Test strategy

`scripts/run-tests.ts` walks `packages/**` and `adapters/**` for `*.test.ts` and runs each through `tsx`. Node's native `node:test` runner is used inside each file; spec-style output is shown.

End-to-end coverage: `scripts/smoke-ingest.ts` ingests a real session and prints the result.
