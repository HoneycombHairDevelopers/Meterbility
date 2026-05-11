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
