# v0.3 follow-ups — known gotchas to revisit

> **What this is.** A living tracking doc for limitations shipped on
> purpose in v0.3 that need a real fix in a later milestone. Each entry
> names the choice, why it's the right call for v0.3, the precise
> trigger condition that makes it bite, and the milestone where it
> gets resolved.
>
> **Why a separate doc.** The v0.3 milestone spec (`SPEC-V0_3.md` once
> v0.3 ships, the working spec until then) is the source of truth for
> *what's in v0.3*. This doc is the source of truth for *what's
> deliberately not yet right* — the kind of thing that's easy to lose
> if it only lives in commit messages.
>
> **How to use it.** When you land a fix for one of these, delete the
> entry (don't strike-through — git history is the audit trail). When
> you discover a new follow-up while implementing v0.3 or v0.4, add it
> with the same shape: title · what · why-it's-OK-for-now · trigger ·
> resolution path.

---

## 1. Live SSE stream is always-registered

### What

After the Turn 7 refactor (web file-capture surface + Live UX), the
server-sent events route at `GET /api/live` is registered
unconditionally — every web page mounts an `EventSource` against it,
even when the controller isn't running an inspector. That means the
server holds an open HTTP response per browser tab indefinitely.

The previous behavior (v0.2 and earlier) was to only register the SSE
route when `meter web` was launched with `--live`. The route either
existed or it didn't.

### Why it's the right call for v0.3

The whole point of Turn 7's "Live toggle in the header" UX is that the
user shouldn't have to restart `meter web` to flip live mode on. For
the button to start producing events without a page reload, the SSE
stream has to already be open when they click — otherwise the first
event after toggling on would be missed (the controller emits while
no one's listening).

The implementation chose "always register, route subscribers via the
LiveController" so that:

- A page loaded before live mode is on can still see events the moment
  the toggle fires (no reconnect needed).
- The stop/start lifecycle on the controller is independent of
  per-connection EventSource lifecycle — connections survive a toggle
  cycle.
- Routes always have a controller to dispatch through; no conditional
  registration based on boot flags.

### The trigger that makes it bite

This is **invisible for local-first usage** — `127.0.0.1` plus a single
operator means at most a handful of open EventSources per `meter web`
process. Browsers cap their own concurrent connections to a single
origin (Chromium: 6, Firefox: 6) so a tab-spammer maxes out around the
same ceiling.

It **starts mattering** when:

- `meter web` is bound to a non-loopback interface (per §10.5 of the
  v0.3 spec, this also warrants a startup warning + auth token on
  `/api/blob/:hash`). With N operators on a team-tier deployment,
  each refreshing N′ tabs, the server holds N × N′ idle SSE
  connections. Each one is a Node HTTP socket plus a Hono response
  object plus a closure containing the `controller.on` subscriber.
- A reverse proxy is in front (nginx, Cloudflare) — idle SSE
  connections can hit per-proxy connection limits that don't apply
  to ordinary request/response traffic.

Rough sizing: each idle EventSource holds ~10-15 KB on the server
side (TCP socket buffers + Node HTTP state + the closure). At 1,000
connections that's ~10-15 MB — not breaking, but visible. At 10,000
it starts mattering for tier sizing.

### Resolution path

Two reasonable directions when team tier (v1) makes this real:

1. **Heartbeat-and-cull** — send `:keepalive\n\n` every 30s on idle
   connections. Drop connections whose last successful write was more
   than 90s ago. Honors the spec's existing fire-and-forget pattern.
2. **Lazy subscription** — keep the route always-registered but only
   send the initial snapshot and start dispatching events once the
   client sends a "subscribe" message via a POST companion endpoint
   (or via an `EventSource` query param). Idle EventSources cost the
   socket, but the controller's subscriber set stays bounded by
   active-subscribers, not active-connections.

Pre-v1 (single-operator local-first), neither is needed. Document the
network-bind warning prominently and move on.

### Cross-references

- v0.3 spec §10.5 (network-bind warning + auth token for `/api/blob`)
- v0.3 spec §13.4 (team tier, v1 — when this becomes a real concern)
- Turn 7 implementation: `packages/server/src/web.ts` (the `/api/live`
  route) and `packages/server/src/live.ts` (the `LiveController` class)

---

## 2. Proxy-captured runs don't fire `run:updated` events

### What

The live-append flow on the run detail page (`/runs/:id`) subscribes
to `run:updated` SSE events and fetches new step-card HTML fragments
as steps arrive. This works perfectly for Claude Code sessions because
the LiveInspector watches `~/.claude/projects/*` for JSONL growth and
emits `run:updated` per detected step.

**The proxy doesn't go through the LiveInspector at all.** Proxy
capture writes Step rows directly to the store inside its async
`persistCapture()` after the LLM response returns. There's no JSONL
file growth for the watcher to detect, so no `run:updated` event ever
fires for a proxy run.

Net effect: proxy-captured runs still need a manual page refresh to
show new steps, even with the Live toggle on. The header badge says
LIVE; the page sits static.

### Why it's the right call for v0.3

The LiveInspector is a file-system watcher (`fsnotify`-style polling
of `~/.claude/projects/`). Wiring the proxy into the same event stream
means either:

- The proxy writes to a JSONL file the watcher polls (adds I/O,
  duplicates the in-memory write path, and recouples capture sources
  Meterbility has spent the v0.2 cycle decoupling).
- We introduce a second event bus that both the watcher and the proxy
  publish to (the right answer, but a real refactor — the watcher's
  internal state (`firedAlerts`, `lastSizes`, `knownPaths`) is built
  for file polling, not generic step-append events).

v0.3 chose to ship the Claude Code live-append UX as-is and defer
the proxy integration. Per the milestone spec's discipline note (§13.5),
"scope cuts come from Track A first" — and Track A is the dominant
v0.3 user (Claude Code coding sessions). Proxy users get the rest of
the Files tab + run-detail page; they just don't get live append.

### The trigger that makes it bite

Anyone using `meter proxy` or `meter run -- <command>` to capture
Anthropic/OpenAI calls and watching their progress on the `/runs/:id`
page will see a static page until they refresh. The header LIVE badge
+ pulsing dot make the gap feel worse — visually the page promises
real-time and silently doesn't deliver.

How often this actually hurts depends on what fraction of Meterbility users
are on proxy capture vs Claude Code hook capture. The proxy is the
zero-instrumentation onboarding path, so we should assume "common
enough to be embarrassing on a demo."

### Resolution path

The clean design is in the v0.3 spec already — §8.5 lists a
`files:changed` SSE event the proxy is supposed to fire after its
async persist completes. The same emitter mechanism extended to
`run:updated` solves this entirely.

Concrete steps when v0.4 lands the proxy partial-fidelity file capture
(§13.2):

1. Introduce a `StepEventEmitter` on the Store (or a sidecar shared
   bus). Anyone writing a Step row goes through it.
2. The LiveInspector becomes a *consumer* of that bus, not a publisher.
   Its current file-watcher logic still drives "is there a new JSONL
   tail to read" but step-emission moves to the post-read path.
3. The proxy's `persistCapture` publishes to the same bus after its
   `insertStep` lands.
4. `LiveController` subscribes to the bus and routes events to its
   SSE subscriber set exactly as today. The `/api/live` clients don't
   change — they keep receiving `run:updated` events; the new ones
   just happen to come from a wider set of producers.

The web-side change is zero. Step 4 is what unblocks every other
capture source (SDK, future Codex hook, etc.) without re-architecting
each one.

Until then: document the limit in the docs `live-inspector.md` page
and add a one-line note to the run-detail page's LIVE badge tooltip
when the run's `source_runtime === "proxy"` saying "Live append is
Claude Code only in v0.3; refresh for new steps."

### Cross-references

- v0.3 spec §8.5 (the planned `files:changed` SSE event, which this
  resolution generalizes)
- v0.3 spec §13.2 (v0.4 "Cross-vendor capture" deliverables —
  proxy partials land here, so the bus refactor is the natural pair)
- Turn 7 implementation: `packages/server/src/html.ts` (the
  `initLiveRunUpdates` JS handler) and `packages/server/src/live.ts`
  (where the `StepEventEmitter` would slot in)
- Proxy implementation: `packages/proxy/src/server.ts`
  (`persistCapture()` — the place that needs to publish on the bus)

---

*To add another follow-up: copy the structure of an entry above —
title · what · why-it's-OK-for-now · the trigger · resolution path ·
cross-references. Keep the doc terse; if a fix turns into a
multi-week project, it graduates into a real spec section, not an
expansion of an entry here.*
