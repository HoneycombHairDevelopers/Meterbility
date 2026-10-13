/**
 * Redact a real Codex CLI rollout into a corpus fixture.
 *
 *   node --import tsx/esm scripts/redact-codex-rollout.ts \
 *     <in.jsonl> <out.jsonl> [--home <dir>] [--email <addr>] [--scrub <token>]...
 *
 * Mirrors `scripts/redact-claude-code-transcript.ts`: every record and
 * every key is kept (the shape probe needs them); only VALUES change.
 *
 *   - the home directory becomes `/Users/dev`, the bare username `dev`
 *     (it also leaks through dash-encoded project dirs), the email
 *     `user@example.com`;
 *   - strings that do not drive file-change derivation are capped at
 *     MAX_STRING chars (base_instructions, user/assistant text,
 *     reasoning);
 *   - kept whole: `custom_tool_call.input` / `function_call.arguments`
 *     (the patch), `*_output.output` (exit code + wall time), and the
 *     `FileChange` item / `patch_apply_end` `changes` map + `stdout`
 *     (adds carry full content, updates carry the unified diff).
 *
 * The output is still the user's own session content (file bodies the
 * agent wrote). Review it before committing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const MAX_STRING = 400;

interface Options {
  home: string;
  email: string | undefined;
  scrub: string[];
}

function parseArgs(argv: string[]): { input: string; output: string; opts: Options } {
  const positional: string[] = [];
  const opts: Options = { home: homedir(), email: undefined, scrub: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--home") opts.home = argv[++i]!;
    else if (a === "--email") opts.email = argv[++i]!;
    else if (a === "--scrub") opts.scrub.push(argv[++i]!);
    else positional.push(a);
  }
  if (positional.length !== 2) {
    console.error(
      "usage: redact-codex-rollout.ts <in.jsonl> <out.jsonl> [--home <dir>] [--email <addr>] [--scrub <token>]...",
    );
    process.exit(2);
  }
  return { input: positional[0]!, output: positional[1]!, opts };
}

function redactString(s: string, opts: Options, keepWhole: boolean): string {
  let out = s.split(opts.home).join("/Users/dev");
  const user = opts.home.split("/").filter(Boolean).pop();
  if (user && user.length >= 4) out = out.split(user).join("dev");
  if (opts.email) out = out.split(opts.email).join("user@example.com");
  for (const token of opts.scrub) out = out.split(token).join("dev");
  if (!keepWhole && out.length > MAX_STRING) {
    out = `${out.slice(0, MAX_STRING)}…[redacted ${out.length - MAX_STRING} chars]`;
  }
  return out;
}

/** Keys whose subtree carries file-change material and must stay whole. */
const KEEP_WHOLE_KEYS: Record<string, ReadonlySet<string>> = {
  custom_tool_call: new Set(["input"]),
  function_call: new Set(["arguments"]),
  custom_tool_call_output: new Set(["output"]),
  function_call_output: new Set(["output"]),
  FileChange: new Set(["changes", "stdout"]),
  patch_apply_end: new Set(["changes", "stdout", "stderr"]),
};

function walk(value: unknown, opts: Options, keepWhole: boolean): unknown {
  if (typeof value === "string") return redactString(value, opts, keepWhole);
  if (Array.isArray(value)) return value.map((v) => walk(v, opts, keepWhole));
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const whole =
      typeof obj.type === "string" ? KEEP_WHOLE_KEYS[obj.type] : undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // Map keys are absolute paths (the `changes` map) — redact them too.
      const key = redactString(k, opts, true);
      out[key] = walk(v, opts, keepWhole || (whole?.has(k) ?? false));
    }
    return out;
  }
  return value;
}

const { input, output, opts } = parseArgs(process.argv.slice(2));
const outLines: string[] = [];
let dropped = 0;
for (const line of readFileSync(input, "utf-8").split("\n")) {
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
  outLines.push(JSON.stringify(walk(record, opts, false)));
}
writeFileSync(output, outLines.join("\n") + "\n");
console.log(
  `wrote ${outLines.length} records to ${output} (dropped ${dropped}; ${Buffer.byteLength(outLines.join("\n"))} bytes)`,
);
