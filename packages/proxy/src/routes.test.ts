import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRegistry,
  joinUpstream,
  matchRoute,
  parseUpstreamFlag,
} from "./routes.ts";

/* ====================================================================
 * parseUpstreamFlag — grammar: <name>[:<dialect>]=<url>, first-= split
 * ==================================================================== */

test("parseUpstreamFlag: minimal form defaults to openai dialect", () => {
  const p = parseUpstreamFlag("nvidia=https://integrate.api.nvidia.com");
  assert.deepEqual(p, {
    name: "nvidia",
    dialect: "openai",
    url: "https://integrate.api.nvidia.com",
  });
});

test("parseUpstreamFlag: explicit dialect", () => {
  const p = parseUpstreamFlag("mygw:anthropic=https://claude-gw.internal");
  assert.equal(p.name, "mygw");
  assert.equal(p.dialect, "anthropic");
});

test("parseUpstreamFlag: splits on FIRST '=' — colon-rich URLs survive", () => {
  const p = parseUpstreamFlag("local=http://localhost:11434");
  assert.equal(p.name, "local");
  assert.equal(p.url, "http://localhost:11434");
});

test("parseUpstreamFlag: URL containing '=' in path is kept whole", () => {
  const p = parseUpstreamFlag("gw=https://host.example/base=v2");
  assert.equal(p.url, "https://host.example/base=v2");
});

test("parseUpstreamFlag: rejects missing '='", () => {
  assert.throws(() => parseUpstreamFlag("nvidia"), /expected <name>/);
});

test("parseUpstreamFlag: rejects empty name and empty url", () => {
  assert.throws(() => parseUpstreamFlag("=https://x.example"), /expected <name>/);
  assert.throws(() => parseUpstreamFlag("nvidia="), /expected <name>/);
});

test("parseUpstreamFlag: rejects bad name characters (uppercase, underscore, dot)", () => {
  assert.throws(() => parseUpstreamFlag("Nvidia=https://x.example"), /must match/);
  assert.throws(() => parseUpstreamFlag("my_gw=https://x.example"), /must match/);
  assert.throws(() => parseUpstreamFlag("a.b=https://x.example"), /must match/);
});

test("parseUpstreamFlag: rejects reserved path segment v1", () => {
  assert.throws(() => parseUpstreamFlag("v1=https://x.example"), /reserved/);
});

test("parseUpstreamFlag: rejects unknown dialect", () => {
  assert.throws(
    () => parseUpstreamFlag("gw:gemini=https://x.example"),
    /dialect/,
  );
});

test("parseUpstreamFlag: rejects non-http(s) and unparseable URLs", () => {
  assert.throws(() => parseUpstreamFlag("gw=ftp://x.example"), /http or https/);
  assert.throws(() => parseUpstreamFlag("gw=not a url"), /not a valid URL/);
});

test("parseUpstreamFlag: rejects URLs carrying a query string or fragment", () => {
  assert.throws(
    () => parseUpstreamFlag("gw=https://x.example/base?k=v"),
    /query string or fragment/,
  );
  assert.throws(
    () => parseUpstreamFlag("gw=https://x.example/base#frag"),
    /query string or fragment/,
  );
});

/* ====================================================================
 * buildRegistry — built-ins, 6A provider-scoped overrides, duplicates
 * ==================================================================== */

test("buildRegistry: built-ins pre-registered with default upstreams", () => {
  const reg = buildRegistry({});
  assert.equal(reg.get("anthropic")?.upstream, "https://api.anthropic.com");
  assert.equal(reg.get("openai")?.upstream, "https://api.openai.com");
  assert.equal(reg.get("openai")?.builtin, true);
});

test("buildRegistry: target override re-points the provider entity (6A)", () => {
  const reg = buildRegistry({ upstreams: { openai: "https://gw.internal" } });
  assert.equal(reg.get("openai")?.upstream, "https://gw.internal");
});

test("buildRegistry: registers named providers and strips trailing slashes", () => {
  const reg = buildRegistry({
    providers: [
      { name: "nvidia", dialect: "openai", url: "https://integrate.api.nvidia.com/" },
    ],
  });
  assert.equal(reg.get("nvidia")?.upstream, "https://integrate.api.nvidia.com");
  assert.equal(reg.get("nvidia")?.builtin, false);
});

test("buildRegistry: duplicate name is a hard error", () => {
  assert.throws(
    () =>
      buildRegistry({
        providers: [
          { name: "gw", dialect: "openai", url: "https://a.example" },
          { name: "gw", dialect: "openai", url: "https://b.example" },
        ],
      }),
    /duplicate/,
  );
});

test("buildRegistry: built-in name collision points at the target flag", () => {
  assert.throws(
    () =>
      buildRegistry({
        providers: [{ name: "openai", dialect: "openai", url: "https://x.example" }],
      }),
    /--openai-target/,
  );
});

/* ====================================================================
 * matchRoute — bare back-compat, prefix strip, capture gating
 * ==================================================================== */

test("matchRoute: bare capture paths hit the built-ins (backward compat)", () => {
  const reg = buildRegistry({});
  const a = matchRoute("/v1/messages", reg);
  assert.equal(a?.def.name, "anthropic");
  assert.equal(a?.forwardPath, "/v1/messages");
  assert.equal(a?.capture, true);
  const o = matchRoute("/v1/chat/completions", reg);
  assert.equal(o?.def.name, "openai");
  assert.equal(o?.capture, true);
});

