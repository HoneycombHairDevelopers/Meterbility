import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { Store, getStep } from "@spool/collector";
import { anthropicCapture } from "./capture-anthropic.ts";
import { openaiCapture } from "./capture-openai.ts";
import { RunGrouper } from "./grouping.ts";
import { matchRoute, PROVIDER_ROUTES, type ProviderName } from "./routes.ts";
import { teeAndCollect } from "./sse.ts";
import {
  appendStep,
  attachToolResult,
  ensureRun,
  type ProjectAgentSpec,
} from "./store-bridge.ts";
import type { ProviderCapture } from "./types.ts";

/**
 * Local LLM-API forward proxy with passthrough capture.
 *
 * The proxy listens on `127.0.0.1:<port>` and forwards every request
 * to the configured upstream for the matching provider. The body and
 * headers pass through untouched (auth headers included — they're
 * never persisted, only forwarded). After the upstream responds, the
 * proxy parses the request + response into a Spool Step and writes it
 * to the local store. Streaming responses are tee'd so the client gets
 * chunks as soon as they arrive — capture happens in parallel.
 *
 * The user wires this into their app once via env var:
 *
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8765
 *   OPENAI_BASE_URL=http://127.0.0.1:8765/v1
 *
 * Or all-at-once via the `spool run` wrapper.
 *
 * Per-provider capture lives in capture-anthropic.ts / capture-openai.ts.
 * Run grouping (deciding when two requests belong together) lives in
 * grouping.ts.
 */

export interface ProxyOptions {
  port?: number;
  host?: string;
  /** Override upstream per provider — useful for self-hosted gateways. */
  upstreams?: Partial<Record<ProviderName, string>>;
  /** Project + agent labels written to every captured Run. */
  spec?: ProjectAgentSpec;
  /** Inject a logger for activity output (defaults to console.log). */
  logger?: (line: string) => void;
}

export interface ProxyHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const CAPTURES: Record<ProviderName, ProviderCapture> = {
  anthropic: anthropicCapture,
  openai: openaiCapture,
};

