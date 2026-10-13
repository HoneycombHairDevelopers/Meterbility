import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, listFileChanges, listSteps } from "@meterbility/collector";
import { ingestSession } from "./ingest.ts";
import { applyEdit } from "./file_changes.ts";
import { probeRecords } from "./shape_probe.ts";
import { readSession } from "./parser.ts";

/**
 * file-history-delta coverage (Claude Code ≥ 2.1, observed 2026-10).
 *
 * Current Claude Code builds write one `file-history-snapshot` per
 * user turn (keyed by the user prompt uuid) and then one
 * `file-history-delta` per first touch of a path within the turn,
 * keyed by the ASSISTANT uuid that made the touch. The fixtures below
 * mirror the shapes seen in a real transcript
 * (meter-testbed run_d861dc1d, 2026-10-12):
 *
 *   - a Write-then-Edit of a new file in one turn: the delta's backup
 *     is `null` (the file didn't exist when the turn began), so the
 *     Edit's before-image has to come from the Write's content;
 *   - an Edit whose delta carries a real `<hash>@v1` backup;
 *   - the delta landing in the file BEFORE its assistant record;
 *   - `toolUseResult.originalFile` on the tool_result record, the
 *     exact pre-call bytes.
 *
 * Every ingest here runs with `captureBaseline: false` so the
 * fictitious cwd never triggers a working-tree walk.
 */

const CWD = "/tmp/proj";
const SESSION = "sess-delta";

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "meter-fc-delta-"));
  process.env.METERBILITY_HOME = dir;
  return Store.open({ path: join(dir, "meterbility.db") });
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "meter-fc-delta-session-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(
    path,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return path;
}

/** Build a `BackupReader` from a (sessionId, backupFileName) → string map. */
function memoryBackupReader(map: Record<string, string>) {
  return async (sessionId: string, backupFileName: string) => {
    const key = `${sessionId}/${backupFileName}`;
    return map[key] !== undefined ? Buffer.from(map[key], "utf-8") : undefined;
  };
}

// ─── Record builders (current Claude Code shapes) ────────────────────

let clock = 0;
function ts(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 13, 2, 19, clock)).toISOString();
}

function userPrompt(uuid: string, text: string, parentUuid: string | null) {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: SESSION,
    timestamp: ts(),
    cwd: CWD,
    gitBranch: "main",
    message: { role: "user", content: text },
  };
}

/** The per-turn snapshot: keyed by the user prompt uuid, often empty. */
function snapshot(
  turnUuid: string,
  tracked: Record<string, object> = {},
) {
  return {
    type: "file-history-snapshot",
    messageId: turnUuid,
    snapshot: {
      messageId: turnUuid,
      trackedFileBackups: tracked,
      timestamp: ts(),
    },
    isSnapshotUpdate: false,
  };
}

function delta(
  assistantUuid: string,
  turnUuid: string,
  trackingPath: string,
  backupFileName: string | null,
  version = 1,
) {
  const at = ts();
  return {
    type: "file-history-delta",
    messageId: assistantUuid,
    snapshotMessageId: turnUuid,
    trackingPath,
    backup: {
      backupFileName,
      version,
      backupTime: at,
      realParentDir: join(CWD, trackingPath, ".."),
    },
    timestamp: at,
  };
}

function assistantToolUse(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: SESSION,
    timestamp: ts(),
    cwd: CWD,
    message: {
      role: "assistant",
      model: "claude-fable-5-1",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function toolResult(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
  toolUseResult?: unknown,
) {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: SESSION,
    timestamp: ts(),
    cwd: CWD,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  };
}

async function ingest(
  records: object[],
  backups: Record<string, string> = {},
) {
  const store = freshStore();
  const path = writeSession(records);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader(backups),
    captureBaseline: false,
  });
  const steps = listSteps(store, result.run_id);
  const fcs = listFileChanges(store, { runId: result.run_id });
  return { store, result, steps, fcs, path };
}

function notes(fc: { normalizer_notes?: unknown }): Record<string, unknown> {
  return (fc.normalizer_notes ?? {}) as Record<string, unknown>;
}

// ─── Delta with a real backup ────────────────────────────────────────

