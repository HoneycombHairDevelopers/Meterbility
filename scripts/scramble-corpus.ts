/**
 * Scramble a corpus capture: keep every SHAPE, replace every piece of
 * CONTENT with synthetic text.
 *
 *   node --import tsx/esm scripts/scramble-corpus.ts <file> [<file>...] [--salt <s>] [--report]
 *
 * Rewrites each file in place. Works on JSONL (one record per line),
 * JSON (one document) and plain text / YAML (treated as one string).
 *
 * Why: the corpus tests need REAL record envelopes from the vendors'
 * formats so drift fails the build, but the captures come from the
 * repo owner's own sessions and the repo is public. The scramble keeps
 * what the adapters key on and throws away what a reader could learn:
 *
 *   kept   — object keys that aren't paths; discriminator-like values
 *            (single tokens without whitespace: "assistant",
 *            "tool.execution_start", "apply_patch"); any token with a
 *            digit (uuids, hashes, timestamps, versions, line numbers);
 *            diff syntax words; punctuation, whitespace and newlines;
 *            path structure (directory depth, extensions, well-known
 *            dir names such as src/ or node_modules/).
 *   mapped — every other word, through ONE deterministic, length-
 *            preserving, case-pattern-preserving word map. Because the
 *            map is global, an Edit's old_string still matches the
 *            scrambled file body, a diff hunk still applies to the
 *            scrambled before-image, and a path segment in a tool input
 *            still equals the same segment in a snapshot key. Line and
 *            byte counts are unchanged, so pinned rows survive except
 *            for the path names, which get re-pinned.
 *
 * Inside "content" keys (tool inputs, tool results, file bodies, diffs,
 * messages, prompts) even single tokens are mapped, so a one-word
 * old_string or a short title doesn't leak. Outside them, a single token
 * without whitespace is treated as a discriminator and kept.
 *
 * `--report` prints, per file, the alphabetic tokens (4+ letters) that
 * survived unmapped outside the known keep-lists — review that list by
 * hand before committing.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Keys whose values are content (file bodies, prompts, outputs). Leaf
 * keys only — envelopes such as `arguments`, `params`, `result`,
 * `payload` or `toolUseResult` stay structural so the schema keys inside
 * them survive; their content-bearing leaves are listed here.
 */
const CONTENT_KEYS = new Set([
  "content", "contents", "text", "thinking", "input", "changes", "edits",
  "stdout", "stderr", "output", "command", "cmd", "file_text", "old_str",
  "new_str", "old_string", "new_string", "originalFile", "oldString",
  "newString", "detailedContent", "diffString", "unified_diff",
  "systemPrompt", "customTitle", "lastPrompt", "agentName", "title",
  "summary", "description", "prompt", "codeBlocks", "streamingContent",
  "originalFileStates", "richText", "codeBlockData", "rendered",
  "structuredPatch", "lines", "patch", "diff", "snippet", "body",
  "displayText", "possiblePaths", "agentDisplayName", "displayName",
  "pattern", "query", "glob", "regex", "label", "notes",
  // Slug ids (`implement-navigation-logic` in a todo list) are words;
  // uuid / prefixed ids under the same key survive via `mapToken`.
  "id",
  // Git branch names are project vocabulary too.
  "branch", "branchName", "committedToBranch", "gitBranch", "git_branch",
]);

/**
 * Keys whose WHOLE subtree is content: nothing under them is a
 * discriminator any adapter reads, and their single-token values (tool
 * and connector names in a system-prompt attachment, tag lists) say
 * something about the owner's setup.
 */
const DEEP_CONTENT_KEYS = new Set([
  "attachment", "systemPrompt", "tools", "mcpServers", "mcp_servers",
  "tags", "capabilities", "skills", "plugins",
]);

/** Extensions that say nothing beyond the language; others get mapped. */
const EXT_KEEP = new Set([
  "js", "mjs", "cjs", "ts", "mts", "tsx", "jsx", "json", "jsonl", "md", "txt",
  "yaml", "yml", "toml", "sql", "py", "sh", "css", "html", "lock", "xml",
  "svg", "png", "jpg", "gif", "map", "log", "env", "d",
]);

/** Directory / file names that say nothing about the project. */
const PATH_KEEP = new Set([
  "", "Users", "dev", "private", "tmp", "var", "usr", "bin", "lib", "etc",
  "home", "development", "src", "test", "tests", "spec", "dist", "build",
  "node_modules", "scripts", "docs", "doc", "fixtures", "public", "assets",
  "config", "index", "main", "app", "api", "cli", "README", "LICENSE",
  "CHANGELOG", "package", "package-lock", "tsconfig", ".git", ".claude",
  ".codex", ".copilot", ".cursor", ".vscode", "Library", "Application Support",
  "file:", "https:", "http:", "a", "b",
]);