export async function startProxy(opts: ProxyOptions = {}): Promise<ProxyHandle> {
  const port = opts.port ?? 8765;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.logger ?? ((line: string) => console.log(line));
  const grouper = new RunGrouper();
  const stepsByRun = new Map<string, Map<string, { step_id: string; sequence: number }>>();
  const seenRuns = new Set<string>();
  const spec: ProjectAgentSpec = opts.spec ?? {
    project: process.cwd(),
    agent: "proxy",
  };
  // One store per proxy lifecycle. Opened lazily on first capture so a
  // proxy that gets `close()`'d immediately doesn't spawn a SQLite handle
  // unnecessarily. Tests rely on this being scoped to the proxy instance
  // (not module-global) so each freshHome() gets its own connection.
  let store: Store | undefined;
  const ensureStore = (): Store => {
    if (!store) store = Store.open();
    return store;
  };

  const app = new Hono();

  // Surface internal errors via the configured logger. Without this,
  // Hono swallows exceptions into a generic 500 — debugging-hostile.
  app.onError((err, c) => {
    log(`internal error on ${c.req.method} ${c.req.path}: ${(err as Error).stack ?? err}`);
    return c.json({ error: `proxy internal error: ${(err as Error).message}` }, 500);
  });

  // Health endpoint — handy for `spool run` to poll readiness.
  app.get("/__spool/health", (c) => c.json({ ok: true, providers: PROVIDER_ROUTES.map((r) => r.provider) }));

  // Catch-all: route by path prefix.
  app.all("/*", async (c) => {
    const route = matchRoute(c.req.path);
    if (!route) {
      return c.json(
        {
          error:
            "no Spool proxy route for this path. Supported: " +
            PROVIDER_ROUTES.map((r) => r.path).join(", "),
        },
        404,
      );
    }
    const upstream = (opts.upstreams?.[route.provider] ?? route.defaultUpstream).replace(/\/$/, "");
    const targetUrl = upstream + c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "");
    const method = c.req.method;
    const reqBody = method === "GET" || method === "HEAD" ? undefined : await c.req.text();
    const headers = forwardHeaders(c.req.raw.headers);

    const t0 = Date.now();
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(targetUrl, {
        method,
        headers,
        body: reqBody,
        // @ts-expect-error duplex is required for streaming bodies in Node fetch
        duplex: "half",
      });
    } catch (err) {
      log(`proxy error → ${targetUrl}: ${(err as Error).message}`);
      return c.json({ error: `proxy upstream error: ${(err as Error).message}` }, 502);
    }
    const t1 = Date.now();

    const capture = CAPTURES[route.provider];

    // Branch: streaming vs buffered response.
    const ctype = upstreamResp.headers.get("content-type") ?? "";
    const isStream = ctype.includes("text/event-stream");

    if (isStream && upstreamResp.body) {
      const { clientStream, capturePromise } = teeAndCollect(upstreamResp.body);
      // Fire-and-forget capture so streaming back to the client isn't blocked.
      void capturePromise.then(async (collected) => {
        await persistCapture({
          store: ensureStore(),
          provider: route.provider,
          capture,
          reqBody: reqBody ?? "",
          rawResponse: collected,
          isStream: true,
          status: upstreamResp.status,
          latency_ms: Date.now() - t0,
          requestStartLatency_ms: t1 - t0,
          headers: c.req.raw.headers,
          grouper,
          stepsByRun,
          seenRuns,
          spec,
          log,
        }).catch((err) => log(`capture error: ${(err as Error).message}`));
      });
      return new Response(clientStream, {
        status: upstreamResp.status,
        headers: stripHopByHopHeaders(upstreamResp.headers),
      });
    }

    const respBody = await upstreamResp.text();
    // Don't block the client response on capture — kick it off async.
    void persistCapture({
      store: ensureStore(),
      provider: route.provider,
      capture,
      reqBody: reqBody ?? "",
      rawResponse: respBody,
      isStream: false,
      status: upstreamResp.status,
      latency_ms: t1 - t0,
      requestStartLatency_ms: t1 - t0,
      headers: c.req.raw.headers,
      grouper,
      stepsByRun,
      seenRuns,
      spec,
      log,
    }).catch((err) => log(`capture error: ${(err as Error).message}`));
    return new Response(respBody, {
      status: upstreamResp.status,
      headers: stripHopByHopHeaders(upstreamResp.headers),
    });
  });

  let server: ServerType | undefined;
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port, hostname: host }, () => resolve());
  });
  // Resolve the actual listening port — important when caller passed
  // `port: 0` (random) so we report the real assignment back.
  const addr =
    server && typeof (server as { address?: () => unknown }).address === "function"
      ? (server as { address: () => { port?: number } | string | null }).address()
      : null;
  const actualPort =
    typeof addr === "object" && addr && typeof addr.port === "number" ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  log(`spool proxy listening on ${url}`);
  log(`  anthropic → ${(opts.upstreams?.anthropic ?? "https://api.anthropic.com")}/v1/messages`);
  log(`  openai    → ${(opts.upstreams?.openai ?? "https://api.openai.com")}/v1/chat/completions`);

  return {
    url,
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      // Give any in-flight async capture work a brief moment to land
      // before we yank the store out from under it.
      await new Promise((r) => setTimeout(r, 50));
      if (store) store.close();
    },
  };
}

interface PersistArgs {
  store: Store;
  provider: ProviderName;
  capture: ProviderCapture;
  reqBody: string;
  rawResponse: string;
  isStream: boolean;
  status: number;
  latency_ms: number;
  requestStartLatency_ms: number;
  headers: Headers;
  grouper: RunGrouper;
  stepsByRun: Map<string, Map<string, { step_id: string; sequence: number }>>;
  seenRuns: Set<string>;
  spec: ProjectAgentSpec;
  log: (line: string) => void;
}

