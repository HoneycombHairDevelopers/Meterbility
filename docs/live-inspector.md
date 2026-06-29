# Live inspector & notifications

The fleet view from SPEC §3.1 — watch every running agent in one place, get alerted when something interesting happens.

## Run it

```bash
meter web --live
# → http://127.0.0.1:4317  (auto-opens browser)
```

The `--live` flag tells Meterbility to watch `~/.claude/projects/` for new sessions and growing session files. Every ~1.5s it scans, runs incremental ingest on anything new, and emits structured events over Server-Sent Events (`/api/live`). The fleet view updates without a page refresh.

## What you see

Each card in the grid:

- **Title** — the agent's first user message (or `ai-title` if Claude Code wrote one).
- **Status pill** — `progressing`, `awaiting_input`, `stalled`, `looping`, `errored`, `completed`. Computed by [`classifyRunStatus`](../packages/server/src/live-heuristics.ts).
- **Context bar** — % of the model's window used by the latest step. Color-codes at 70/90%.
- **Recent tools** — last 5 tool calls.
- **Age** — time since last step. Updates every second.
- **Alerts** — strip rendered when triggers fire.

## Alerts

`meter web --live` flags supported in v0.1:

```bash
# Fire an alert when any watched tool is called.
meter web --live --watch-tool Bash --watch-tool git_push

# Adjust the stall threshold (default 120s).
meter web --live --stall-seconds 60
```

Built-in heuristics (no flags needed):

- **Loop** — same tool with identical args ≥4 times in a row.
- **Context threshold** — first time a step crosses 50%, 70%, or 90% of the model's window.
- **Stall** — no step activity for `--stall-seconds`.

Each alert fires once per (run, signature) pair so you don't get spammed. Alerts are streamed to:

- The fleet view (banner above the grid for ~12s).
- The CLI process logs.
- Any SSE subscriber (`/api/live`).

## Live mode without the web UI

The same machinery is exposed programmatically:

```ts
import { Store } from "@meterbility/collector";
import { LiveInspector } from "@meterbility/server";

const store = Store.open();
const live = new LiveInspector(store, {
  watchTools: ["Bash"],
  stallSeconds: 60,
});
live.on("data", (e) => {
  if (e.type === "alert") console.log("alert:", e.kind, e.message);
  if (e.type === "run:created") console.log("new run:", e.run.run_id);
});
await live.start();
```

## Caveats

- Polling cadence is 1.5s by default. Faster intervals are possible (`scanIntervalMs`) but the bottleneck is `ingestSession`, which re-reads the file body to thread the parent-uuid chain.
- Loop detection uses `JSON.stringify(action.tool_input)` for the signature. Tool inputs that include non-deterministic values (timestamps, uuids) won't trip the heuristic — that's by design.
- Alert state is in-memory. Restarting `meter web --live` re-fires alerts that already triggered in the previous session.
- Cursor and Codex CLI surfaces aren't watched in v0.1 — only Claude Code. Both write to disk in append-only JSONL formats compatible with the same tick loop, and they'll plug in via `LiveInspector` constructor options in v0.2.