/** Diff syntax and a few structural words that parsers key on. */
const WORD_KEEP = new Set([
  "diff", "git", "index", "new", "deleted", "file", "mode", "No", "newline",
  "at", "end", "of", "a", "b", "dev", "null", "true", "false", "undefined",
  "Binary", "files", "differ", "similarity", "rename", "from", "to", "copy",
  "old", "Users",
  // Codex V4A patch markers (`*** Begin Patch`, `*** Add File:`, ...).
  "Begin", "End", "Patch", "Add", "Update", "Delete", "File", "Move",
]);
// Prose and path rules must agree on every word they both see, or an
// Edit's old_string (prose) stops matching a snapshot key (path). So
// whatever the path rule keeps, the prose rule keeps too.
for (const w of PATH_KEEP) if (/^[A-Za-z]+$/.test(w)) WORD_KEEP.add(w);
for (const w of EXT_KEEP) WORD_KEEP.add(w);

const EXTENSION_KEEP = /\.[A-Za-z0-9]{1,8}$/;

let salt = "meterbility-corpus";
let report = false;
const files: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--salt") salt = argv[++i]!;
  else if (a === "--report") report = true;
  else files.push(a);
}
if (files.length === 0) {
  console.error("usage: scramble-corpus.ts <file> [<file>...] [--salt <s>] [--report]");
  process.exit(2);
}

const CONSONANTS = "bcdfghjklmnprstvwxz";
const VOWELS = "aeiou";
const wordMap = new Map<string, string>();
const survivors = new Map<string, Set<string>>();
let currentFile = "";

/** Deterministic, length-preserving pseudo-word with the same case pattern. */
function mapWord(word: string): string {
  const lower = word.toLowerCase();
  let base = wordMap.get(lower);
  if (base === undefined) {
    const digest = createHash("sha256").update(`${salt}:${lower}`).digest();
    let out = "";
    for (let i = 0; i < lower.length; i++) {
      const byte = digest[i % digest.length]! ^ (i >> 5);
      out += i % 2 === 0
        ? CONSONANTS[byte % CONSONANTS.length]!
        : VOWELS[byte % VOWELS.length]!;
    }
    base = out;
    wordMap.set(lower, base);
  }
  if (word === word.toUpperCase() && word.length > 1) return base.toUpperCase();
  if (word[0] === word[0]!.toUpperCase()) return base[0]!.toUpperCase() + base.slice(1);
  return base;
}

const TOKEN = /[A-Za-z][A-Za-z0-9_]*|[0-9][A-Za-z0-9_]*/g;

function hasDigit(token: string): boolean {
  return /[0-9]/.test(token);
}

/**
 * All-hex runs of 4+ letters are uuid / hash groups (`bfea`, `deadbeef`)
 * and must stay, or an id mentioned in prose stops matching the same id
 * kept whole as a value. The price is that a few hex-only English words
 * ("face", "cafe") survive unmapped.
 */
function isHexId(token: string): boolean {
  return token.length >= 4 && /^[a-f]+$/i.test(token);
}

/**
 * Map one token the same way everywhere (prose, path segment, name part):
 *   - kept: diff/keyword allow-list, pure digits, hex (ids, hashes),
 *     long alphanumeric ids (`01QEfWbcbnTcBvvfEWX6QF1e`), short
 *     digit-bearing tags (`v1`, `es2022`);
 *   - `_`-joined tokens map part by part;
 *   - a word riding on a digit-bearing token (`Widget20k`) is still a
 *     word: alphabetic runs of 3+ letters inside it are mapped.
 */
function mapToken(token: string): string {
  if (WORD_KEEP.has(token) || isHexId(token) || /^[0-9]+$/.test(token)) return token;
  // Prefixed opaque ids (`toolu_01QEf…`, `msg_011Cf…`, `call_KIJf…`): kept
  // whole so a reference held as a bare value still matches.
  if (/^[a-z]{1,8}_[0-9A-Za-z]{8,}$/.test(token)) return token;
  if (token.includes("_")) {
    return token.split("_").map((part) => (part ? mapToken(part) : part)).join("_");
  }
  if (hasDigit(token)) {
    if (/^[0-9a-f]+$/i.test(token)) return token;
    if (/^[0-9A-Za-z]+$/.test(token) && token.length >= 16) return token;
    return token.replace(/[A-Za-z]{3,}/g, (run) => (WORD_KEEP.has(run) ? run : mapWord(run)));
  }
  return mapWord(token);
}

/** Map every word in free text; punctuation, whitespace and newlines stay. */
function scrambleText(text: string): string {
  return text.replace(TOKEN, (token) => mapToken(token));
}

