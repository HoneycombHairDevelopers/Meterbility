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
        shellOpts,
      ),
    );
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
        shellOpts,
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
    return c.html(renderShell("Tests", renderTests(tests, recent), shellOpts));
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
        shellOpts,
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

  // Run trace export
  app.get("/api/runs/:id/export", async (c) => {
    const run = getRun(store, c.req.param("id"));
    if (!run) return c.notFound();
    const includeBlobs = c.req.query("blobs") !== "0";
    const steps = listSteps(store, run.run_id);
    const trace: Record<string, unknown> = {
      spool_trace_version: "0.2.0",
      run,
      steps,
    };
    if (includeBlobs) {
      const blobs: Record<string, string> = {};
      const refs = new Set<string>();
      for (const s of steps) {
        refs.add(resolveSnapshotBlobRef(store, s.context_snapshot_id));
        refs.add(s.decision_ref);
        if (s.outcome.tool_result_ref) refs.add(s.outcome.tool_result_ref);
      }
      for (const r of refs) {
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
