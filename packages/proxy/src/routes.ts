/**
 * Provider routing table.
 *
 * Each entry maps a path prefix the proxy listens on to:
 *   - the upstream URL the request gets forwarded to,
 *   - which capture function knows how to map this provider's
 *     request/response shape into a Spool Step.
 *
 * The full request path is preserved when forwarding (proxy receives
 * `/v1/messages`, forwards `https://api.anthropic.com/v1/messages`).
 *
 * To add a new provider: add a route here + a capture module under
 * src/capture-<name>.ts. Default upstream is overridable per-route via
 * `--target` flag at runtime — useful for self-hosted gateways.
 */

export type ProviderName = "anthropic" | "openai";

export interface ProviderRoute {
  provider: ProviderName;
  /** Path prefix this route matches (no trailing slash). */
  path: string;
  /** Default upstream origin (no trailing slash). */
  defaultUpstream: string;
  /** Header(s) forwarded to upstream as auth. Stored only as redacted refs. */
  authHeaders: string[];
}

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

export function matchRoute(path: string): ProviderRoute | undefined {
  return PROVIDER_ROUTES.find(
    (r) => path === r.path || path.startsWith(r.path + "/"),
  );
}
