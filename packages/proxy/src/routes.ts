/**
 * Provider routing registry.
 *
 * Two kinds of route, one table:
 *
 *   - **Bare paths** (backward compatible): `/v1/messages` and
 *     `/v1/chat/completions` route to the built-in anthropic/openai
 *     providers exactly as they always have. The full request path is
 *     preserved when forwarding.
 *
 *   - **Prefixed paths**: `/<name>/<rest>` routes to the provider
 *     registered under `<name>` (built-ins included — `/openai/v1/...`
 *     works too). The prefix is stripped and `<rest>` is forwarded to
 *     the provider's upstream, which may itself carry a path segment
 *     (e.g. `https://api.groq.com/openai`). Everything under a
 *     registered prefix forwards; capture is attempted only when the
 *     forwarded path matches the provider dialect's capture path.
 *
 * A provider is three fields: name → upstream URL → capture dialect.
 * The dialect picks which capture module (`capture-<dialect>.ts`) knows
 * how to map the request/response shape into a Meterbility Step. Users
 * register providers with the repeatable `--upstream <name>[:<dialect>]=<url>`
 * flag on `meter proxy` / `meter run`; the default upstream of a
 * built-in is overridable via `--anthropic-target` / `--openai-target`,
 * which re-points the provider entity itself — bare and prefixed
 * aliases both follow (one provider = one upstream, always).
 */

/**
 * Capture dialect — which request/response shape a provider speaks.
 * `ProviderName` is the legacy alias from when the only providers WERE
 * the dialects; kept for the public package export.
 */
export type Dialect = "anthropic" | "openai";
export type ProviderName = Dialect;

export interface ProviderRoute {
  provider: ProviderName;
  /** Path prefix this route matches (no trailing slash). */
  path: string;
  /** Default upstream origin (no trailing slash). */
  defaultUpstream: string;
  /** Header(s) treated as auth for this dialect. Documentation only
   *  today: no proxy code consults this list — capture never persists
   *  request headers at all (persistCapture reads only x-meterbility-*
   *  values), which is what actually keeps credentials out of the
   *  store. Kept on the public ProviderRoute export for reference. */
  authHeaders: string[];
}

/** The built-in dialect routes. Seeds the registry's default providers. */
export const PROVIDER_ROUTES: ProviderRoute[] = [
  {
    provider: "anthropic",
    path: "/v1/messages",
    defaultUpstream: "https://api.anthropic.com",
    authHeaders: ["x-api-key", "authorization", "anthropic-beta"],
  },
  {
    provider: "openai",
    path: "/v1/chat/completions",
    defaultUpstream: "https://api.openai.com",
    authHeaders: ["authorization", "openai-organization", "openai-project"],
  },
];

/** Capture path per dialect — the one path whose exchanges become Steps. */
export const DIALECT_CAPTURE_PATH: Record<Dialect, string> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
};

/** A registered provider: name → upstream → dialect. */
export interface ProviderDef {
  /** Registry key and URL prefix segment (`/<name>/...`). */
  name: string;
  dialect: Dialect;
  /** Upstream base URL, trailing slashes stripped. May carry a path.
   *  The full URL is never persisted (proxy log lines only); the HOST
   *  is — see `host` below — which is what disambiguates a provider
   *  name reused against different upstreams across sessions. */
  upstream: string;
  /** `host[:port]` of the upstream, precomputed at registry build so
   *  the per-request capture path never re-parses the URL. This is the
   *  value persisted as `Run.upstream_host` (host only — never path,
   *  query, or credentials). */
  host: string;
  /** True for the pre-registered openai/anthropic defaults. */
  builtin: boolean;
}

/** Parsed-but-not-yet-registered provider (what the flag parser emits). */
export interface ProviderInput {
  name: string;
  dialect: Dialect;
  url: string;
}

export type ProviderRegistry = Map<string, ProviderDef>;

const NAME_RE = /^[a-z0-9-]+$/;
/** Path segments that can never be provider names (they'd shadow the
 *  bare API paths). Built-in names are rejected separately as
 *  duplicates of the pre-registered defaults. */
const ILLEGAL_SEGMENTS = new Set(["v1"]);
// Derived from the capture-path record so the Dialect union, the capture
// paths, and this validator can never drift apart.
const DIALECTS = new Set<string>(Object.keys(DIALECT_CAPTURE_PATH));

/**
 * Validate a provider input (name grammar, reserved segments, dialect,
 * URL shape). Shared by `parseUpstreamFlag` (CLI) and `buildRegistry`
 * (library callers of `startProxy({providers})`) so the programmatic
 * API enforces the same contract as the flag — a name like "v1" or a
 * credential-bearing URL is rejected on every path in.
 */
