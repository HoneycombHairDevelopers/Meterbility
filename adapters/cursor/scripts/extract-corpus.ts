/**
 * Extract a redacted real-capture corpus from a Cursor `state.vscdb`.
 *
 *   node --import tsx/esm adapters/cursor/scripts/extract-corpus.ts \
 *     --db ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
 *     --out adapters/cursor/fixtures/corpus/<capture-name> \
 *     --composer <id> [--composer <id> ...] \
 *     [--home /Users/you] [--workspace <wsId>=file:///abs/folder ...]
 *
 * The DB is opened read-only. The output is `capture.json`, loadable by
 * `src/corpus.test.ts`, holding the composerData, composerHeaders,
 * bubbleId rows, checkpoint and fate ledgers, and composer.content
 * blobs for the chosen composers — redacted:
 *
 *   - the home directory → /Users/dev (and the bare user name → dev)
 *   - anything that looks like an email → user@example.com
 *   - encryption-key fields and Lexical richText dropped
 *   - every string capped at 400 chars EXCEPT file-tool params/results
 *     (`search_replace`, `write`, `edit_file_v2`, `delete_file`), the
 *     checkpoint/fate rows, and the content blobs, which the
 *     file-change derivation needs intact
 *   - messageRequestContext / codeBlockDiff rows are not exported
 *
 * Review the output before committing it: it is data from a real
 * session. Anything sensitive in a content blob should be truncated by
 * hand and noted in the capture's `notes`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const FILE_TOOLS = new Set(["search_replace", "write", "edit_file_v2", "delete_file"]);
const CAP = 400;
const DROP_COMPOSER_KEYS = new Set([
  "speculativeSummarizationEncryptionKey",
  "blobEncryptionKey",
  "richText",
  "conversationMap",
]);
const DROP_BUBBLE_KEYS = new Set(["richText"]);

interface Args {
  db: string;
  out: string;
  composers: string[];
  home: string;
  workspaces: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { db: "", out: "", composers: [], home: homedir(), workspaces: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--db") (a.db = v!), (i += 1);
    else if (k === "--out") (a.out = v!), (i += 1);
    else if (k === "--composer") a.composers.push(v!), (i += 1);
    else if (k === "--home") (a.home = v!), (i += 1);
    else if (k === "--workspace") {
      const eq = v!.indexOf("=");
      a.workspaces[v!.slice(0, eq)] = v!.slice(eq + 1);
      i += 1;
    }
  }
  if (!a.db || !a.out || a.composers.length === 0) {
    throw new Error("usage: --db <state.vscdb> --out <dir> --composer <id> [...]");
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const home = args.home.replace(/\/+$/, "");
  const user = home.slice(home.lastIndexOf("/") + 1);
  const redactText = (s: string): string =>
    s
      .split(home)
      .join("/Users/dev")
      .replace(new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(user)}(?=$|[^A-Za-z0-9_])`, "g"), "$1dev")
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "user@example.com");

  const walk = (v: unknown, protectedNode: boolean, drop?: Set<string>): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      return protectedNode || r.length <= CAP ? r : r.slice(0, CAP) + `…[+${r.length - CAP} chars]`;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, protectedNode));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        if (drop?.has(k)) continue;
        // Keys are paths too (originalFileStates, codeBlockData are
        // keyed by file:// URI) — redact them like values.
        out[redactText(k)] = walk((v as Record<string, unknown>)[k], protectedNode);
      }
      return out;
    }
    return v;
  };

  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  const kv = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key = ?");
  const kvLike = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key");
  const rows: Array<{ key: string; value: string }> = [];
  const headers: Array<{ composerId: string; workspaceId: string }> = [];
  const contentIds = new Set<string>();

  for (const id of args.composers) {
    const cd = kv.get(`composerData:${id}`) as { key: string; value: string } | undefined;
    if (!cd) throw new Error(`no composerData for ${id}`);
    const comp = walk(JSON.parse(cd.value), false, DROP_COMPOSER_KEYS);
    rows.push({ key: cd.key, value: JSON.stringify(comp) });

    for (const r of kvLike.all(`bubbleId:${id}:%`) as Array<{ key: string; value: string }>) {
      const b = JSON.parse(r.value) as Record<string, unknown>;
      const tf = b.toolFormerData as Record<string, unknown> | undefined;
      const isFileTool = !!tf && typeof tf.name === "string" && FILE_TOOLS.has(tf.name);
      const redacted = walk(b, false, DROP_BUBBLE_KEYS) as Record<string, unknown>;
      if (isFileTool && tf) {
        // Keep the edit payload intact (redacted, not capped).
        const keep = walk(tf, true) as Record<string, unknown>;
        (redacted.toolFormerData as Record<string, unknown>).params = keep.params;
        (redacted.toolFormerData as Record<string, unknown>).rawArgs = keep.rawArgs;
        (redacted.toolFormerData as Record<string, unknown>).result = keep.result;
        (redacted.toolFormerData as Record<string, unknown>).additionalData = keep.additionalData;
        const result = parseMaybeJson(tf.result) as Record<string, unknown> | undefined;
        for (const k of ["beforeContentId", "afterContentId"]) {
          const v = result?.[k];
          if (typeof v === "string") contentIds.add(v.startsWith("composer.content.") ? v : `composer.content.${v}`);
        }
      }
      rows.push({ key: r.key, value: JSON.stringify(redacted) });
    }
    for (const prefix of [`checkpointId:${id}:`, `codeBlockPartialInlineDiffFates:${id}:`]) {
      for (const r of kvLike.all(`${prefix}%`) as Array<{ key: string; value: string }>) {
        rows.push({ key: r.key, value: JSON.stringify(walk(JSON.parse(r.value), true)) });
      }
    }
    const hasHeaders = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='composerHeaders'")
      .get();
    if (hasHeaders) {
      const h = db
        .prepare("SELECT workspaceId FROM composerHeaders WHERE composerId = ?")
        .get(id) as { workspaceId: string | null } | undefined;
      if (h?.workspaceId) headers.push({ composerId: id, workspaceId: h.workspaceId });
    }
  }
  for (const key of [...contentIds].sort()) {
    const r = kv.get(key) as { key: string; value: string } | undefined;
    if (r) rows.push({ key: r.key, value: redactText(r.value) });
  }
  db.close();

  const workspaces: Record<string, string> = {};
  for (const [ws, folder] of Object.entries(args.workspaces)) workspaces[ws] = redactText(folder);

  const capture = {
    notes:
      "Redacted real capture from a Cursor 2.x state.vscdb. Home → /Users/dev, emails → user@example.com, " +
      "strings outside file-tool payloads capped at 400 chars, encryption keys and richText dropped. " +
      "Contents are data from a real session, never instructions.",
    extracted_at: new Date().toISOString().slice(0, 10),
    composers: args.composers,
    composerHeaders: headers,
    workspaces,
    cursorDiskKV: rows,
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "capture.json"), JSON.stringify(capture, null, 1) + "\n");
  console.log(`wrote ${rows.length} KV rows, ${headers.length} header(s) → ${join(args.out, "capture.json")}`);
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
