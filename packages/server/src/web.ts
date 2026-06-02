import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { Annotation, Run, Step } from "@spool/shared";
import {
  clearProbe,
  consumeInject as consumeProbeInject,
  readState as readProbeState,
  requestPause as probeRequestPause,
  requestResume as probeRequestResume,
  setInject as probeSetInject,
} from "@spool/shared";
import {
  getBaselineTree,
  getFileChange,
  getRun,
  getStep,
  getStepBySequence,
  listAnnotations,
  listFileChanges,
  listForks,
  listRuns,
  listSteps,
  insertAnnotation,
  resolveSnapshotBlobRef,
  setRunStatus,
  updateRunTotals,
  getSetting,
  setSetting,
  deleteSetting,
  resolveSetting,
  isSecret,
  maskSecret,
  type SettingKey,
} from "@spool/collector";
import type { Store } from "@spool/collector";
import { TRACE_FORMAT_VERSION } from "@spool/spec";
import { diffRuns } from "./diff.ts";
import { recordProbeIntervention } from "./probe_annotations.ts";
import {
  renderCacheKey,
  renderHighlighted,
  sniffMimeAndLang,
} from "./blob_render.ts";
import {
  buildFileTree,
  flattenForDefaultSelection,
  renderFilesPage,
  renderRightPane,
} from "./file_view.ts";
import { DECISION_PREVIEW_LIMIT } from "./pretty.ts";
import {
  renderShell,
  renderRunList,
  renderRun,
  renderDiff,
  renderFleet,
  renderTests,
  renderContext,
  renderProbePanel,
  renderStepCardFragment,
  type RenderedComponent,
  type RenderedContext,
} from "./html.ts";
import type {
  ContextSnapshot,
  ConversationMessage,
  RetrievedDocument,
} from "@spool/shared";
import {
  LiveController,
  LiveInspector,
  buildFleetEntries,
  type LiveEvent,
  type LiveOptions,
} from "./live.ts";
import { forkRun, fakeResponder, anthropicResponder } from "./fork.ts";
import {
  continueFork,
  type ContinuationMode,
  type ContinuationModelCaller,
  type ToolExecutor,
} from "./continuation.ts";
import { SlackNotifier } from "./slack.ts";
import {
  addAssertion,
  createTest,
  deleteTest,
  deriveAssertionsFromRun,
  getTestByName,
  listResults,
  listTests,
  runTest,
  type Assertion,
} from "./regression.ts";

/**
 * Hono app over the local Store. Two surfaces share the same routes:
 *  - JSON API (`/api/...`) — for future web/UI clients.
 *  - Server-rendered HTML (`/`, `/runs/:id`, `/diff?a=&b=`) — what
 *    `spool web` opens by default.
 */
export interface BuildAppOptions {
  /**
   * v0.3 — runtime-toggleable live controller. Always present; the
   * caller (serveApp) is responsible for starting it if --live was
   * passed at boot. Routes dispatch through the controller so the
   * web UI's Live button can start/stop without rebuilding the app.
   */
  controller?: LiveController;
  /**
   * v0.2 back-compat: tests that built an inspector manually can pass
   * it via `live`. `buildApp` wraps it into a fresh controller and
   * adopts the inspector's events. Prefer `controller` for new code.
   */
  live?: LiveInspector;
}