async function persistCapture(args: PersistArgs): Promise<void> {
  const parsed = args.capture.parseRequest(args.reqBody);
  const explicitRunId = args.headers.get("x-spool-run-id") ?? undefined;
  const explicitProject =
    args.headers.get("x-spool-project") ?? undefined;
  const explicitAgent = args.headers.get("x-spool-agent") ?? undefined;
  const runResolution = args.grouper.resolve(parsed, explicitRunId, Date.now());

  const spec: ProjectAgentSpec = {
    project: explicitProject ?? args.spec.project,
    agent: explicitAgent ?? args.spec.agent,
  };

  if (runResolution.is_new && !args.seenRuns.has(runResolution.run_id)) {
    ensureRun(args.store, spec, runResolution.run_id, {
      title:
        firstUserPreview(parsed.history) ??
        `${args.provider} · ${parsed.model}`,
    });
    args.seenRuns.add(runResolution.run_id);
  }

  // Retro-attach tool_results from the request to the previous Step(s).
  if (parsed.pendingToolResults.length > 0) {
    const stepMap = args.stepsByRun.get(runResolution.run_id);
    if (stepMap) {
      for (const tr of parsed.pendingToolResults) {
        const ref = stepMap.get(tr.tool_use_id);
        if (!ref) continue;
        const step = getStep(args.store, ref.step_id);
        if (!step) continue;
        await attachToolResult(
          args.store,
          step,
          tr.content,
          tr.is_error === true,
        );
        stepMap.delete(tr.tool_use_id);
      }
    }
  }

  // HTTP-level errors → record an error step with no decision.
  if (args.status >= 400) {
    const step = await appendStep(args.store, {
      run_id: runResolution.run_id,
      sequence: runResolution.step_sequence,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      toolDefinitions: parsed.toolDefinitions,
      history: parsed.history,
      decisionJson: args.rawResponse,
      action: { kind: "none" },
      tokens: {
        input: 0,
        output: 0,
        cached_read: 0,
        cache_creation: 0,
      },
      latency_ms: args.latency_ms,
      outcome: {
        status: "error",
        is_error: true,
        summary: `HTTP ${args.status}`,
      },
    });
    args.log(
      `${args.provider} ${parsed.model} → HTTP ${args.status} (run ${runResolution.run_id.slice(0, 12)} · step ${step.sequence})`,
    );
    return;
  }

  const exchange =
    args.isStream
      ? args.capture.reassembleStream(args.rawResponse)
      : args.capture.parseResponse(args.rawResponse);

  if (!exchange) {
    args.log(
      `${args.provider} capture skipped — could not parse response (status ${args.status})`,
    );
    return;
  }

  const step = await appendStep(args.store, {
    run_id: runResolution.run_id,
    sequence: runResolution.step_sequence,
    model: exchange.model || parsed.model,
    systemPrompt: parsed.systemPrompt,
    toolDefinitions: parsed.toolDefinitions,
    history: parsed.history,
    decisionJson: exchange.decisionJson,
    action: exchange.action,
    tokens: exchange.tokens,
    latency_ms: args.latency_ms,
    outcome: { status: "ok" },
  });

  // If this step was a tool_call, register it so the next request's
  // tool_result can be retro-attached.
  if (exchange.action.kind === "tool_call" && exchange.action.tool_use_id) {
    let stepMap = args.stepsByRun.get(runResolution.run_id);
    if (!stepMap) {
      stepMap = new Map();
      args.stepsByRun.set(runResolution.run_id, stepMap);
    }
    stepMap.set(exchange.action.tool_use_id, {
      step_id: step.step_id,
      sequence: step.sequence,
    });
  }

  const actionLabel =
    exchange.action.kind === "tool_call"
      ? `tool:${exchange.action.tool_name}`
      : exchange.action.kind === "message"
        ? "msg"
        : exchange.action.kind;
  args.log(
    `${args.provider} ${exchange.model} → ${actionLabel} (run ${runResolution.run_id.slice(0, 12)} · step ${step.sequence} · ${args.latency_ms}ms · in ${exchange.tokens.input} out ${exchange.tokens.output})`,
  );
}

// Strip headers that don't make sense to forward verbatim (Hono /
// node:http already handles transfer-encoding etc., but a few extras
// can confuse clients if echoed unchanged).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

function stripHopByHopHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

function forwardHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk === "host") return; // node fetch sets host based on URL
    if (lk.startsWith("x-spool-")) return; // internal annotations don't go upstream
    out.set(k, v);
  });
  return out;
}

function firstUserPreview(
  history: Array<{ role: string; content: string }>,
): string | undefined {
  const u = history.find((m) => m.role === "user");
  if (!u) return undefined;
  return u.content.slice(0, 80);
}