function looksLikePath(s: string): boolean {
  return (
    s.includes("/") && !/[\s"{}\\]/.test(s) && s.length < 512
  );
}

/** Map a dotted/dashed name part by part; a known extension is kept. */
function scrambleName(name: string): string {
  const ext = EXTENSION_KEEP.exec(name);
  let stem = ext ? name.slice(0, ext.index) : name;
  let tail = ext ? ext[0] : "";
  if (stem === "") {
    // Dot-directory / dotfile (`.squad`, `.envrc`): the "extension" IS the name.
    stem = name;
    tail = "";
  } else if (tail && !EXT_KEEP.has(tail.slice(1).toLowerCase()) && !hasDigit(tail)) {
    tail = "." + mapWord(tail.slice(1));
  }
  if (PATH_KEEP.has(stem)) return stem + tail;
  // Same word boundaries as the prose tokenizer, same per-token rule.
  return (
    stem
      .split(/([.-])/)
      .map((part) => (part === "." || part === "-" || part === "" ? part : mapToken(part)))
      .join("") + tail
  );
}

/** Keep structure and well-known names; map the other segments. */
function scramblePath(s: string): string {
  return s
    .split("/")
    .map((segment) => {
      if (PATH_KEEP.has(segment) || segment.includes(":")) return segment;
      if (hasDigit(segment)) {
        // Id-like segment (uuid, hash, timestamp): `mapToken` keeps the id
        // parts and still maps a word riding along (`20260519000000_addindex`).
        return segment
          .split(/([.-])/)
          .map((part) => (part === "." || part === "-" || part === "" ? part : mapToken(part)))
          .join("");
      }
      return scrambleName(segment);
    })
    .join("/");
}

/**
 * Some formats nest JSON inside strings (Codex `function_call.arguments`,
 * Cursor KV values). Scramble those as structure, not as prose, so their
 * keys survive and only their values are mapped.
 */
function embeddedJson(s: string): unknown | undefined {
  const t = s.trimStart();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function scrambleString(s: string, inContent: boolean): string {
  if (s.length === 0) return s;
  // Paths first, wherever they appear: a tool input's file_path must map
  // exactly like the session cwd and the snapshot keys.
  if (looksLikePath(s)) return scramblePath(s);
  if (inContent) {
    // A file body that happens to be JSON (package.json) is content
    // through and through — keys included.
    return scrambleText(s);
  }
  const nested = embeddedJson(s);
  if (nested !== undefined) return JSON.stringify(walk(nested, false));
  // Discriminators look like `assistant`, `tool.execution_start`,
  // `claude-fable-5-1`: one token of word characters, dots, dashes,
  // colons. Anything with other punctuation (`a|b`, quotes, braces) is
  // prose in disguise.
  // Long enough for compound ids (`bubbleId:<uuid>:<uuid>` is 82 chars).
  const singleToken = /^[A-Za-z0-9_.:\-@]{1,200}$/.test(s);
  if (singleToken) {
    // Discriminator-like value ("assistant", "tool.execution_start").
    noteSurvivors(s);
    return s;
  }
  // Prose, or a JSON-ish blob that no longer parses (truncated by a
  // capture-time cap): map word by word.
  return scrambleText(s);
}

function noteSurvivors(s: string): void {
  if (!report) return;
  for (const token of s.match(/[A-Za-z]{4,}/g) ?? []) {
    if (WORD_KEEP.has(token) || PATH_KEEP.has(token)) continue;
    let set = survivors.get(currentFile);
    if (!set) survivors.set(currentFile, (set = new Set()));
    set.add(token);
  }
}

/**
 * `inContent` is a LEAF property: a content key marks the string (or the
 * strings in the array) directly under it, never a nested object. A
 * message's `content` array holds structured blocks whose `name` and
 * `type` the adapters key on; a Codex `changes` map holds objects whose
 * `type: "add"` must survive. Their content-bearing leaves (`text`,
 * `content`, `unified_diff`, ...) are content keys in their own right.
 */
function walk(value: unknown, inContent: boolean, deep = false): unknown {
  if (typeof value === "string") return scrambleString(value, inContent || deep);
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === "string" ? scrambleString(v, inContent || deep) : walk(v, deep, deep),
    );
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Schema keys never contain "/". A key that does is a path (snapshot
      // maps, Codex `changes`) or a JSON-ish blob used as a map key
      // (Cursor `selections`) — content either way.
      const key = !k.includes("/") ? k : looksLikePath(k) ? scramblePath(k) : scrambleText(k);
      const deeper = deep || DEEP_CONTENT_KEYS.has(k);
      out[key] = walk(v, CONTENT_KEYS.has(k) || deeper, deeper);
    }
    return out;
  }
  return value;
}

for (const file of files) {
  currentFile = file;
  const raw = readFileSync(file, "utf-8");
  let out: string;
  if (file.endsWith(".jsonl")) {
    out =
      raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.stringify(walk(JSON.parse(line), false)))
        .join("\n") + "\n";
  } else if (file.endsWith(".json")) {
    out = JSON.stringify(walk(JSON.parse(raw), false), null, 2) + "\n";
  } else {
    // Plain text / YAML sidecars: paths and free text, line by line.
    out = raw
      .split("\n")
      .map((line) =>
        line.replace(/\S+/g, (tok) => (looksLikePath(tok) ? scramblePath(tok) : scrambleText(tok))),
      )
      .join("\n");
  }
  writeFileSync(file, out);
  console.log(`scrambled ${file} (${wordMap.size} distinct words mapped so far)`);
}

if (report) {
  for (const [file, set] of survivors) {
    console.log(`\n# unmapped single-token values in ${file} (${set.size}):`);
    console.log([...set].sort().join(" "));
  }
}
