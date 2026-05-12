import { Hono } from "hono";
import { stream } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { Annotation, Run, Step } from "@spool/shared";
import {
  getRun,
  getStep,
  listAnnotations,
  listForks,
  listRuns,
  listSteps,
  insertAnnotation,
  resolveSnapshotBlobRef,
} from "@spool/collector";
import type { Store } from "@spool/collector";
import { diffRuns } from "./diff.ts";
import {
  renderShell,
  renderRunList,
  renderRun,
  renderDiff,
  renderFleet,
} from "./html.ts";
import { LiveInspector, type LiveEvent } from "./live.ts";

/**
 * Hono app over the local Store. Two surfaces share the same routes:
 *  - JSON API (`/api/...`) — for future web/UI clients.
 *  - Server-rendered HTML (`/`, `/runs/:id`, `/diff?a=&b=`) — what
 *    `spool web` opens by default.
 */
export interface BuildAppOptions {
  /** When provided, the live inspector is mounted and SSE streams its events. */
  live?: LiveInspector;
}

export function buildApp(store: Store, opts: BuildAppOptions = {}) {
  const app = new Hono();

  app.get("/", (c) => {
    if (opts.live) {
      const entries = opts.live.fleetEntries();
      return c.html(renderShell("Spool · Fleet", renderFleet(entries)));
    }
    const runs = listRuns(store, { limit: 100 });
    return c.html(renderShell("Spool", renderRunList(runs)));
  });

  app.get("/runs", (c) => {
    const runs = listRuns(store, { limit: 200 });
    return c.html(renderShell("Runs", renderRunList(runs)));
  });

  // Server-Sent Events for the live fleet view.
  if (opts.live) {
    const live = opts.live;
    app.get("/api/live", (c) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      return stream(c, async (s) => {
        const send = (e: LiveEvent) => {
          void s.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        const handler = (e: LiveEvent) => send(e);
        live.on("data", handler);
        // Initial snapshot so the client populates immediately.
        send({ type: "fleet:snapshot", entries: live.fleetEntries() });
        await new Promise<void>((resolve) => {
          s.onAbort(() => {
            live.off("data", handler);
            resolve();
          });
        });
      });
    });
  }

  app.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const run = getRun(store, runId);
    if (!run) return c.notFound();
    const steps = listSteps(store, runId);
    const annotations = listAnnotations(store, "run", runId);
    const forks = listForks(store, runId);
    const stepDecisions = await loadDecisionPreviews(store, steps);
    return c.html(
      renderShell(
        run.title ?? runId,
        renderRun(run, steps, annotations, forks, stepDecisions),
      ),
    );
  });

  app.get("/diff", (c) => {
    const a = c.req.query("a");
    const b = c.req.query("b");
    if (!a || !b) return c.text("usage: /diff?a=<run-id>&b=<run-id>", 400);
    const runA = getRun(store, a);
    const runB = getRun(store, b);
    if (!runA || !runB) return c.notFound();
    const result = diffRuns(store, runA.run_id, runB.run_id);
    return c.html(renderShell("Diff", renderDiff(runA, runB, result)));
  });

  app.get("/api/runs", (c) => c.json(listRuns(store, { limit: 200 })));
  app.get("/api/runs/:id", (c) => {
    const run = getRun(store, c.req.param("id"));
    return run ? c.json(run) : c.notFound();
  });
  app.get("/api/runs/:id/steps", (c) => {
    return c.json(listSteps(store, c.req.param("id")));
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
  app.get("/api/diff", (c) => {
    const a = c.req.query("a");
    const b = c.req.query("b");
    if (!a || !b) return c.json({ error: "missing a/b" }, 400);
    const ra = getRun(store, a);
    const rb = getRun(store, b);
    if (!ra || !rb) return c.json({ error: "run not found" }, 404);
    return c.json(diffRuns(store, ra.run_id, rb.run_id));
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
    const ann = insertAnnotation(store, {
      targetKind: body.target_kind,
      targetId: body.target_id,
      author: body.author ?? "anonymous",
      verdict: body.verdict,
      note: body.note,
    });
    return c.json(ann);
  });

  return app;
}

async function loadDecisionPreviews(
  store: Store,
  steps: Step[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of steps) {
    const text = await store.blobs.tryGetString(s.decision_ref);
    if (text) out.set(s.step_id, text.slice(0, 4000));
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
): { url: string; close: () => void; live?: LiveInspector } {
  let live: LiveInspector | undefined;
  if (opts.live) {
    live = new LiveInspector(store, opts.liveOptions);
    void live.start();
  }
  const app = buildApp(store, { live });
  const port = opts.port ?? 4317;
  const host = opts.host ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname: host });
  return {
    url: `http://${host}:${port}`,
    live,
    close: () => {
      live?.stop();
      server.close();
    },
  };
}