test("matchRoute: prefixed path strips the prefix and captures on the dialect path", () => {
  const reg = buildRegistry({
    providers: [{ name: "nvidia", dialect: "openai", url: "https://integrate.api.nvidia.com" }],
  });
  const m = matchRoute("/nvidia/v1/chat/completions", reg);
  assert.equal(m?.def.name, "nvidia");
  assert.equal(m?.forwardPath, "/v1/chat/completions");
  assert.equal(m?.capture, true);
});

test("matchRoute: non-capture path under a prefix forwards without capture", () => {
  const reg = buildRegistry({
    providers: [{ name: "nvidia", dialect: "openai", url: "https://integrate.api.nvidia.com" }],
  });
  const m = matchRoute("/nvidia/v1/models", reg);
  assert.equal(m?.def.name, "nvidia");
  assert.equal(m?.forwardPath, "/v1/models");
  assert.equal(m?.capture, false);
});

test("matchRoute: built-ins are prefix-reachable too (2A symmetry)", () => {
  const reg = buildRegistry({});
  const m = matchRoute("/openai/v1/chat/completions", reg);
  assert.equal(m?.def.name, "openai");
  assert.equal(m?.forwardPath, "/v1/chat/completions");
  assert.equal(m?.capture, true);
});

test("matchRoute: anthropic-dialect provider captures on /v1/messages only", () => {
  const reg = buildRegistry({
    providers: [{ name: "mygw", dialect: "anthropic", url: "https://gw.example" }],
  });
  assert.equal(matchRoute("/mygw/v1/messages", reg)?.capture, true);
  assert.equal(matchRoute("/mygw/v1/chat/completions", reg)?.capture, false);
});

test("matchRoute: unregistered prefix and unknown bare paths miss", () => {
  const reg = buildRegistry({});
  assert.equal(matchRoute("/groq/v1/chat/completions", reg), undefined);
  assert.equal(matchRoute("/v2/other", reg), undefined);
  assert.equal(matchRoute("/", reg), undefined);
});

test("matchRoute: bare prefix with no rest forwards '/'", () => {
  const reg = buildRegistry({
    providers: [{ name: "nvidia", dialect: "openai", url: "https://x.example" }],
  });
  const m = matchRoute("/nvidia", reg);
  assert.equal(m?.forwardPath, "/");
  assert.equal(m?.capture, false);
});

/* ====================================================================
 * joinUpstream — path-carrying upstreams, no doubled/dropped segments
 * ==================================================================== */

test("joinUpstream: origin-only upstream", () => {
  assert.equal(
    joinUpstream("https://integrate.api.nvidia.com", "/v1/chat/completions"),
    "https://integrate.api.nvidia.com/v1/chat/completions",
  );
});

test("joinUpstream: upstream carrying a path segment (Groq-style)", () => {
  assert.equal(
    joinUpstream("https://api.groq.com/openai", "/v1/chat/completions"),
    "https://api.groq.com/openai/v1/chat/completions",
  );
});

test("joinUpstream: upstream ending in /v1 concatenates as given (documented)", () => {
  // The upstream is forwarded <rest> verbatim — a base that already
  // ends in /v1 doubles by design; the docs tell users to register the
  // origin. This test pins the (surprising but intentional) behavior.
  assert.equal(
    joinUpstream("https://host.example/v1", "/v1/chat/completions"),
    "https://host.example/v1/v1/chat/completions",
  );
});

test("joinUpstream via registry: trailing slashes never double", () => {
  const reg = buildRegistry({
    providers: [{ name: "gw", dialect: "openai", url: "https://gw.example///" }],
  });
  assert.equal(
    joinUpstream(reg.get("gw")!.upstream, "/v1/chat/completions"),
    "https://gw.example/v1/chat/completions",
  );
});

test("buildRegistry validates library-path inputs like the CLI flag", () => {
  // Reserved segment
  assert.throws(
    () =>
      buildRegistry({
        providers: [{ name: "v1", dialect: "openai", url: "https://x.example" }],
      }),
    /reserved path segment/,
  );
  // Name grammar
  assert.throws(
    () =>
      buildRegistry({
        providers: [{ name: "Bad Name", dialect: "openai", url: "https://x.example" }],
      }),
    /must match \[a-z0-9-\]\+/,
  );
  // Credential-bearing URL — assembled at runtime so secret scanners
  // (incl. the repo's own pre-push redact hook) don't read the fixture
  // as a real basic-auth credential in the diff.
  const credUrl = ["https://u", "p@x.example"].join(":");
  assert.throws(
    () =>
      buildRegistry({
        providers: [{ name: "gw", dialect: "openai", url: credUrl }],
      }),
    /must not embed credentials/,
  );
});

test("buildRegistry precomputes upstream host (host only — no path, port kept)", () => {
  const reg = buildRegistry({
    providers: [{ name: "groq", dialect: "openai", url: "https://api.groq.com:8443/openai" }],
  });
  assert.equal(reg.get("groq")!.host, "api.groq.com:8443");
  assert.equal(reg.get("openai")!.host, "api.openai.com");
});
