/**
 * Conservative redaction pass applied before any blob is persisted.
 *
 * v0 is regex-only — explicit, auditable, predictable. Each rule replaces
 * matches in-place with a tagged placeholder so the redaction is visible
 * in the stored bytes. Disable globally via SPOOL_REDACT=off, or extend
 * via $SPOOL_HOME/redact.json (future).
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: (match: string) => string;
}

const PLACEHOLDER = (name: string) => `«spool:redacted:${name}»`;

export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "anthropic-key",
    pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    replacement: () => PLACEHOLDER("anthropic-key"),
  },
  {
    name: "openai-key",
    pattern: /sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g,
    replacement: () => PLACEHOLDER("openai-key"),
  },
  {
    name: "github-token",
    pattern: /gh[pous]_[A-Za-z0-9]{36,}/g,
    replacement: () => PLACEHOLDER("github-token"),
  },
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: () => PLACEHOLDER("aws-access-key"),
  },
  {
    name: "bearer",
    pattern: /Bearer\s+[A-Za-z0-9_\-.=]{20,}/g,
    replacement: () => PLACEHOLDER("bearer"),
  },
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
    replacement: () => PLACEHOLDER("private-key"),
  },
  // ── v0.3 extensions (SPEC-V0_3 §10.1) ─────────────────────────────
  //
  // slack-token: matches both bot/user OAuth tokens (`xoxb-`, `xoxp-`,
  // `xoxa-`, `xoxr-`, `xoxs-`) and incoming-webhook URLs. Both leak
  // freely into shell scripts and CI logs.
  {
    name: "slack-token",
    pattern:
      /(?:xox[baprs]-[A-Za-z0-9-]{10,}|https?:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/g,
    replacement: () => PLACEHOLDER("slack-token"),
  },
  // jwt: three base64url segments. Header + payload always start with
  // `eyJ` because they decode to JSON starting with `{`. Catches OAuth
  // IDPs, Supabase, Vercel, and effectively every JWT in the wild.
  // Note: `Bearer eyJ...` is consumed by the bearer rule above first;
  // this rule catches naked JWTs (cookies, query strings, etc.).
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: () => PLACEHOLDER("jwt"),
  },
  // stripe-live-key: secret (`sk_live_`), restricted (`rk_live_`), and
  // publishable (`pk_live_`) live keys. The `_live_` infix is the
  // marker — `_test_` keys are not redacted by default (lower severity,
  // commonly checked into fixtures). 24+ char tail allows the modern
  // expanded format up to ~107 chars.
  {
    name: "stripe-live-key",
    pattern: /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{24,}/g,
    replacement: () => PLACEHOLDER("stripe-live-key"),
  },
  // env-secret: catches `KEY=value` lines where the KEY contains one of
  // the canonical secret-name tokens (SECRET, TOKEN, PASSWORD, API_KEY,
  // CREDENTIAL, PRIVATE_KEY, ACCESS_KEY, AUTH_TOKEN). Keep this LAST in
  // the rule list so more-specific shape rules (slack-token, jwt,
  // anthropic-key, etc.) get to claim their value first — the slack
  // rule produces a more informative placeholder than `env-secret`.
  // Requires the value to be 8+ chars of `[A-Za-z0-9+/=_\-.:]` so it
  // won't false-positive on short config values like `LOG_LEVEL=INFO`.
  // Cross-lang note: avoids variable-length lookbehind (Python's `re`
  // module doesn't support it) — the whole `KEY=value` is consumed and
  // the KEY name is lost. Tradeoff: simpler, but harder to debug which
  // var leaked. Acceptable per SPEC-V0_3 §10.1 ("conservative, visible").
  {
    name: "env-secret",
    pattern:
      /\b(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|API[_-]?TOKEN|AUTH_?TOKEN|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SECRET_?KEY)\b\s*=\s*["']?[A-Za-z0-9+/=_\-.:]{8,}["']?/g,
    replacement: () => PLACEHOLDER("env-secret"),
  },
];

export interface RedactionResult {
  text: string;
  redactions: Array<{ rule: string; count: number }>;
}

export function redactString(
  input: string,
  rules: RedactionRule[] = DEFAULT_RULES,
): RedactionResult {
  if (process.env.SPOOL_REDACT === "off") {
    return { text: input, redactions: [] };
  }
  let out = input;
  const counts: Record<string, number> = {};
  for (const rule of rules) {
    out = out.replace(rule.pattern, (m) => {
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      return rule.replacement(m);
    });
  }
  return {
    text: out,
    redactions: Object.entries(counts).map(([rule, count]) => ({ rule, count })),
  };
}

export function redactBuffer(
  buf: Buffer,
  rules?: RedactionRule[],
): { buffer: Buffer; redactions: Array<{ rule: string; count: number }> } {
  const text = buf.toString("utf-8");
  const result = redactString(text, rules);
  return { buffer: Buffer.from(result.text, "utf-8"), redactions: result.redactions };
}
