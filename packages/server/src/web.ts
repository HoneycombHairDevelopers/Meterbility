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
  renderTests,
  renderContext,
  type RenderedComponent,
  type RenderedContext,
} from "./html.ts";
import type {
  ContextSnapshot,
  ConversationMessage,
  RetrievedDocument,
} from "@spool/shared";
import {
  LiveInspector,
  buildFleetEntries,
  type LiveEvent,
} from "./live.ts";
import { forkRun, fakeResponder, anthropicResponder } from "./fork.ts";
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
  /** When provided, the live inspector is mounted and SSE streams its events. */
  live?: LiveInspector;
}

export function buildApp(store: Store, opts: BuildAppOptions = {}) {
  const app = new Hono();
  const liveMode = opts.live !== undefined;
  const shellOpts = { liveMode };

  app.get("/", (c) => {
    // Fleet view always renders. With --live, alerts come from the
    // running LiveInspector; without --live, we build a one-shot
    // snapshot from the same heuristics — `firedAlerts` is just
    // omitted, so each card shows no alerts. The /api/live SSE
    // endpoint only mounts under --live, and the client checks the
    // live-mode meta tag before opening an EventSource.
    const entries = opts.live
      ? opts.live.fleetEntries()
      : buildFleetEntries(store, { limit: 50 });
    return c.html(renderShell("Spool · Fleet", renderFleet(entries, { liveMode }), shellOpts));
  });

  app.get("/runs", (c) => {
    const runs = listRuns(store, { limit: 200 });
    return c.html(renderShell("Runs", renderRunList(runs), shellOpts));
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
    // Use run.run_id (the resolved canonical id) rather than runId
    // (which may be a prefix like "run_abc12345"). Otherwise reads
    // against steps/annotations/forks return empty.
    const steps = listSteps(store, run.run_id);
    const annotations = listAnnotations(store, "run", run.run_id);
    const forks = listForks(store, run.run_id);
    const stepDecisions = await loadDecisionPreviews(store, steps);
    return c.html(
      renderShell(
        run.title ?? run.run_id,
        renderRun(run, steps, annotations, forks, stepDecisions),
        shellOpts,
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
    return c.html(renderShell("Diff", renderDiff(runA, runB, result), shellOpts));
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
        shellOpts,
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
    };
    if (!body.origin_run_id || body.at === undefined || !body.edit_type) {
      return c.json({ error: "missing origin_run_id / at / edit_type" }, 400);
    }
    const responder = body.fake
      ? fakeResponder(body.fake)
      : body.live && process.env.ANTHROPIC_API_KEY
        ? anthropicResponder(store, {
            apiKey: process.env.ANTHROPIC_API_KEY,
            model: "claude-opus-4-7",
          })
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
      return c.json(result);
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
    return c.html(renderShell("Tests", renderTests(tests, recent), shellOpts));
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