test("delta with a <hash>@v1 backup and an empty turn snapshot → full Edit row from file-history", async () => {
  const before = "export function greet() {\n  return 'hi';\n}\n";
  const records = [
    userPrompt("u1", "rename greet to hello", null),
    snapshot("u1"), // current builds: empty, keyed by the prompt uuid
    // The delta lands BEFORE its assistant record here — observed in
    // real transcripts; linkage must not depend on order.
    delta("a1", "u1", "src/greet.ts", "1140f70ec7e925c2@v1"),
    assistantToolUse("a1", "u1", "tu1", "Edit", {
      file_path: `${CWD}/src/greet.ts`,
      old_string: "greet",
      new_string: "hello",
    }),
    toolResult("u2", "a1", "tu1"),
  ];
  const { store, result, steps, fcs } = await ingest(records, {
    [`${SESSION}/1140f70ec7e925c2@v1`]: before,
  });
  assert.equal(result.file_changes_added, 1);
  const fc = fcs[0]!;
  assert.equal(fc.step_id, steps[0]!.step_id);
  assert.equal(fc.path, "src/greet.ts");
  assert.equal(fc.op, "modify");
  assert.equal(fc.source_tool_name, "Edit");
  assert.equal(fc.partial_diff, false, "delta-backed Edit must not be partial");
  assert.ok(fc.before_blob_ref);
  assert.ok(fc.after_blob_ref);
  assert.equal(await store.blobs.getString(fc.before_blob_ref!), before);
  assert.equal(
    await store.blobs.getString(fc.after_blob_ref!),
    "export function hello() {\n  return 'hi';\n}\n",
  );
  assert.equal(fc.lines_added, 1);
  assert.equal(fc.lines_removed, 1);
  assert.equal(fc.line_count_before, 3);
  assert.equal(fc.line_count_after, 3);
  assert.match(fc.patch_text ?? "", /-export function greet/);
  assert.match(fc.patch_text ?? "", /\+export function hello/);
  assert.equal(notes(fc).before_source, "file-history");
  store.close();
});

// ─── The testbed shape: Write then Edit in one turn ──────────────────