export function validateProviderInput(input: ProviderInput): void {
  const { name, dialect, url } = input;
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid --upstream name ${JSON.stringify(name)}: must match [a-z0-9-]+`,
    );
  }
  if (ILLEGAL_SEGMENTS.has(name)) {
    throw new Error(
      `invalid --upstream name ${JSON.stringify(name)}: reserved path segment`,
    );
  }
  if (!DIALECTS.has(dialect)) {
    throw new Error(
      `invalid --upstream dialect ${JSON.stringify(dialect)}: must be "openai" or "anthropic"`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid --upstream url ${JSON.stringify(url)}: not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `invalid --upstream url ${JSON.stringify(url)}: must be http or https`,
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `invalid --upstream url ${JSON.stringify(url)}: must not carry a query string or fragment`,
    );
  }
  // Userinfo credentials would be printed verbatim in startup banners
  // and error log lines, and fetch() rejects credential-bearing URLs at
  // request time anyway — fail at parse time with a usable message.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `invalid --upstream url ${JSON.stringify(url)}: must not embed credentials — pass keys via client headers`,
    );
  }
}

/**
 * Parse one `--upstream` flag value: `<name>[:<dialect>]=<url>`.
 *
 * Split on the FIRST `=` — URLs contain colons, so the left side is
 * `name[:dialect]` and everything right of the first `=` is the URL.
 * Throws with a user-facing message on any malformed input; callers
 * (CLI and `startProxy`) surface it as a hard startup error.
 */
export function parseUpstreamFlag(value: string): ProviderInput {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) {
    throw new Error(
      `invalid --upstream ${JSON.stringify(value)}: expected <name>[:<dialect>]=<url>`,
    );
  }
  const left = value.slice(0, eq);
  const url = value.slice(eq + 1);
  const colon = left.indexOf(":");
  const name = colon === -1 ? left : left.slice(0, colon);
  const dialect = colon === -1 ? "openai" : left.slice(colon + 1);
  const input = { name, dialect: dialect as Dialect, url };
  validateProviderInput(input);
  return input;
}

/**
 * Build the provider registry: built-ins first (upstreams overridable
 * per provider — the override re-points the provider entity, so bare
 * and prefixed aliases both follow it), then user-registered providers.
 * Throws on duplicate names, including collisions with built-ins.
 */
export function buildRegistry(opts: {
  upstreams?: Partial<Record<ProviderName, string>>;
  providers?: ProviderInput[];
}): ProviderRegistry {
  const registry: ProviderRegistry = new Map();
  for (const route of PROVIDER_ROUTES) {
    const upstream = stripTrailingSlash(
      opts.upstreams?.[route.provider] ?? route.defaultUpstream,
    );
    registry.set(route.provider, {
      name: route.provider,
      dialect: route.provider,
      upstream,
      host: new URL(upstream).host,
      builtin: true,
    });
  }
  for (const input of opts.providers ?? []) {
    // Same contract as the CLI flag — library callers of
    // startProxy({providers}) don't get to register "v1", uppercase
    // names, or credential-bearing URLs either.
    validateProviderInput(input);
    const existing = registry.get(input.name);
    if (existing) {
      throw new Error(
        existing.builtin
          ? `--upstream name ${JSON.stringify(input.name)} is a built-in provider; use --${input.name}-target to re-point it`
          : `duplicate --upstream name ${JSON.stringify(input.name)}`,
      );
    }
    const upstream = stripTrailingSlash(input.url);
    registry.set(input.name, {
      name: input.name,
      dialect: input.dialect,
      upstream,
      host: new URL(upstream).host,
      builtin: false,
    });
  }
  return registry;
}

export interface RouteMatch {
  def: ProviderDef;
  /** Path to append to the provider's upstream (query string excluded —
   *  the server re-attaches it). Prefix already stripped. */
  forwardPath: string;
  /** True only when forwardPath is the dialect's capture path — the
   *  exchange becomes a Step. Everything else forwards untouched and
   *  writes no rows. */
  capture: boolean;
}

/**
 * Match a request path against the registry. Bare dialect capture
 * paths hit the built-ins (backward compatible); `/<name>/<rest>` hits
 * the provider registered under `<name>` with the prefix stripped.
 */
/** Dot-segments (raw) or percent-encoded dot/slash/backslash in a
 *  request path. Legit LLM API paths never contain these; they only
 *  appear when someone is trying to escape a path-carrying upstream
 *  base (e.g. groq's `/openai`) via `/..%2f` tricks that survive WHATWG
 *  normalization at the framework layer. */
const SUSPICIOUS_PATH = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c/i;

export function matchRoute(
  path: string,
  registry: ProviderRegistry,
): RouteMatch | undefined {
  // Reject traversal-shaped paths outright — a non-match 404s upstream
  // of any forwarding, so nothing escapes a provider's base path.
  if (SUSPICIOUS_PATH.test(path)) return undefined;
  // Bare paths — today's contract, unchanged.
  for (const def of registry.values()) {
    if (!def.builtin) continue;
    const cap = DIALECT_CAPTURE_PATH[def.dialect];
    if (path === cap || path.startsWith(cap + "/")) {
      return { def, forwardPath: path, capture: true };
    }
  }
  // Prefixed paths: /<name>/<rest...>
  const m = /^\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return undefined;
  const def = registry.get(m[1]!);
  if (!def) return undefined;
  const forwardPath = m[2] && m[2] !== "" ? m[2] : "/";
  const cap = DIALECT_CAPTURE_PATH[def.dialect];
  const capture = forwardPath === cap || forwardPath.startsWith(cap + "/");
  return { def, forwardPath, capture };
}

/** Join an upstream base (possibly carrying its own path segment) with
 *  a forward path. Upstream trailing slashes are stripped at registry
 *  build; forwardPath always starts with `/` — plain concat is exact,
 *  no doubled or dropped segments. */
export function joinUpstream(upstream: string, forwardPath: string): string {
  return upstream + forwardPath;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