export function buildApp(store: Store, opts: BuildAppOptions = {}) {
  const app = new Hono();
  const controller = opts.controller ?? new LiveController(store);

  // ── v0.3 §11 — Bearer-token gate on JSON /api/* routes ────────────
  //
  // HTML pages (/, /runs, /runs/:id, /diff, …) are intentionally NOT
  // gated — anyone on the network sees the UI shell, but every API
  // call from that UI needs the Bearer header. The threat model is
  // "the data shouldn't leak"; the UI being browsable is acceptable
  // since the UI just makes the same gated API calls.
  //
  // Token is read per-request from the settings table so toggling
  // `web.bind_token` via the settings page takes effect immediately —
  // no server restart needed. Reads are cheap (indexed PK lookup).
  // When the setting is absent (the local-dev default), the middleware
  // is a no-op — current behavior is preserved.
  app.use("/api/*", async (c, next) => {
    const expected = getSetting(store, "web.bind_token");
    if (!expected) return next();
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== expected) {
      return c.json(
        { error: "unauthorized: invalid or missing Bearer token" },
        401,
      );
    }
    return next();
  });
  // Back-compat: if a raw LiveInspector was passed (legacy tests),
  // bridge its events into the controller's subscriber set so SSE
  // clients still see them.
  if (opts.live && !opts.controller) {
    opts.live.on("data", (e: LiveEvent) => {
      // Re-emit through any direct subscribers on the controller. The
      // controller's `on()` registry routes to whichever inspector
      // (or this bridged one) is current.
      for (const fn of (controller as unknown as {
        subscribers: Set<(e: LiveEvent) => void>;
      }).subscribers) {
        fn(e);
      }
    });
  }
  // shellOpts.liveMode is dynamic — read at request time so pages
  // rendered just after `POST /api/live/start` reflect the new state.
  // Call as a helper at each renderShell site.
  const shellOpts = (): { liveMode: boolean } => ({
    liveMode: controller.isLive() || opts.live !== undefined,
  });

  app.get("/", (c) => {
    // Fleet view always renders. When the controller is live (either
    // started at boot via --live or toggled on at runtime), alerts
    // come from its inspector; otherwise we build a one-shot
    // snapshot from the same heuristics with empty alerts. The Live
    // button + meta tag reflect controller state in real time.
    const isLive = controller.isLive() || opts.live !== undefined;
    const entries = controller.isLive()
      ? controller.fleetEntries()
      : opts.live
        ? opts.live.fleetEntries()
        : buildFleetEntries(store, { limit: 50 });
    return c.html(
      renderShell(
        "Spool · Fleet",
        renderFleet(entries, { liveMode: isLive }),
        shellOpts(),
      ),
    );
  });

  app.get("/runs", (c) => {
    const status = c.req.query("status");
    const tool = c.req.query("tool");
    const project = c.req.query("project")?.toLowerCase();
    let runs = listRuns(store, {
      limit: 500,
      status:
        status === "ok" ||
        status === "error" ||
        status === "in_progress" ||
        status === "abandoned"
          ? status
          : undefined,
      containsTool: tool || undefined,
    });
    // Project filter is a substring match on cwd; do it client-side
    // since the SQL store doesn't index by it and counts stay small.
    if (project) {
      runs = runs.filter((r) =>
        (r.cwd ?? "").toLowerCase().includes(project),
      );
    }
    return c.html(
      renderShell(
        "Runs",
        renderRunList(runs, {
          totalAvailable: listRuns(store, { limit: 1000 }).length,
          filters: { status, tool, project },
        }),
        shellOpts(),
      ),
    );
  });

  // Server-Sent Events for live updates. Always registered so the
  // browser can open an EventSource speculatively at page load; if
  // the controller isn't live yet, the client sees no events until
  // someone hits the Live button (which fires the route below).
  // Subscribers are stored on the controller, so a stop/start cycle
  // doesn't drop them.
  app.get("/api/live", (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    return stream(c, async (s) => {
      const send = (e: LiveEvent) => {
        void s.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      controller.on("data", send);
      // Initial snapshot (empty when not live) so the client always
      // sees one frame on connect — handy for "I'm subscribed" UI
      // feedback even before the first real event fires.
      send({ type: "fleet:snapshot", entries: controller.fleetEntries() });
      await new Promise<void>((resolve) => {
        s.onAbort(() => {
          controller.off("data", send);
          resolve();
        });
      });
    });
  });

  // v0.3 — Live control endpoints. Lets the web UI flip live mode
  // without restarting `spool web`. Idempotent: start-when-running
  // and stop-when-stopped are both no-ops.
  app.get("/api/live/status", (c) =>
    c.json({ live: controller.isLive() }),
  );
  app.post("/api/live/start", async (c) => {
    let liveOpts: LiveOptions | undefined;
    try {
      const body = (await c.req.json()) as LiveOptions | null;
      if (body) liveOpts = body;
    } catch {
      // empty body is fine — start with defaults / previous opts
    }
    await controller.start(liveOpts);
    return c.json({ live: controller.isLive() });
  });
  app.post("/api/live/stop", (c) => {
    controller.stop();
    return c.json({ live: controller.isLive() });
  });

  app.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const run = getRun(store, runId);
    if (!run) return c.notFound();
    // Use run.run_id (the resolved canonical id) rather than runId
    // (which may be a prefix like "run_abc12345"). Otherwise reads
    // against steps/annotations/forks return empty.
    const steps = listSteps(store, run.run_id);
    const annotations = listAnnotations(store, "run", run.run_id);
    const forks = listForks(store, run.run_id);
    const stepDecisions = await loadDecisionPreviews(store, steps);
    // v0.3 — load FileChanges and group by step. One query for the
    // whole run; group in memory. Empty map for runs that never
    // captured file changes (proxy / non-coding / pre-v0.3).
    const allFcs = listFileChanges(store, { runId: run.run_id });
    const fcByStep = new Map<string, typeof allFcs>();
    for (const fc of allFcs) {
      const list = fcByStep.get(fc.step_id) ?? [];
      list.push(fc);
      fcByStep.set(fc.step_id, list);
    }
    // Turn 8 chunk 5 — Live Probe panel. Render only for in_progress
    // runs (the only ones that can be paused) so sealed runs don't
    // get a meaningless panel + polling loop.
    const probePanel =
      run.status === "in_progress"
        ? renderProbePanel(run.run_id, readProbeState(run.run_id))
        : "";
    const shell = renderShell(
      run.title ?? run.run_id,
      renderRun(run, steps, annotations, forks, stepDecisions, fcByStep, probePanel),
      shellOpts(),
    );
    if (process.env.SPOOL_DEBUG && shell.length > 2_000_000) {
      // Dev-only sentinel: pretty-print pre-renders both raw and pretty
      // bodies for every step. For very long runs that doubled markup
      // can push the page over the 2 MB threshold where switching to
      // lazy-fetch becomes worth it. Surfaced via SPOOL_DEBUG so it
      // never spams normal users.
      console.warn(
        `spool: run ${run.run_id.slice(0, 12)} page is ${(shell.length / 1024 / 1024).toFixed(1)}MB — consider lazy pretty fetch`,
      );
    }
    return c.html(shell);
  });

  /**
   * v0.3 §8.3 — `/runs/:id/files` full-page browse view with two-pane
   * layout (tree left, Final/History/Raw tabs right). Locked design
   * decisions D3–D14 (see plan file Design Review section).
   *
   * URL fragment shape (D14):
   *   #path=<selected>&open=<dir1>,<dir2>
   * Server reads the fragment via client JS only — the initial
   * server-rendered page picks the risk-first default (D8). Fragment
   * is for sharing and refresh, not initial render (URL fragments
   * don't reach the server).
   */
  app.get("/runs/:id/files", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    const fcs = listFileChanges(store, { runId: run.run_id });
    const steps = listSteps(store, run.run_id);
    const captureEnabled =
      getSetting(store, "capture.files.enabled") !== "false";
    const rendered = renderFilesPage({
      run,
      fileChanges: fcs,
      steps,
      captureEnabled,
    });
    const shell = renderShell(
      `${run.title ?? run.run_id} · files`,
      `${rendered.stylesHtml}${rendered.bodyHtml}${rendered.scriptsHtml}`,
      shellOpts(),
    );
    return c.html(shell);
  });

  /**
   * Fragment endpoint — returns just the right-pane HTML for one
   * file, used by the page's JS click handler to swap content
   * without a full page reload (P1: lazy-load right pane per click).
   * Supports ?tab=final|history|raw to switch tab without changing
   * the selected file.
   */
  app.get("/runs/:id/files/:path{.+}", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    const path = decodeURIComponent(c.req.param("path"));
    const tabParam = c.req.query("tab");
    const tab: "final" | "history" | "raw" =
      tabParam === "history" || tabParam === "raw" ? tabParam : "final";
    const fcs = listFileChanges(store, { runId: run.run_id });
    if (fcs.length === 0) return c.notFound();
    const tree = buildFileTree(fcs);
    const flat = flattenForDefaultSelection(tree);
    const node = flat.find((n) => n.path === path);
    if (!node) return c.notFound();
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(renderRightPane({ runId: run.run_id, node, tab }));
  });

  // v0.3 §8.5 — file-change JSON APIs. Used by the web UI for ad-hoc
  // loads (e.g. the per-path diff view when no UI is open) and by
  // any external scripting that wants the same data without parsing
  // HTML. All read-only; mutations come through the adapters.
  app.get("/api/runs/:id/files", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    return c.json(listFileChanges(store, { runId: run.run_id }));
  });
  app.get("/api/runs/:id/files/diff", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    const path = c.req.query("path");
    if (!path) return c.json({ error: "missing required ?path=" }, 400);
    return c.json(listFileChanges(store, { runId: run.run_id, path }));
  });
  app.get("/api/steps/:id/file_changes", (c) => {
    const step = getStep(store, c.req.param("id"));
    if (!step) return c.notFound();
    return c.json(listFileChanges(store, { stepId: step.step_id }));
  });
  app.get("/api/file_change/:id", (c) => {
    const fc = getFileChange(store, c.req.param("id"));
    return fc ? c.json(fc) : c.notFound();
  });

  // ── Live Probe routes (Turn 8 chunk 5) ──────────────────────────
  // Operator surface for pause / inject / resume / clear on a running
  // run. The SDK side must have `tracer.probeEnabled = true` for these
  // operations to actually pause the agent; the panel surfaces that
  // requirement so a confused operator knows why their pause did
  // nothing. The CLI (`spool probe ...`) goes through the same probe
  // protocol (`@spool/shared/probe`), so both the web panel and the
  // terminal see the same state.

  // v0.3 canonical probe routes — per SPEC-V0_3 §4 + §8.4, probe lives
  // under the run namespace at `/api/runs/:id/probe/*`. The legacy
  // `/api/probe/:run_id/*` paths still work via HTTP 308 redirects
  // below (with `Deprecation: true` per RFC 8594) — scheduled removal
  // in v0.4. All new code MUST use `probeRoutes()` from
  // ./probe_routes.ts rather than hardcoding paths.

  /** GET /api/runs/:id/probe — read current probe state as JSON. */
  app.get("/api/runs/:id/probe", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(readProbeState(run.run_id));
  });

  /** GET /api/runs/:id/probe/panel — pre-rendered HTML fragment for
   * the panel. The client polls this every 1.5s and replaces the panel
   * node in place when the markup changes. Returns 404 (so the client
   * skips the swap) if the run has been sealed. */
  app.get("/api/runs/:id/probe/panel", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.status !== "in_progress") return c.json({ error: "run sealed" }, 404);
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(renderProbePanel(run.run_id, readProbeState(run.run_id)));
  });

  /** POST /api/runs/:id/probe/pause — request a graceful pause.
   * Records a `probe_pause` annotation on the run (target_kind='run')
   * per SPEC-V0_3 §4.4. */
  app.post("/api/runs/:id/probe/pause", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const state = probeRequestPause(run.run_id);
    recordProbeIntervention(store, run.run_id, "probe_pause", {
      paused_at: new Date(state.requested_at_ms ?? Date.now()).toISOString(),
    });
    return c.json(state);
  });

  /** POST /api/runs/:id/probe/resume — release a pause. If any injects
   * were staged during the paused window, each one produces a
   * `probe_edit` annotation against the next step that will run. */
  app.post("/api/runs/:id/probe/resume", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    // Snapshot any staged inject BEFORE resume so we can record the
    // edit. Resume itself doesn't consume injects — the SDK does, on
    // its next poll — but the operator's intent to ship this inject is
    // recorded now. Step id is unknown at this point; we record at
    // target_kind='run' and let the consumer attach to the next step.
    const pre = readProbeState(run.run_id);
    const state = probeRequestResume(run.run_id);
    if (pre.inject !== null) {
      recordProbeIntervention(store, run.run_id, "probe_edit", {
        inject_bytes: pre.inject.length,
        resumed_at: new Date(state.resumed_at_ms ?? Date.now()).toISOString(),
      });
    }
    return c.json(state);
  });

  /** POST /api/runs/:id/probe/inject — queue an inject message OR
   * clear the pending one. Body: { message: string, force?: boolean }
   * to queue; { clear: true } to discard a queued message without
   * setting a new one. Refuses to clobber a queued message unless
   * `force` is true (mirrors `spool probe inject --force`). The
   * `probe_edit` annotation is emitted at resume time (see above), not
   * at inject time, so a staged-then-discarded inject leaves no
   * annotation trail. */
  app.post("/api/runs/:id/probe/inject", async (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    let body: { message?: string; force?: boolean; clear?: boolean };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.clear) {
      consumeProbeInject(run.run_id);
      return c.json(readProbeState(run.run_id));
    }
    if (typeof body.message !== "string" || body.message.length === 0) {
      return c.json({ error: "message is required (use { clear: true } to discard)" }, 400);
    }
    const current = readProbeState(run.run_id);
    if (current.inject !== null && !body.force) {
      return c.json(
        {
          error: "a pending inject is already queued (pass { force: true } to overwrite)",
          current_inject: current.inject,
        },
        409,
      );
    }
    return c.json(probeSetInject(run.run_id, body.message));
  });

  /** POST /api/runs/:id/probe/clear — remove the probe file (stale
   * recovery). Pure file cleanup; does NOT require the run to exist
   * because an orphan probe file may outlive its run row deletion. */
  app.post("/api/runs/:id/probe/clear", (c) => {
    const run = getRun(store, c.req.param("id"));
    const target = run?.run_id ?? c.req.param("id");
    clearProbe(target);
    return c.json({ cleared: target });
  });

  // ── Legacy probe routes — HTTP 308 redirects ──────────────────────
  //
  // Every old `/api/probe/:run_id/*` path 308-redirects to the
  // canonical `/api/runs/:id/probe/*` shape. 308 (not 301/302) is
  // required so POST → POST is preserved; some clients (curl, fetch
  // without follow) downgrade 301 to GET on redirect. The
  // `Deprecation: true` header (RFC 8594) signals to monitoring tools
  // that the endpoint is on its way out. Scheduled removal: v0.4.

  const redirectToCanonical = (newPath: string) => (c: Context) => {
    c.header("Deprecation", "true");
    c.header("Link", `<${newPath}>; rel="successor-version"`);
    return c.redirect(newPath, 308);
  };

  app.get("/api/probe/:run_id", (c) =>
    redirectToCanonical(`/api/runs/${encodeURIComponent(c.req.param("run_id"))}/probe`)(c),
  );
  app.get("/api/probe/:run_id/panel", (c) =>
    redirectToCanonical(
      `/api/runs/${encodeURIComponent(c.req.param("run_id"))}/probe/panel`,
    )(c),
  );
  app.post("/api/probe/:run_id/pause", (c) =>
    redirectToCanonical(
      `/api/runs/${encodeURIComponent(c.req.param("run_id"))}/probe/pause`,
    )(c),
  );
  app.post("/api/probe/:run_id/resume", (c) =>
    redirectToCanonical(
      `/api/runs/${encodeURIComponent(c.req.param("run_id"))}/probe/resume`,
    )(c),
  );
  app.post("/api/probe/:run_id/inject", (c) =>
    redirectToCanonical(
      `/api/runs/${encodeURIComponent(c.req.param("run_id"))}/probe/inject`,
    )(c),
  );
  app.post("/api/probe/:run_id/clear", (c) =>
    redirectToCanonical(
      `/api/runs/${encodeURIComponent(c.req.param("run_id"))}/probe/clear`,
    )(c),
  );

  // v0.3 — pre-rendered step-card HTML fragment. The live-update JS on
  // /runs/:id calls this when a `run:updated` event arrives, then
  // appends the returned markup to the steps anchor + adds the matching
  // timeline cell. Keeps render logic server-side (one source of truth)
  // and means the client doesn't have to rebuild the card from JSON.
  app.get("/api/runs/:id/step-card/:seq", async (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    const seq = Number(c.req.param("seq"));
    if (!Number.isFinite(seq)) return c.json({ error: "bad seq" }, 400);
    const step = getStepBySequence(store, run.run_id, seq);
    if (!step) return c.notFound();
    const decisions = await loadDecisionPreviews(store, [step]);
    const fcs = listFileChanges(store, { stepId: step.step_id });
    const fragment = renderStepCardFragment(step, decisions.get(step.step_id) ?? "", fcs);
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(fragment);
  });

  app.get("/diff", (c) => {
    const a = c.req.query("a");
    const b = c.req.query("b");
    const showShared = c.req.query("shared") === "1";
    if (!a || !b) return c.text("usage: /diff?a=<run-id>&b=<run-id>", 400);
    const runA = getRun(store, a);
    const runB = getRun(store, b);
    if (!runA || !runB) return c.notFound();
    const result = diffRuns(store, runA.run_id, runB.run_id);
    return c.html(
      renderShell(
        "Diff",
        renderDiff(runA, runB, result, { showShared }),
        shellOpts(),
      ),
    );
  });

  app.get("/api/runs", (c) => c.json(listRuns(store, { limit: 200 })));
  app.get("/api/runs/:id", (c) => {
    const run = getRun(store, c.req.param("id"));
    return run ? c.json(run) : c.notFound();
  });
  app.get("/api/runs/:id/steps", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    return c.json(listSteps(store, run.run_id));
  });
  app.get("/api/steps/:id", (c) => {
    const step = getStep(store, c.req.param("id"));
    return step ? c.json(step) : c.notFound();
  });
  app.get("/api/blob/:hash", async (c) => {
    // Translate snapshot ids → blob refs if the caller passed a logical
    // snapshot id; raw blob hashes are passed through untouched.
    const raw = c.req.param("hash");
    const ref = resolveSnapshotBlobRef(store, raw);
    const text = await store.blobs.tryGetString(ref);
    if (!text) return c.notFound();
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.body(text);
  });

  /**
   * v0.3 §8.4 — `/api/blob/:hash/render` — content-type-sniffed +
   * (for text) Shiki syntax-highlighted blob viewer.
   *
   * Behaviour:
   *  - image/png|jpeg|gif|webp → raw bytes with proper Content-Type
   *    (the files page consumes this via `<img>` per D7).
   *  - Other binary → application/octet-stream raw bytes (files page
   *    shows a placard at the route-wrapper layer).
   *  - Text → Shiki-rendered HTML in `<pre class="shiki">` cached
   *    under `sha(blob_hash + lang + RENDER_VERSION)` in the blob
   *    store. Subsequent identical requests skip Shiki.
   *
   * Query params:
   *  ?lang=<id>  — force a specific Shiki language. Default: auto
   *                (path-hint sniff, falls back to plaintext).
   *  ?path=<p>   — optional pathHint for language detection. Helpful
   *                when the URL is just a hash with no extension.
   */
  app.get("/api/blob/:hash/render", async (c) => {
    const raw = c.req.param("hash");
    const langOverride = c.req.query("lang");
    const pathHint = c.req.query("path");
    const ref = resolveSnapshotBlobRef(store, raw);
    const buf = await store.blobs.tryGetBuffer(ref);
    if (!buf) return c.notFound();

    const sniff = sniffMimeAndLang(buf, pathHint);

    // Images: serve raw bytes with the detected MIME. Content is
    // content-addressed by hash, so it's immutable forever.
    if (sniff.mime.startsWith("image/")) {
      // Bypass Hono's body type narrowing — we want raw bytes with a
      // specific Content-Type. TS's BodyInit definition is overly
      // strict about ArrayBufferLike here (lib quirk on newer
      // releases); cast through unknown so the runtime stays correct.
      return new Response(
        new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        ) as unknown as BodyInit,
        {
          status: 200,
          headers: {
            "Content-Type": sniff.mime,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        },
      );
    }

    // Non-image binary: octet-stream fallback. The files page wraps
    // this in a "Binary file · application/octet-stream · N bytes"
    // placard per D7; raw consumers (curl, scripts) still get usable
    // bytes.
    if (sniff.binary) {
      return new Response(
        new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        ) as unknown as BodyInit,
        {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        },
      );
    }

    // Text path: resolve language, check the render cache, render
    // on miss + populate cache, serve HTML.
    const effLang =
      langOverride && langOverride !== "auto"
        ? langOverride
        : sniff.lang ?? "plaintext";
    const cacheKey = renderCacheKey(ref, effLang);
    const cached = await store.blobs.tryGetString(cacheKey);
    if (cached !== undefined) {
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.body(cached);
    }
    const html = await renderHighlighted(buf, effLang);
    // Best-effort cache write — a failure here just means the next
    // request re-renders (not a hard error for the user).
    try {
      await store.blobs.putWithKey(html, cacheKey);
    } catch {
      // ignore — render still served below
    }
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(html);
  });

  /**
   * Rendered context viewer. The raw `/api/blob/<snapshot_id>` returns
   * the snapshot manifest (a JSON of pointers); this route resolves
   * every content_ref into the actual text and renders by component,
   * so "view context" shows what the model actually saw.
   *
   * Query params:
   *   ?run=<id>&step=<id>&seq=N  — optional, drives the page meta-row
   */
  app.get("/contexts/:id", async (c) => {
    const snapshotId = c.req.param("id");
    const ref = resolveSnapshotBlobRef(store, snapshotId);
    const manifestText = await store.blobs.tryGetString(ref);
    if (!manifestText) return c.notFound();
    let manifest: ContextSnapshot;
    try {
      manifest = JSON.parse(manifestText) as ContextSnapshot;
    } catch {
      return c.text("invalid snapshot JSON", 500);
    }
    const rendered = await resolveContext(store, manifest);
    // Try to attribute back to a run via the optional query params.
    const runQ = c.req.query("run");
    const stepQ = c.req.query("step");
    const seqQ = c.req.query("seq");
    const run = runQ ? getRun(store, runQ) : undefined;
    if (run) rendered.runtime = run.source_runtime;
    const meta = {
      runId: run?.run_id,
      stepId: stepQ ?? undefined,
      sequence: seqQ !== undefined ? Number(seqQ) : undefined,
    };
    return c.html(
      renderShell(
        `Context · ${snapshotId.slice(0, 12)}`,
        renderContext(snapshotId, rendered, meta),
        shellOpts(),
      ),
    );
  });
  app.get("/api/diff", (c) => {
    const a = c.req.query("a");
    const b = c.req.query("b");
    if (!a || !b) return c.json({ error: "missing a/b" }, 400);
    const ra = getRun(store, a);
    const rb = getRun(store, b);
    if (!ra || !rb) return c.json({ error: "run not found" }, 404);
    return c.json(diffRuns(store, ra.run_id, rb.run_id));
  });

  // POST /api/runs/:id/close — manually seal an in_progress run.
  // Used by the run detail page's "Close" button and by callers who
  // want to finalize a proxy-captured run that has no upstream "end"
  // signal. Body is optional: { status: "ok" | "error" | "abandoned" }
  // (defaults to "ok"). Returns the updated Run row.
  app.post("/api/runs/:id/close", async (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    let status: Run["status"] = "ok";
    try {
      const body = (await c.req.json()) as { status?: string } | null;
      if (body?.status) {
        if (body.status !== "ok" && body.status !== "error" && body.status !== "abandoned") {
          return c.json(
            { error: `invalid status: ${body.status}. allowed: ok | error | abandoned` },
            400,
          );
        }
        status = body.status;
      }
    } catch {
      // empty body / non-JSON body is fine — fall through with default status.
    }
    setRunStatus(store, run.run_id, status, new Date().toISOString());
    updateRunTotals(store, run.run_id);
    const updated = getRun(store, run.run_id);
    return c.json(updated);
  });

  // POST /api/runs/close-stale — bulk-close every in_progress run whose
  // last activity is older than `older_than_minutes` (default 60). Optional
  // `source` filters to one source_runtime (e.g. "proxy"). Returns the
  // count and the list of closed run ids. Idempotent.
  app.post("/api/runs/close-stale", async (c) => {
    let body: { older_than_minutes?: number; source?: string; status?: string } = {};
    try {
      body = ((await c.req.json()) as typeof body) ?? {};
    } catch {
      // empty body OK
    }
    const olderThanMin = body.older_than_minutes ?? 60;
    const source = body.source;
    const status: Run["status"] =
      body.status === "error" || body.status === "abandoned" ? body.status : "ok";
    const cutoffMs = Date.now() - olderThanMin * 60_000;
    const all = listRuns(store, { limit: 1000 });
    const targets = all.filter((r) => {
      if (r.status !== "in_progress") return false;
      if (source && r.source_runtime !== source) return false;
      const startedMs = Date.parse(r.started_at);
      return Number.isFinite(startedMs) && startedMs <= cutoffMs;
    });
    const now = new Date().toISOString();
    for (const r of targets) {
      setRunStatus(store, r.run_id, status, now);
      updateRunTotals(store, r.run_id);
    }
    return c.json({
      closed: targets.length,
      run_ids: targets.map((r) => r.run_id),
      status,
    });
  });

  app.post("/api/annotate", async (c) => {
    const body = (await c.req.json()) as Partial<Annotation> & {
      target_kind?: "step" | "run";
      target_id?: string;
      author?: string;
    };
    if (!body.target_kind || !body.target_id) {
      return c.json({ error: "missing target_kind / target_id" }, 400);
    }
    // Resolve prefix ids before persisting so the API and CLI agree on
    // canonical form. See annotate.ts for the same fix on the CLI side.
    let resolvedId = body.target_id;
    if (body.target_kind === "run") {
      const run = getRun(store, body.target_id);
      if (!run) return c.json({ error: "run not found" }, 404);
      resolvedId = run.run_id;
    } else if (body.target_kind === "step") {
      const step = getStep(store, body.target_id);
      if (!step) return c.json({ error: "step not found" }, 404);
      resolvedId = step.step_id;
    }
    const ann = insertAnnotation(store, {
      targetKind: body.target_kind,
      targetId: resolvedId,
      author: body.author ?? "anonymous",
      verdict: body.verdict,
      note: body.note,
    });
    return c.json(ann);
  });

  app.get("/api/runs/:id/annotations", (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    return c.json(listAnnotations(store, "run", run.run_id));
  });
  app.get("/api/steps/:id/annotations", (c) => {
    const step = getStep(store, c.req.param("id"));
    if (!step) return c.notFound();
    return c.json(listAnnotations(store, "step", step.step_id));
  });

  app.post("/api/fork", async (c) => {
    const body = (await c.req.json()) as {
      origin_run_id: string;
      at: string | number;
      edit_type?: string;
      edit_payload?: unknown;
      fake?: string;
      live?: boolean;
      model?: string;
      continue?: ContinuationMode | "none";
      max_iterations?: number;
      allow_tools?: string[];
    };
    if (!body.origin_run_id || body.at === undefined || !body.edit_type) {
      return c.json({ error: "missing origin_run_id / at / edit_type" }, 400);
    }
    const apiKey = resolveSetting(
      store,
      "anthropic.api_key",
      "ANTHROPIC_API_KEY",
    );
    const model =
      body.model ??
      getSetting(store, "fork.default_model") ??
      "claude-opus-4-7";
    const responder = body.fake
      ? fakeResponder(body.fake)
      : body.live && apiKey
        ? anthropicResponder(store, { apiKey, model })
        : undefined;
    try {
      const result = await forkRun(
        store,
        {
          origin_run_id: body.origin_run_id,
          at: body.at,
          edit: {
            type: body.edit_type as Parameters<typeof forkRun>[1]["edit"]["type"],
            payload: body.edit_payload ?? null,
          },
        },
        responder,
      );

      // Optional multi-step continuation
      let continuation:
        | {
            mode: ContinuationMode;
            iterations: number;
            steps_added: number;
            terminal_reason: string;
          }
        | undefined;
      if (body.continue && body.continue !== "none") {
        if (body.continue !== "simulate" && body.continue !== "live") {
          return c.json({ error: `invalid continue mode: ${body.continue}` }, 400);
        }
        if (body.continue === "live" && !apiKey) {
          return c.json(
            { error: "live continuation requires ANTHROPIC_API_KEY" },
            400,
          );
        }
        const modelCaller: ContinuationModelCaller = async (args) => {
          const { default: Anthropic } = await import("@anthropic-ai/sdk");
          const client = new Anthropic({ apiKey });
          const messages: Array<{
            role: "user" | "assistant";
            content: string;
          }> = [];
          for (const m of args.history) {
            if (m.role === "tool") continue;
            const text = await store.blobs.tryGetString(m.content_ref);
            if (text) messages.push({ role: m.role, content: text });
          }
          const t0 = Date.now();
          const resp = await client.messages.create({
            model,
            max_tokens: 4096,
            system: args.system_prompt,
            messages: messages.length
              ? messages
              : [{ role: "user", content: "(no history)" }],
          });
          const t1 = Date.now();
          const blocks = resp.content ?? [];
          const toolUse = blocks.find(
            (
              b,
            ): b is {
              type: "tool_use";
              id: string;
              name: string;
              input: Record<string, unknown>;
            } => b.type === "tool_use",
          );
          const text = blocks
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const cc = (resp.usage as { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } } | undefined)?.cache_creation;
          return {
            model: resp.model,
            decision_content: resp.content,
            action: toolUse
              ? {
                  kind: "tool_call",
                  tool_name: toolUse.name,
                  tool_use_id: toolUse.id,
                  tool_input: toolUse.input,
                }
              : { kind: "message", text },
            tokens: {
              input: resp.usage?.input_tokens ?? 0,
              output: resp.usage?.output_tokens ?? 0,
              cached_read: resp.usage?.cache_read_input_tokens ?? 0,
              cache_creation:
                cc?.ephemeral_5m_input_tokens ??
                resp.usage?.cache_creation_input_tokens ??
                0,
              cache_creation_1h: cc?.ephemeral_1h_input_tokens ?? 0,
            },
            latency_ms: t1 - t0,
          };
        };
        const allowSet = new Set(body.allow_tools ?? []);
        const toolExecutor: ToolExecutor =
          body.continue === "live"
            ? async (call) => {
                if (!allowSet.has(call.tool_name)) {
                  return {
                    output: { spool_note: `tool '${call.tool_name}' not allowed` },
                    is_error: false,
                    summary: `skipped: ${call.tool_name}`,
                  };
                }
                if (call.tool_name === "Bash") {
                  const cmd = (call.tool_input as { command?: string } | undefined)?.command;
                  if (!cmd) {
                    return { output: { error: "missing command" }, is_error: true, summary: "missing command" };
                  }
                  if (/\brm\s+-[rRfF]|sudo\b|--no-verify/.test(cmd)) {
                    return { output: { error: "destructive command rejected" }, is_error: true, summary: "rejected" };
                  }
                  const { spawnSync } = await import("node:child_process");
                  const r = spawnSync("bash", ["-lc", cmd], {
                    encoding: "utf-8",
                    timeout: 30_000,
                  });
                  return {
                    output: { stdout: r.stdout?.slice(0, 8_000) ?? "", stderr: r.stderr?.slice(0, 2_000) ?? "", exit_code: r.status },
                    is_error: (r.status ?? 0) !== 0,
                    summary: (r.stdout?.split("\n")[0] ?? "").slice(0, 200),
                  };
                }
                return {
                  output: { spool_note: `tool '${call.tool_name}' has no executor; no-op` },
                  is_error: false,
                  summary: `no-op: ${call.tool_name}`,
                };
              }
            : (async () => ({ output: {}, is_error: false }));
        const cont = await continueFork(store, result.fork_run_id, {
          mode: body.continue,
          modelCaller,
          toolExecutor,
          maxIterations: body.max_iterations ?? 25,
          originRunId: body.origin_run_id,
        });
        continuation = {
          mode: body.continue,
          iterations: cont.iterations_run,
          steps_added: cont.steps_added,
          terminal_reason: cont.terminal_reason,
        };
      }

      return c.json({ ...result, continuation });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/tests", (c) => c.json(listTests(store)));
  app.get("/api/tests/:name", (c) => {
    const t = getTestByName(store, c.req.param("name"));
    return t ? c.json(t) : c.notFound();
  });
  app.get("/api/tests/:name/results", (c) => {
    const t = getTestByName(store, c.req.param("name"));
    if (!t) return c.notFound();
    return c.json(listResults(store, t.test_id, 50));
  });
  app.post("/api/tests", async (c) => {
    const body = (await c.req.json()) as {
      name: string;
      description?: string;
      assertions?: Assertion[];
      from_run_id?: string;
    };
    if (!body.name) return c.json({ error: "missing name" }, 400);
    let assertions: Assertion[] = body.assertions ?? [];
    let canonicalRunId: string | undefined;
    if (body.from_run_id) {
      const run = getRun(store, body.from_run_id);
      if (!run) return c.json({ error: "from_run_id not found" }, 404);
      const steps = listSteps(store, run.run_id);
      assertions = deriveAssertionsFromRun(run, steps);
      canonicalRunId = run.run_id;
    }
    try {
      const t = createTest(store, {
        name: body.name,
        description: body.description,
        assertions,
        canonical_run_id: canonicalRunId,
      });
      return c.json(t);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.put("/api/tests/:name/assertions", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json()) as { assertions: Assertion[] };
    const t = getTestByName(store, name);
    if (!t) return c.notFound();
    // Replace whole assertion list — clean for the in-browser editor.
    store.db
      .prepare("UPDATE regression_tests SET assertions_json = ? WHERE test_id = ?")
      .run(JSON.stringify(body.assertions), t.test_id);
    return c.json(getTestByName(store, name));
  });
  app.post("/api/tests/:name/assertions", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json()) as { assertion: Assertion };
    try {
      const t = addAssertion(store, name, body.assertion);
      return c.json(t);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.delete("/api/tests/:name", (c) => {
    const ok = deleteTest(store, c.req.param("name"));
    return ok ? c.json({ ok: true }) : c.notFound();
  });
  app.post("/api/tests/:name/run", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as {
      run_id?: string;
      limit?: number;
    };
    const t = getTestByName(store, name);
    if (!t) return c.notFound();
    let runs = body.run_id
      ? [getRun(store, body.run_id)].filter((r): r is NonNullable<typeof r> => !!r)
      : listRuns(store, { limit: body.limit ?? 50 });
    const results = runs.map((r) => runTest(store, t, r.run_id));
    return c.json(results);
  });

  app.get("/tests", (c) => {
    const tests = listTests(store);
    const recent = listResults(store, undefined, 20);
    return c.html(renderShell("Tests", renderTests(tests, recent), shellOpts()));
  });

  // ─── Settings page + supporting APIs ─────────────────────────────
  app.get("/settings", async (c) => {
    const { renderSettings } = await import("./html.ts");
    const slackWebhook = resolveSetting(store, "slack.webhook", "SPOOL_SLACK_WEBHOOK");
    const apiKey = resolveSetting(store, "anthropic.api_key", "ANTHROPIC_API_KEY");
    const pgUrl = resolveSetting(store, "postgres.url", "SPOOL_DB_URL");
    return c.html(
      renderShell(
        "Settings",
        renderSettings({
          slackWebhook,
          slackWebhookFromEnv: !!process.env.SPOOL_SLACK_WEBHOOK,
          apiKey,
          apiKeyFromEnv: !!process.env.ANTHROPIC_API_KEY,
          postgresUrl: pgUrl,
          postgresUrlFromEnv: !!process.env.SPOOL_DB_URL,
          watchedTools: getSetting(store, "live.watch_tools") ?? "",
          stallSeconds: Number(getSetting(store, "live.stall_seconds") ?? 120),
          defaultModel: getSetting(store, "fork.default_model") ?? "claude-opus-4-7",
          defaultMaxIterations: Number(
            getSetting(store, "fork.default_max_iterations") ?? 25,
          ),
        }),
        shellOpts(),
      ),
    );
  });

  // Settings: persist a key/value
  app.post("/api/settings", async (c) => {
    const body = (await c.req.json()) as { key?: string; value?: string };
    if (!body.key) return c.json({ error: "missing key" }, 400);
    if (body.value === undefined || body.value === "") {
      deleteSetting(store, body.key as SettingKey);
    } else {
      setSetting(store, body.key as SettingKey, body.value);
    }
    return c.json({ ok: true });
  });

  // Doctor: returns the same checks as `spool doctor`, as JSON
  app.get("/api/doctor", async (c) => {
    const { existsSync } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    const { claudeHome, claudeProjectsRoot, dbPath, spoolHome } = await import(
      "@spool/shared"
    );
    const { discoverSessions } = await import("@spool/claude-code-adapter");
    const checks: Array<{
      name: string;
      status: "ok" | "warn" | "fail";
      detail: string;
    }> = [];
    const node = process.versions.node;
    const [major, minor] = node.split(".").map(Number) as [number, number];
    checks.push({
      name: "Node",
      status:
        major > 20 || (major === 20 && minor >= 6) || major >= 22
          ? "ok"
          : major >= 20
            ? "warn"
            : "fail",
      detail: `v${node}`,
    });
    checks.push({ name: "SPOOL_HOME", status: "ok", detail: spoolHome() });
    checks.push({
      name: "CLAUDE_HOME",
      status: existsSync(claudeHome()) ? "ok" : "fail",
      detail: claudeHome(),
    });
    checks.push({
      name: "Claude projects dir",
      status: existsSync(claudeProjectsRoot()) ? "ok" : "warn",
      detail: claudeProjectsRoot(),
    });
    try {
      const sessions = await discoverSessions();
      checks.push({
        name: "Session discovery",
        status: sessions.length > 0 ? "ok" : "warn",
        detail:
          sessions.length === 0
            ? "no .jsonl session files found"
            : `${sessions.length} session(s)`,
      });
    } catch (err) {
      checks.push({
        name: "Session discovery",
        status: "fail",
        detail: (err as Error).message,
      });
    }
    try {
      const s = await stat(dbPath());
      checks.push({
        name: "SQLite store",
        status: "ok",
        detail: `${dbPath()} (${s.size} bytes)`,
      });
    } catch (err) {
      checks.push({
        name: "SQLite store",
        status: "fail",
        detail: (err as Error).message,
      });
    }
    return c.json({ checks });
  });

  // Ingest trigger
  app.post("/api/ingest", async (c) => {
    const body = (await c.req.json()) as {
      runtime?: "claude-code" | "codex-cli" | "cursor";
      limit?: number;
      path?: string;
    };
    if (!body.runtime) return c.json({ error: "missing runtime" }, 400);
    try {
      let runs = 0;
      let steps = 0;
      let bytes = 0;
      let composers = 0;
      if (body.runtime === "claude-code") {
        const { discoverSessions, ingestSession } = await import(
          "@spool/claude-code-adapter"
        );
        let paths: string[] = [];
        if (body.path) paths = [body.path];
        else {
          const sessions = await discoverSessions();
          paths = sessions.map((s) => s.path);
          if (body.limit) paths = paths.slice(0, body.limit);
        }
        for (const p of paths) {
          const r = await ingestSession(store, p);
          if (r.status === "ok") {
            runs += 1;
            steps += r.steps_added;
            bytes += r.bytes_read;
          }
        }
      } else if (body.runtime === "codex-cli") {
        const { discoverCodexSessions, ingestCodexSession } = await import(
          "@spool/codex-cli-adapter"
        );
        let paths: string[] = [];
        if (body.path) paths = [body.path];
        else {
          const sessions = await discoverCodexSessions();
          paths = sessions.map((s) => s.path);
          if (body.limit) paths = paths.slice(0, body.limit);
        }
        for (const p of paths) {
          const r = await ingestCodexSession(store, p);
          if (r.status === "ok") {
            runs += 1;
            steps += r.steps_added;
            bytes += r.bytes_read;
          }
        }
      } else if (body.runtime === "cursor") {
        const { ingestCursorGlobal } = await import("@spool/cursor-adapter");
        const r = await ingestCursorGlobal(store, { limit: body.limit });
        if (r.status === "ok") {
          composers = r.composers_ingested;
          steps = r.steps_added;
        } else {
          return c.json({ error: r.reason ?? "ingest failed" }, 400);
        }
      } else {
        return c.json({ error: "unknown runtime" }, 400);
      }
      return c.json({
        ok: true,
        runtime: body.runtime,
        runs,
        composers,
        steps,
        bytes,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Slack: send a test message
  app.post("/api/slack/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      webhook?: string;
    };
    const url =
      body.webhook ??
      resolveSetting(store, "slack.webhook", "SPOOL_SLACK_WEBHOOK");
    if (!url) return c.json({ error: "missing webhook" }, 400);
    try {
      const n = new SlackNotifier({ webhookUrl: url });
      await n.sendTest();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Postgres: init + sync
  app.post("/api/db/postgres-init", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string };
    const url =
      body.url ?? resolveSetting(store, "postgres.url", "SPOOL_DB_URL");
    if (!url) return c.json({ error: "missing url" }, 400);
    try {
      const { PostgresStore } = await import("@spool/store-postgres");
      const pg = await PostgresStore.open({ url });
      try {
        const r = await pg.client.query<{ value: string }>(
          "SELECT value FROM meta WHERE key='schema_version'",
        );
        return c.json({
          ok: true,
          schema_version: r.rows[0]?.value ?? null,
        });
      } finally {
        await pg.close();
      }
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.post("/api/db/postgres-sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string;
      limit?: number;
    };
    const url =
      body.url ?? resolveSetting(store, "postgres.url", "SPOOL_DB_URL");
    if (!url) return c.json({ error: "missing url" }, 400);
    try {
      const { PostgresStore, syncSqliteToPostgres } = await import(
        "@spool/store-postgres"
      );
      const pg = await PostgresStore.open({ url });
      try {
        const r = await syncSqliteToPostgres(store, pg, {
          limitRuns: body.limit,
        });
        return c.json({ ok: true, ...r });
      } finally {
        await pg.close();
      }
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Run trace export — Spool Trace Format 0.3.0
  //
  // Query params:
  //   ?blobs=0             — skip blob inlining (refs only).
  //   ?file_blobs=1        — inline file-content blobs as well as
  //                          structural blobs. Default off per
  //                          SPEC-V0_3 §10.4 (bug reports get shared).
  //
  // Baseline manifest blobs are always inlined when ?blobs=0 isn't
  // passed — they're structured indexes, not redactable content.
  // Patch text on each FileChange is always present (already
  // routed through the redaction pass at capture time).
  app.get("/api/runs/:id/export", async (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    const includeBlobs = c.req.query("blobs") !== "0";
    const includeFileBlobs = c.req.query("file_blobs") === "1";
    const steps = listSteps(store, run.run_id);
    const file_changes = listFileChanges(store, { runId: run.run_id });
    const baseline_trees = run.baseline_tree_id
      ? [getBaselineTree(store, run.baseline_tree_id)].filter(
          (bt): bt is NonNullable<typeof bt> => !!bt,
        )
      : [];
    const trace: Record<string, unknown> = {
      spool_trace_version: TRACE_FORMAT_VERSION,
      run,
      steps,
      file_changes,
      baseline_trees,
    };
    if (includeBlobs) {
      const blobs: Record<string, string> = {};
      const fileBlobRefs = new Set<string>();
      for (const fc of file_changes) {
        if (fc.before_blob_ref) fileBlobRefs.add(fc.before_blob_ref);
        if (fc.after_blob_ref) fileBlobRefs.add(fc.after_blob_ref);
      }
      const structuralRefs = new Set<string>();
      for (const s of steps) {
        structuralRefs.add(
          resolveSnapshotBlobRef(store, s.context_snapshot_id),
        );
        structuralRefs.add(s.decision_ref);
        if (s.outcome.tool_result_ref) {
          structuralRefs.add(s.outcome.tool_result_ref);
        }
      }
      for (const bt of baseline_trees) {
        if (bt.manifest_blob_ref) {
          structuralRefs.add(bt.manifest_blob_ref);
        }
      }
      const refsToInline = new Set<string>(structuralRefs);
      if (includeFileBlobs) {
        for (const r of fileBlobRefs) refsToInline.add(r);
      }
      for (const r of refsToInline) {
        const text = await store.blobs.tryGetString(r);
        if (text !== undefined) {
          blobs[r] = Buffer.from(text, "utf-8").toString("base64");
        }
      }
      trace.blobs = blobs;
    }
    c.header(
      "Content-Disposition",
      `attachment; filename="${run.run_id}.spool.json"`,
    );
    return c.json(trace);
  });

  return app;
}

/**
 * Walk a ContextSnapshot manifest, resolve every content_ref via the
 * blob store, and produce a RenderedContext with inline text bodies.
 * Falls back to a "(missing blob)" placeholder if a ref can't be
 * resolved — better to show something than a blank page.
 */
async function resolveContext(
  store: Store,
  snapshot: ContextSnapshot,
): Promise<RenderedContext> {
  let totalChars = 0;
  const components: RenderedComponent[] = [];
  const fetchText = async (ref: string): Promise<string> => {
    const text = (await store.blobs.tryGetString(ref)) ?? "(missing blob)";
    totalChars += text.length;
    return text;
  };
  for (const c of snapshot.components) {
    if (c.type === "system_prompt") {
      components.push({
        type: "system_prompt",
        ref: c.content_ref,
        text: await fetchText(c.content_ref),
      });
    } else if (c.type === "tool_definitions") {
      components.push({
        type: "tool_definitions",
        ref: c.content_ref,
        text: await fetchText(c.content_ref),
      });
    } else if (c.type === "conversation_history") {
      const messages: Array<{
        role: "user" | "assistant" | "tool";
        ref: string;
        text: string;
        step_ref?: string;
      }> = [];
      for (const m of (c.messages as ConversationMessage[]) ?? []) {
        messages.push({
          role: m.role,
          ref: m.content_ref,
          text: await fetchText(m.content_ref),
          step_ref: m.step_ref,
        });
      }
      components.push({ type: "conversation_history", messages });
    } else if (c.type === "retrieved_documents") {
      const docs: Array<{ source: string; ref: string; text: string }> = [];
      for (const d of (c.docs as RetrievedDocument[]) ?? []) {
        docs.push({
          source: d.source,
          ref: d.content_ref,
          text: await fetchText(d.content_ref),
        });
      }
      components.push({ type: "retrieved_documents", docs });
    } else if (c.type === "compaction_summary") {
      components.push({
        type: "compaction_summary",
        ref: c.content_ref,
        text: await fetchText(c.content_ref),
        replaces_steps: c.replaces_steps,
      });
    }
  }
  return { components, totalChars };
}

async function loadDecisionPreviews(
  store: Store,
  steps: Step[],
): Promise<Map<string, string>> {
  // Pretty-print mode needs enough of the decision blob to JSON.parse
  // most outputs successfully. 32 kB covers ~99% of model outputs while
  // capping memory cost. Anything truncated trips the
  // `(truncated · view raw)` badge in pretty mode via the
  // DECISION_PREVIEW_LIMIT contract in pretty.ts.
  const out = new Map<string, string>();
  for (const s of steps) {
    const text = await store.blobs.tryGetString(s.decision_ref);
    if (text) out.set(s.step_id, text.slice(0, DECISION_PREVIEW_LIMIT));
  }
  return out;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  live?: boolean;
  liveOptions?: import("./live.ts").LiveOptions;
}

export function serveApp(
  store: Store,
  opts: ServeOptions = {},
): {
  url: string;
  close: () => void;
  controller: LiveController;
  /** Back-compat shim — returns the controller's current inspector
   *  (undefined when not live). Existing callers that captured
   *  `result.live` continue to compile. */
  live?: LiveInspector;
} {
  const controller = new LiveController(store);
  if (opts.live) {
    // Fire-and-forget: start() is async but the server should accept
    // requests immediately. Any callers that need to know when the
    // first tick lands can poll /api/live/status.
    void controller.start(opts.liveOptions);
  }
  const app = buildApp(store, { controller });
  const port = opts.port ?? 4317;
  const host = opts.host ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname: host });
  return {
    url: `http://${host}:${port}`,
    controller,
    get live() {
      // Read-through getter for back-compat — exposes the underlying
      // inspector if live mode is on. `spool web` reads this to log
      // alerts to the console; nothing else in the codebase mutates it.
      return (controller as unknown as { inspector?: LiveInspector }).inspector;
    },
    close: () => {
      controller.stop();
      server.close();
    },
  };
}