test("Write then Edit in one turn, delta backup null → Edit before-image chains from the Write", async () => {
  const written =
    "#!/usr/bin/env node\nimport { list } from './store.js';\nconsole.log(list());\n";
  const records = [
    userPrompt("u1", "build the cli", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/src/cli.js`,
      content: written,
    }),
    // null backup: the file did not exist when the turn started.
    delta("a1", "u1", "src/cli.js", null),
    toolResult("u2", "a1", "tu1"),
    // Later in the SAME turn: no delta of its own (one per path per turn).
    assistantToolUse("a2", "u2", "tu2", "Edit", {
      file_path: `${CWD}/src/cli.js`,
      old_string: "import { list } from './store.js';",
      new_string: "import pc from 'picocolors';\nimport { list } from './store.js';",
    }),
    toolResult("u3", "a2", "tu2"),
  ];
  const { store, result, fcs } = await ingest(records);
  assert.equal(result.file_changes_added, 2);

  const write = fcs.find((f) => f.source_tool_name === "Write")!;
  assert.equal(write.op, "create");
  assert.equal(write.before_blob_ref, undefined);
  assert.equal(write.lines_added, 3);

  const edit = fcs.find((f) => f.source_tool_name === "Edit")!;
  assert.equal(edit.op, "modify");
  assert.equal(edit.partial_diff, false, "Edit after a Write must be full");
  assert.equal(await store.blobs.getString(edit.before_blob_ref!), written);
  assert.equal(
    await store.blobs.getString(edit.after_blob_ref!),
    "#!/usr/bin/env node\nimport pc from 'picocolors';\nimport { list } from './store.js';\nconsole.log(list());\n",
  );
  assert.equal(edit.lines_added, 1);
  assert.equal(edit.lines_removed, 0);
  assert.equal(edit.line_count_before, 3);
  assert.equal(edit.line_count_after, 4);
  assert.equal(notes(edit).before_source, "session-chain");
  store.close();
});

test("second Edit of one file in a turn chains from the first Edit, not the stale pre-turn backup", async () => {
  const preTurn = "alpha\nbeta\ngamma\n";
  const records = [
    userPrompt("u1", "uppercase things", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Edit", {
      file_path: `${CWD}/notes.txt`,
      old_string: "alpha",
      new_string: "ALPHA",
    }),
    delta("a1", "u1", "notes.txt", "9879371bea7faf88@v1"),
    toolResult("u2", "a1", "tu1"),
    assistantToolUse("a2", "u2", "tu2", "Edit", {
      file_path: `${CWD}/notes.txt`,
      old_string: "beta",
      new_string: "BETA",
    }),
    toolResult("u3", "a2", "tu2"),
  ];
  const { store, fcs } = await ingest(records, {
    [`${SESSION}/9879371bea7faf88@v1`]: preTurn,
  });
  assert.equal(fcs.length, 2);
  const [first, second] = fcs;
  assert.equal(notes(first!).before_source, "file-history");
  assert.equal(await store.blobs.getString(first!.before_blob_ref!), preTurn);
  assert.equal(notes(second!).before_source, "session-chain");
  assert.equal(
    await store.blobs.getString(second!.before_blob_ref!),
    "ALPHA\nbeta\ngamma\n",
  );
  assert.equal(
    await store.blobs.getString(second!.after_blob_ref!),
    "ALPHA\nBETA\ngamma\n",
  );
  assert.equal(second!.lines_added, 1);
  assert.equal(second!.lines_removed, 1);
  store.close();
});

// ─── toolUseResult.originalFile ──────────────────────────────────────

test("toolUseResult.originalFile wins: exact pre-call bytes even after a Bash rewrite mid-turn", async () => {
  const written = "import { x } from './store.js';\nexport const y = x;\n";
  // What `sed -i 's#./store.js#./inventory.js#'` left on disk between
  // the Write and the Edit — invisible to file-history and to the chain.
  const afterSed = "import { x } from './inventory.js';\nexport const y = x;\n";
  const records = [
    userPrompt("u1", "rename the module", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/src/cli.js`,
      content: written,
    }),
    delta("a1", "u1", "src/cli.js", null),
    toolResult("u2", "a1", "tu1", {
      type: "create",
      filePath: `${CWD}/src/cli.js`,
      content: written,
      originalFile: null,
      structuredPatch: [],
      userModified: false,
    }),
    assistantToolUse("a2", "u2", "tu2", "Bash", {
      command: "sed -i '' 's#./store.js#./inventory.js#g' src/cli.js",
    }),
    toolResult("u3", "a2", "tu2", { stdout: "", stderr: "", interrupted: false }),
    assistantToolUse("a3", "u3", "tu3", "Edit", {
      file_path: `${CWD}/src/cli.js`,
      old_string: "export const y = x;",
      new_string: "export const y = x * 2;",
    }),
    toolResult("u4", "a3", "tu3", {
      filePath: `${CWD}/src/cli.js`,
      oldString: "export const y = x;",
      newString: "export const y = x * 2;",
      originalFile: afterSed,
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    }),
  ];
  const { store, fcs } = await ingest(records);
  const edit = fcs.find((f) => f.source_tool_name === "Edit")!;
  assert.equal(edit.partial_diff, false);
  assert.equal(notes(edit).before_source, "tool-result");
  assert.equal(await store.blobs.getString(edit.before_blob_ref!), afterSed);
  assert.equal(
    await store.blobs.getString(edit.after_blob_ref!),
    "import { x } from './inventory.js';\nexport const y = x * 2;\n",
  );
  // The Bash step still gets its opaque (shell) stub.
  const bash = fcs.find((f) => f.source_tool_name === "Bash")!;
  assert.equal(bash.path, "(shell)");
  assert.equal(bash.partial_diff, true);
  store.close();
});

