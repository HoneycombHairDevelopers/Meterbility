/**
 * Redact a real Claude Code session transcript into a corpus fixture.
 *
 *   node --import tsx/esm scripts/redact-claude-code-transcript.ts \
 *     <in.jsonl> <out.jsonl> [--home <dir>] [--email <addr>] [--scrub <token>]... [--keep-attachments <n>]
 *
 * Why a script and not a hand-built fixture: every adapter drift we have
 * hit so far (file-history-snapshot rewrite, file-history-delta, the
 * other adapters' envelope mismatches) was invisible to tests because the
 * fixtures were written from the code's idea of the format. A corpus
 * file is the real thing, so `corpus.test.ts` fails the day the shape
 * moves. The redaction keeps every record and every key (the shape
 * probe needs them) and only touches VALUES:
 *
 *   - the home directory becomes `/Users/dev`, the email `user@example.com`;
 *   - account / organization uuids are zeroed;
 *   - strings that do not drive file-change derivation are capped at
 *     MAX_STRING chars (system prompts, thinking, model text, tool output);
 *     tool_use `input` and the `toolUseResult` payload are kept whole
 *     because the adapter reconstructs before/after images from them;
 *   - `attachment` records (system-prompt dumps) are kept only up to
 *     `--keep-attachments` (default 3) — enough to pin their shape.
 *
 * The output is still the user's own session content (file bodies the
 * agent wrote). Review it before committing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const MAX_STRING = 400;
const KEEP_WHOLE_TOP_KEYS = new Set(["toolUseResult"]);
const ZERO_UUID_KEYS = new Set([
  "ownerAccountUuid",
  "ownerOrganizationUuid",
  "accountUuid",
  "organizationUuid",
]);

interface Options {
  home: string;
  email: string | undefined;
  /** Extra literal tokens (a GitHub handle, a hostname) replaced with "dev". */
  scrub: string[];
  keepAttachments: number;
}

function parseArgs(argv: string[]): { input: string; output: string; opts: Options } {
  const positional: string[] = [];
  const opts: Options = {
    home: homedir(),
    email: undefined,
    scrub: [],
    keepAttachments: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--home") opts.home = argv[++i]!;
    else if (a === "--email") opts.email = argv[++i]!;
    else if (a === "--scrub") opts.scrub.push(argv[++i]!);
    else if (a === "--keep-attachments") opts.keepAttachments = Number(argv[++i]);
    else positional.push(a);
  }
  if (positional.length !== 2) {
    console.error(
      "usage: redact-claude-code-transcript.ts <in.jsonl> <out.jsonl> [--home <dir>] [--email <addr>] [--scrub <token>]... [--keep-attachments <n>]",
    );
    process.exit(2);
  }
  return { input: positional[0]!, output: positional[1]!, opts };
}

function redactString(s: string, opts: Options, keepWhole: boolean): string {
  let out = s.split(opts.home).join("/Users/dev");
  // The bare username leaks through `ls -l` output, dash-encoded project
  // dirs (`-Users-<name>-…`) and the like; scrub it wherever it appears.
  const user = opts.home.split("/").filter(Boolean).pop();
  if (user && user.length >= 4) out = out.split(user).join("dev");
  if (opts.email) out = out.split(opts.email).join("user@example.com");
  for (const token of opts.scrub) out = out.split(token).join("dev");
  if (!keepWhole && out.length > MAX_STRING) {
    out = `${out.slice(0, MAX_STRING)}…[redacted ${out.length - MAX_STRING} chars]`;
  }
  return out;
}

/**
 * `keepWhole` turns on under a tool_use block's `input` and under the
 * record's top-level `toolUseResult`: those carry the file bodies and
 * old/new strings the adapter derives rows from.
 */
function walk(value: unknown, opts: Options, keepWhole: boolean, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && ZERO_UUID_KEYS.has(key)) {
      return "00000000-0000-0000-0000-000000000000";
    }
    return redactString(value, opts, keepWhole);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, opts, keepWhole));
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const isToolUse = obj.type === "tool_use";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const whole = keepWhole || (isToolUse && k === "input");
      out[k] = walk(v, opts, whole, k);
    }
    return out;
  }
  return value;
}

function redactRecord(record: Record<string, unknown>, opts: Options): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = walk(v, opts, KEEP_WHOLE_TOP_KEYS.has(k), k);
  }
  return out;
}

const { input, output, opts } = parseArgs(process.argv.slice(2));
const lines = readFileSync(input, "utf-8").split("\n");
const outLines: string[] = [];
let attachments = 0;
let dropped = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    dropped += 1;
    continue;
  }
  if (typeof record !== "object" || record === null) {
    dropped += 1;
    continue;
  }
  const rec = record as Record<string, unknown>;
  if (rec.type === "attachment") {
    attachments += 1;
    if (attachments > opts.keepAttachments) {
      dropped += 1;
      continue;
    }
  }
  outLines.push(JSON.stringify(redactRecord(rec, opts)));
}
writeFileSync(output, outLines.join("\n") + "\n");
console.log(
  `wrote ${outLines.length} records to ${output} (dropped ${dropped}; ${Buffer.byteLength(outLines.join("\n"))} bytes)`,
);
