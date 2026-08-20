import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { Store, getStep } from "@meterbility/collector";
import { anthropicCapture } from "./capture-anthropic.ts";
import { openaiCapture } from "./capture-openai.ts";
import { RunGrouper } from "./grouping.ts";
import {
  buildRegistry,
  DIALECT_CAPTURE_PATH,
  joinUpstream,
  matchRoute,
  type Dialect,
  type ProviderInput,
  type ProviderName,
} from "./routes.ts";
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
 * proxy parses the request + response into a Meterbility Step and writes it
 * to the local store. Streaming responses are tee'd so the client gets
 * chunks as soon as they arrive — capture happens in parallel.
 *
 * The user wires this into their app once via env var:
 *
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8765
 *   OPENAI_BASE_URL=http://127.0.0.1:8765/v1
 *
 * Named upstreams (multi-provider) get a provider-prefixed base URL —
 * one port, concurrent providers, prefix stripped before forwarding:
 *
 *   meter proxy --upstream nvidia=https://integrate.api.nvidia.com
 *   OPENAI_BASE_URL=http://127.0.0.1:8765/nvidia/v1
 *
 * Or all-at-once via the `meter run` wrapper.
 *
 * Per-dialect capture lives in capture-anthropic.ts / capture-openai.ts.
 * Provider routing (bare + prefixed) lives in routes.ts. Run grouping
 * (deciding when two requests belong together) lives in grouping.ts.
 */

export interface ProxyOptions {
  port?: number;
  host?: string;
  /** Override a DEFAULT provider's upstream — re-points the provider
   *  entity itself, so bare and `/openai/...`-style prefixed aliases
   *  both follow. Useful for self-hosted gateways. */
  upstreams?: Partial<Record<ProviderName, string>>;
  /** Register additional named providers (`--upstream` flag). Each gets
   *  a `/<name>/...` prefix route and captures with its dialect's
   *  parser. Validate flag strings with `parseUpstreamFlag()`. */
  providers?: ProviderInput[];
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

const CAPTURES: Record<Dialect, ProviderCapture> = {
  anthropic: anthropicCapture,
  openai: openaiCapture,
};

export async function startProxy(opts: ProxyOptions = {}): Promise<ProxyHandle> {
  const port = opts.port ?? 8765;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.logger ?? ((line: string) => console.log(line));
  // Throws on duplicate/invalid providers — a hard startup error by
  // design (a proxy with a silently-dropped provider mislabels data).
  const registry = buildRegistry({
    upstreams: opts.upstreams,
    providers: opts.providers,
  });
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

  // Health endpoint — handy for `meter run` to poll readiness.
  // Enumerates the dynamic registry, not a static table.
  app.get("/__meter/health", (c) =>
    c.json({ ok: true, providers: [...registry.keys()] }),
  );

  // Catch-all: route by bare capture path or provider prefix.
  app.all("/*", async (c) => {
    // Loop guard: a request that already passed through a Meterbility
    // proxy (this one via `--upstream self=...`, or a chained meter
    // proxy) must not re-enter — the cycle would double-count captured
    // steps and recurse until sockets exhaust.
    if (c.req.raw.headers.get(HOP_HEADER)) {
      return c.json(
        { error: "Meterbility proxy loop detected (request already carries " + HOP_HEADER + ")" },
        508,
      );
    }
    // Traversal guard: dot-segments or percent-encoded slash/dot/backslash
    // in the path could escape a path-carrying upstream base after the
    // prefix strip (e.g. /groq/v1/..%2f..%2fadmin joined onto
    // https://api.groq.com/openai). No legitimate LLM API path contains
    // any of these, so reject flat rather than trying to normalize.
    if (hasPathTraversal(c.req.path, c.req.url)) {
      return c.json(
        { error: "path contains dot-segments or encoded path separators — rejected" },
        400,
      );
    }
    const route = matchRoute(c.req.path, registry);
    if (!route) {
      const bare = [...registry.values()]
        .filter((d) => d.builtin)
        .map((d) => DIALECT_CAPTURE_PATH[d.dialect]);
      const prefixed = [...registry.keys()].map((n) => `/${n}/...`);
      return c.json(
        {
          error:
            "no Meterbility proxy route for this path. Supported: " +
            [...bare, ...prefixed].join(", "),
        },
        404,
      );
    }
    // slice(indexOf) not split("?")[1] — a raw "?" is legal INSIDE a
    // query component, and split would silently truncate everything
    // after the second one.
    const qIdx = c.req.url.indexOf("?");
    const targetUrl =
      joinUpstream(route.def.upstream, route.forwardPath) +
      (qIdx === -1 ? "" : c.req.url.slice(qIdx));
    const method = c.req.method;
    const reqBody = method === "GET" || method === "HEAD" ? undefined : await c.req.text();
    const headers = forwardHeaders(c.req.raw.headers);
    headers.set(HOP_HEADER, "1");

    const t0 = Date.now();
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(targetUrl, {
        method,
        headers,
        body: reqBody,
        // Never follow upstream redirects: undici forwards non-standard
        // auth headers (x-api-key etc.) cross-origin, and a redirected
        // response would be captured under the named provider's label.
        // Relay the 3xx verbatim — the client's SDK decides.
        redirect: "manual",
        // @ts-expect-error duplex is required for streaming bodies in Node fetch
        duplex: "half",
      });
    } catch (err) {
      // Log origin+path only: some gateways pass credentials as query
      // params, and an error line must never persist them.
      const logUrl = qIdx === -1 ? targetUrl : targetUrl.slice(0, targetUrl.indexOf("?"));
      log(`proxy error → ${logUrl}: ${(err as Error).message}`);
      return c.json({ error: `proxy upstream error: ${(err as Error).message}` }, 502);
    }
    const t1 = Date.now();

    // Non-capture path under a registered prefix (e.g. /nvidia/v1/models):
    // pure passthrough — forward the response, write no rows, open no store.
    if (!route.capture) {
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: stripHopByHopHeaders(upstreamResp.headers),
      });
    }