test("Write over an existing file with toolUseResult type=update → op=modify from originalFile", async () => {
  const original = "old body\n";
  const records = [
    userPrompt("u1", "rewrite it", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/README.md`,
      content: "new body\nsecond line\n",
    }),
    delta("a1", "u1", "README.md", "deadbeef00000000@v1"),
    toolResult("u2", "a1", "tu1", {
      type: "update",
      filePath: `${CWD}/README.md`,
      content: "new body\nsecond line\n",
      originalFile: original,
      structuredPatch: [],
      userModified: false,
    }),
  ];
  // Deliberately NO backup bytes registered: the tool result alone
  // must carry the row.
  const { store, fcs } = await ingest(records);
  assert.equal(fcs.length, 1);
  const fc = fcs[0]!;
  assert.equal(fc.op, "modify");
  assert.equal(fc.partial_diff, false);
  assert.equal(notes(fc).before_source, "tool-result");
  assert.equal(await store.blobs.getString(fc.before_blob_ref!), original);
  assert.equal(fc.lines_added, 2);
  assert.equal(fc.lines_removed, 1);
  store.close();
});

// ─── Cross-turn: freshest image wins ─────────────────────────────────

test("later turn: a fresher turn-level backup beats the session chain; a staler one loses", async () => {
  const written = "one\n";
  const userEdited = "one\nedited by hand between turns\n";
  const records = [
    userPrompt("u1", "create f.txt", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/f.txt`,
      content: written,
    }),
    delta("a1", "u1", "f.txt", null),
    toolResult("u2", "a1", "tu1"),
    // Turn 2. The turn snapshot lists f.txt with a backup taken AFTER
    // the Write (the user edited the file in between). The Edit step
    // has no delta of its own (simulates a lost delta) so resolution
    // goes turn-level → freshness check.
    userPrompt("u3", "now edit f.txt", "u2"),
    snapshot("u3", {
      "f.txt": {
        backupFileName: "f0000000000000000@v2",
        version: 2,
        backupTime: ts(),
        realParentDir: CWD,
      },
    }),
    assistantToolUse("a2", "u3", "tu2", "Edit", {
      file_path: `${CWD}/f.txt`,
      old_string: "one",
      new_string: "ONE",
    }),
    toolResult("u4", "a2", "tu2"),
    // Turn 3: the snapshot still carries the v2 pointer (now older than
    // the chain entry turn 2 produced); the chain must win this time.
    userPrompt("u5", "and again", "u4"),
    snapshot("u5", {
      "f.txt": {
        backupFileName: "f0000000000000000@v2",
        version: 2,
        backupTime: "2026-10-13T02:19:00.000Z", // before every record above
        realParentDir: CWD,
      },
    }),
    assistantToolUse("a3", "u5", "tu3", "Edit", {
      file_path: `${CWD}/f.txt`,
      old_string: "hand",
      new_string: "HAND",
    }),
    toolResult("u6", "a3", "tu3"),
  ];
  const { store, fcs } = await ingest(records, {
    [`${SESSION}/f0000000000000000@v2`]: userEdited,
  });
  const edits = fcs.filter((f) => f.source_tool_name === "Edit");
  assert.equal(edits.length, 2);
  const [turn2, turn3] = edits;
  assert.equal(notes(turn2!).before_source, "file-history");
  assert.equal(await store.blobs.getString(turn2!.before_blob_ref!), userEdited);
  assert.equal(notes(turn3!).before_source, "session-chain");
  assert.equal(
    await store.blobs.getString(turn3!.before_blob_ref!),
    "ONE\nedited by hand between turns\n",
  );
  assert.equal(
    await store.blobs.getString(turn3!.after_blob_ref!),
    "ONE\nedited by HAND between turns\n",
  );
  store.close();
});

test("delta pointing at a backup file that is missing on disk falls through to the chain", async () => {
  const written = "a\nb\n";
  const records = [
    userPrompt("u1", "go", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/x.txt`,
      content: written,
    }),
    delta("a1", "u1", "x.txt", null),
    toolResult("u2", "a1", "tu1"),
    userPrompt("u3", "more", "u2"),
    snapshot("u3"),
    assistantToolUse("a2", "u3", "tu2", "Edit", {
      file_path: `${CWD}/x.txt`,
      old_string: "b",
      new_string: "B",
    }),
    delta("a2", "u3", "x.txt", "gone0000000000000@v2", 2),
    toolResult("u4", "a2", "tu2"),
  ];
  // No bytes registered for the v2 pointer → unreadable backup.
  const { store, fcs } = await ingest(records);
  const edit = fcs.find((f) => f.source_tool_name === "Edit")!;
  assert.equal(edit.partial_diff, false);
  assert.equal(notes(edit).before_source, "session-chain");
  assert.equal(await store.blobs.getString(edit.before_blob_ref!), written);
  store.close();
});

test("MultiEdit after a Write in one turn is full and honors per-edit replace_all", async () => {
  const written = "foo foo\nbar\n";
  const records = [
    userPrompt("u1", "go", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/m.txt`,
      content: written,
    }),
    delta("a1", "u1", "m.txt", null),
    toolResult("u2", "a1", "tu1"),
    assistantToolUse("a2", "u2", "tu2", "MultiEdit", {
      file_path: `${CWD}/m.txt`,
      edits: [
        { old_string: "foo", new_string: "qux", replace_all: true },
        { old_string: "bar", new_string: "baz" },
      ],
    }),
    toolResult("u3", "a2", "tu2"),
  ];
  const { store, fcs } = await ingest(records);
  const me = fcs.find((f) => f.source_tool_name === "MultiEdit")!;
  assert.equal(me.partial_diff, false);
  assert.equal(await store.blobs.getString(me.before_blob_ref!), written);
  assert.equal(await store.blobs.getString(me.after_blob_ref!), "qux qux\nbaz\n");
  store.close();
});

