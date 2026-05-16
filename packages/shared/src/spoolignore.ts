/**
 * `.spoolignore` matcher — a gitignore-compatible subset.
 *
 * Scope per SPEC v0.3 §10.2: a single pattern matcher that's used by
 * (a) baseline tree capture (this milestone) and (b) the file-watcher
 * daemon (v0.4). The same matcher also reads `.gitignore` files since
 * the two formats are syntactically compatible for the patterns Spool
 * needs to honor.
 *
 * What's supported:
 *   - Comments (lines starting with `#`) and blank lines are skipped.
 *   - Trailing `/` ⇒ matches directories only (e.g. `node_modules/`).
 *   - Leading `/` ⇒ rooted match (e.g. `/.env` matches only at repo root).
 *   - `*` ⇒ matches any chars within one path segment (no `/`).
 *   - `**` ⇒ matches any number of segments (zero or more).
 *   - Plain names (no `/`) match the basename at any depth.
 *
 * What's intentionally NOT supported in v0.3:
 *   - Negation (`!pattern`) — gitignore allows un-ignoring; v0.3 doesn't
 *     need it for either the defaults or the configs we ship.
 *   - `[char-class]` brackets — unused in real-world `.gitignore` files
 *     for the patterns Spool cares about.
 *   - `.gitignore` files in subdirectories (only the root file is read).
 *
 * If a v0.4 user trips on one of these, we'll extend; honest partial
 * over claiming gitignore parity we don't actually provide.
 */

/**
 * Per SPEC §10.2: the defaults Spool ships when no `.spoolignore` is
 * present at the repo root. Covers build artifacts, language caches,
 * VCS internals, editor/OS noise, coverage, and a "sensitive by
 * default" set (env files, keys, credentials).
 *
 * The defaults are an ordered list so users / tests can append their
 * own and still see what was inherited.
 */
export const DEFAULT_SPOOLIGNORE: readonly string[] = [
  // Build artifacts
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "target/",
  ".cache/",
  // Language-specific
  ".venv/",
  "__pycache__/",
  "*.pyc",
  // Version control internals
  ".git/objects/",
  ".git/logs/",
  // Editor / OS
  ".DS_Store",
  ".idea/",
  ".vscode/",
  // Coverage / tooling
  "coverage/",
  ".nyc_output/",
  // Sensitive by default — paired with the redaction rules in §10.1
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "credentials.json",
  ".aws/",
  ".kube/config",
];

interface CompiledPattern {
  /** The original line, preserved for debugging. */
  raw: string;
  /** RegExp matched against the full repo-relative POSIX path. */
  re: RegExp;
  /** True if the pattern only matches directories (trailing `/`). */
  dirOnly: boolean;
  /** True if the pattern was anchored at the repo root (leading `/`). */
  rooted: boolean;
}

export class IgnoreMatcher {
  private patterns: CompiledPattern[] = [];

  /** Defaults-only matcher — the baseline state for any repo. */
  static fromDefaults(): IgnoreMatcher {
    return IgnoreMatcher.fromLines([...DEFAULT_SPOOLIGNORE]);
  }

  /**
   * Build from an explicit list of pattern lines. Blank lines and
   * comments are dropped during compile.
   */
  static fromLines(lines: string[]): IgnoreMatcher {
    const m = new IgnoreMatcher();
    m.add(lines);
    return m;
  }

  /**
   * Defaults + the lines from one or more pattern lists. Used by the
   * baseline walker to stack `.spoolignore` and `.gitignore` on top
   * of the defaults so the dominant common case ("user wrote a custom
   * `.spoolignore`") doesn't accidentally lose the protections in
   * `DEFAULT_SPOOLIGNORE`.
   */
  static fromDefaultsPlus(...extra: Array<string[] | undefined>): IgnoreMatcher {
    const m = IgnoreMatcher.fromDefaults();
    for (const list of extra) {
      if (list) m.add(list);
    }
    return m;
  }

  add(lines: string[]): void {
    for (const raw of lines) {
      const compiled = compile(raw);
      if (compiled) this.patterns.push(compiled);
    }
  }

  /**
   * Test a repo-relative POSIX path. Pass `isDir: true` for directory
   * candidates so `pattern/` rules apply.
   *
   * First match wins — there's no negation in v0.3.
   */
  matches(repoRelativePath: string, isDir: boolean): boolean {
    if (repoRelativePath === "" || repoRelativePath === ".") return false;
    const normalized = repoRelativePath.replace(/\\/g, "/");
    for (const p of this.patterns) {
      if (p.dirOnly && !isDir) continue;
      if (p.re.test(normalized)) return true;
    }
    return false;
  }

  /** For tests + diagnostics — exposes the compiled pattern list. */
  size(): number {
    return this.patterns.length;
  }
}

function compile(raw: string): CompiledPattern | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  let line = trimmed;
  let rooted = false;
  let dirOnly = false;
  if (line.startsWith("/")) {
    rooted = true;
    line = line.slice(1);
  }
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return undefined;
  // If the (post-strip) line contains no slash, gitignore semantics
  // say it matches at any depth. We model that by allowing `(.+/)?` as
  // an optional prefix in the regex unless the user rooted with `/`.
  const containsSlash = line.includes("/");
  const body = globToRegex(line);
  const anchored = rooted || containsSlash;
  // The "must match a directory" subtlety: gitignore treats a rule like
  // `node_modules/` as matching both `node_modules` (when isDir) and
  // anything under it. We handle "under it" by matching `node_modules`
  // OR `node_modules/...anything`. dirOnly applies the gate above.
  const pattern = anchored
    ? `^${body}(?:/.*)?$`
    : `^(?:.+/)?${body}(?:/.*)?$`;
  return { raw: trimmed, re: new RegExp(pattern), dirOnly, rooted };
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      // Handle `**` (match any number of segments). `**/` and `/**` are
      // gitignore patterns; the matcher treats `**` as `.*` after
      // stripping a trailing `/` if present.
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        // Eat an optional trailing slash so `**/foo` becomes `.*foo` not `.*/foo`.
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+().|{}[]".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}