    const capture = CAPTURES[route.def.dialect];

    // Branch: streaming vs buffered response.
    const ctype = upstreamResp.headers.get("content-type") ?? "";
    const isStream = ctype.includes("text/event-stream");

    if (isStream && upstreamResp.body) {
      const { clientStream, capturePromise } = teeAndCollect(upstreamResp.body);
      // Fire-and-forget capture so streaming back to the client isn't blocked.
      // The rejection handler on capturePromise ITSELF matters: a mid-stream
      // upstream reset rejects it, and an unhandled rejection kills the whole
      // proxy process (no global handler exists — by design).
      void capturePromise.then(async (collected) => {
        await persistCapture({
          store: ensureStore(),
          provider: route.def.name,
          upstreamHost: route.def.host,
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
      }, (err: unknown) => log(`stream capture aborted: ${(err as Error).message}`));
      return new Response(clientStream, {
        status: upstreamResp.status,
        headers: stripHopByHopHeaders(upstreamResp.headers),
      });
    }

    const respBody = await upstreamResp.text();
    // Don't block the client response on capture — kick it off async.
    void persistCapture({
      store: ensureStore(),
      provider: route.def.name,
      upstreamHost: route.def.host,
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
  log(`meter proxy listening on ${url}`);
  const namePad = Math.max(...[...registry.keys()].map((n) => n.length));
  for (const def of registry.values()) {
    const alias = def.builtin
      ? `${DIALECT_CAPTURE_PATH[def.dialect]} and /${def.name}/...`
      : `/${def.name}/...`;
    log(`  ${def.name.padEnd(namePad)} → ${def.upstream}  (${alias})`);
  }

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
  /** Provider NAME (registry key, e.g. "nvidia") — the persisted
   *  identity. The capture dialect travels separately via `capture`. */
  provider: string;
  /** Upstream host:port — recorded on the Run for provenance. */
  upstreamHost: string;
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
  const explicitRunId = args.headers.get("x-meterbility-run-id") ?? undefined;
  const explicitProject =
    args.headers.get("x-meterbility-project") ?? undefined;
  const explicitAgent = args.headers.get("x-meterbility-agent") ?? undefined;
  const runResolution = args.grouper.resolve(
    parsed,
    explicitRunId,
    Date.now(),
    args.provider,
  );

  const spec: ProjectAgentSpec = {
    project: explicitProject ?? args.spec.project,
    agent: explicitAgent ?? args.spec.agent,
  };

  if (runResolution.is_new && !args.seenRuns.has(runResolution.run_id)) {
    ensureRun(args.store, spec, runResolution.run_id, {
      title:
        firstUserPreview(parsed.history) ??
        `${args.provider} · ${parsed.model}`,
      // Edge-supplied attribution (stripped before forwarding upstream,
      // same as the other x-meterbility-* annotations).
      cwd: args.headers.get("x-meterbility-cwd") ?? undefined,
      git_branch: args.headers.get("x-meterbility-git-branch") ?? undefined,
      // Namespaced: getRunBySessionId is a shared join surface across
      // adapters (codex session ids, cursor composerIds) — a raw
      // caller-chosen id could collide with another vendor's session.
      source_session_id: explicitRunId ? `proxy:${explicitRunId}` : undefined,
      provider: args.provider,
      upstream_host: args.upstreamHost,
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
      provider: args.provider,
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

  const usageMissing =
    exchange.tokens.input === 0 && exchange.tokens.output === 0;
  const step = await appendStep(args.store, {
    run_id: runResolution.run_id,
    sequence: runResolution.step_sequence,
    provider: args.provider,
    // Persistent marker for the zero-usage warning below — the log
    // line vanishes under --quiet, the tag doesn't.
    extraTags: usageMissing ? ["usage:missing"] : undefined,
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

  // A successful exchange with zero tokens in AND out almost always
  // means the upstream's usage accounting didn't parse (e.g. an
  // "OpenAI-compatible" host with a different usage shape). Silent
  // under-reporting is the cardinal sin in an audit product — warn.
  if (usageMissing) {
    args.log(
      `${args.provider} ${exchange.model} → WARNING: captured ok-step with zero token usage — upstream usage fields may not match the ${args.provider} dialect`,
    );
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

/**
 * True when a request path could traverse out of its provider's
 * upstream base. The WHATWG URL layer already normalizes literal and
 * %2e-encoded dot-segments before routing (they resolve within the
 * prefix and can't escape the upstream join), so the live threat is
 * percent-encoded slash/backslash — NOT decoded by the URL layer, but
 * possibly decoded by the upstream into a real traversal. The
 * dot-segment check is defense-in-depth for any server stack that
 * skips normalization. Query string exempt — only the path is joined
 * onto the upstream.
 */
function hasPathTraversal(path: string, rawUrl: string): boolean {
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return true;
  const qIdx = rawUrl.indexOf("?");
  const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  return /%2e|%2f|%5c/i.test(rawPath);
}

/**
 * Loop-guard marker. Stamped on every request this proxy forwards
 * (AFTER forwardHeaders runs, so the x-meterbility-* strip can't eat
 * it); a request that arrives already carrying it has passed through a
 * Meterbility proxy — e.g. `--upstream self=<this proxy>` or a chained
 * `meter proxy` — and is rejected with 508 before it can double-count
 * steps or recurse until sockets exhaust.
 */
const HOP_HEADER = "x-meterbility-hop";

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
    if (lk.startsWith("x-meterbility-")) return; // internal annotations don't go upstream
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