test("stale session chain (Bash rewrote the file, no tool result) → partial stub, not a dropped row", async () => {
  const written = "import { x } from './store.js';\nexport const y = x;\n";
  const records = [
    userPrompt("u1", "go", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/src/cli.js`,
      content: written,
    }),
    delta("a1", "u1", "src/cli.js", null),
    toolResult("u2", "a1", "tu1"),
    assistantToolUse("a2", "u2", "tu2", "Bash", {
      command: "sed -i '' 's#./store.js#./inventory.js#g' src/cli.js",
    }),
    toolResult("u3", "a2", "tu2"),
    // The Edit targets the line sed changed; our chained image still
    // has the old import, so the old_string can't match.
    assistantToolUse("a3", "u3", "tu3", "Edit", {
      file_path: `${CWD}/src/cli.js`,
      old_string: "from './inventory.js';",
      new_string: "from './inventory.js'; // moved",
    }),
    toolResult("u4", "a3", "tu3"),
    // A following Edit must not inherit the stale chain either.
    assistantToolUse("a4", "u4", "tu4", "Edit", {
      file_path: `${CWD}/src/cli.js`,
      old_string: "export const y = x;",
      new_string: "export const y = x + 1;",
    }),
    toolResult("u5", "a4", "tu4"),
  ];
  const { store, fcs } = await ingest(records);
  const edits = fcs.filter((f) => f.source_tool_name === "Edit");
  assert.equal(edits.length, 2, "both edits must leave a row");
  assert.equal(edits[0]!.partial_diff, true);
  assert.equal(edits[0]!.before_blob_ref, undefined);
  assert.equal(edits[1]!.partial_diff, true, "stale chain was dropped, not reused");
  store.close();
});

test("Edit whose old_string misses an EXACT before-image (tool result) is dropped as refused", async () => {
  const records = [
    userPrompt("u1", "go", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Edit", {
      file_path: `${CWD}/a.txt`,
      old_string: "nope",
      new_string: "yes",
    }),
    toolResult("u2", "a1", "tu1", {
      filePath: `${CWD}/a.txt`,
      oldString: "nope",
      newString: "yes",
      originalFile: "something else entirely\n",
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    }),
  ];
  const { store, fcs } = await ingest(records);
  assert.equal(fcs.length, 0);
  store.close();
});

test("Edit with no source at all is still a partial stub (no regression)", async () => {
  const records = [
    userPrompt("u1", "go", null),
    snapshot("u1"),
    assistantToolUse("a1", "u1", "tu1", "Edit", {
      file_path: `${CWD}/unknown.txt`,
      old_string: "a",
      new_string: "b",
    }),
    toolResult("u2", "a1", "tu1"),
  ];
  const { store, fcs } = await ingest(records);
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.before_blob_ref, undefined);
  assert.equal(fcs[0]!.normalizer_notes, undefined);
  store.close();
});

// ─── Pure helpers ────────────────────────────────────────────────────

test("applyEdit replace_all substitutes every occurrence", () => {
  assert.equal(applyEdit("a-a-a", "a", "b", true), "b-b-b");
  assert.equal(applyEdit("a-a-a", "a", "b", false), "b-a-a");
  assert.equal(applyEdit("a-a-a", "z", "b", true), undefined);
});

// ─── Shape probe ─────────────────────────────────────────────────────

test("shape probe is quiet on a transcript made of current file-history shapes", async () => {
  const records = [
    userPrompt("u1", "go", null),
    snapshot("u1", {
      "SPEC.md": {
        backupFileName: "03403c22701dca3f@v2",
        version: 2,
        backupTime: ts(),
        realParentDir: CWD,
      },
    }),
    assistantToolUse("a1", "u1", "tu1", "Write", {
      file_path: `${CWD}/package.json`,
      content: "{}\n",
    }),
    delta("a1", "u1", "package.json", null),
    toolResult("u2", "a1", "tu1", {
      type: "create",
      filePath: `${CWD}/package.json`,
      content: "{}\n",
      originalFile: null,
      structuredPatch: [],
      userModified: false,
    }),
  ];
  const parsed = await readSession(writeSession(records));
  const warnings = probeRecords(parsed.map((p) => p.record));
  assert.deepEqual(
    warnings.map((w) => w.recordType),
    [],
    warnings.map((w) => `${w.recordType}: unexpected=${w.unexpectedKeys.join(",")}`).join("\n"),
  );
});
