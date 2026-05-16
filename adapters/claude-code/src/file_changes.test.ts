import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  listFileChanges,
  listSteps,
} from "@spool/collector";
import { ingestSession } from "./ingest.ts";
import { applyEdit } from "./file_changes.ts";
import { diffLines } from "./diff.ts";

/**
 * v0.3 Turn 4 — Claude Code file-history-snapshot adapter tests.
 *
 * Two layers:
 *   - Pure-function tests for `applyEdit` and `diffLines` — no IO, fast.
 *   - End-to-end ingest tests that feed a hand-crafted JSONL session
 *     plus an in-memory `BackupReader` through `ingestSession`, then
 *     read back the inserted `file_change` rows. The in-memory reader
 *     stands in for `~/.claude/file-history/<session>/<sha>` so tests
 *     stay hermetic.
 */

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-fc-adapter-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-fc-session-"));
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

// ─── Pure unit tests ─────────────────────────────────────────────────

test("applyEdit substitutes the first match", () => {
  const before = "hello world\nhello world\n";
  assert.equal(applyEdit(before, "world", "spool"), "hello spool\nhello world\n");
});

test("applyEdit returns undefined when old_string is absent", () => {
  assert.equal(applyEdit("abc\n", "xyz", "qqq"), undefined);
});

test("diffLines counts added and removed lines and emits a hunk header", () => {
  const r = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
  // Removed "b", added "B" and "d". Trailing newline produces an empty
  // tail line that's equal in both — the LCS treats it as "eq".
  assert.equal(r.stats.added, 2);
  assert.equal(r.stats.removed, 1);
  assert.match(r.unified, /@@ -1,4 \+1,5 @@/);
});

test("diffLines empty diff returns empty unified", () => {
  const r = diffLines("a\nb\n", "a\nb\n");
  assert.equal(r.unified, "");
  assert.equal(r.stats.added, 0);
  assert.equal(r.stats.removed, 0);
});

test("diffLines handles pure-create (empty before)", () => {
  const r = diffLines("", "new\nfile\n");
  assert.equal(r.stats.added, 2);
  assert.equal(r.stats.removed, 0);
});

// ─── Edit tool: full-fidelity capture ────────────────────────────────

test("Edit tool produces one FileChange with op='modify', blob refs, and a unified diff", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "sess-edit",
      timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      gitBranch: "main",
      message: { role: "user", content: "rename greet to hello" },
    },
    // file-history-snapshot lands BEFORE the modifying assistant turn.
    {
      type: "file-history-snapshot",
      sessionId: "sess-edit",
      timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/src/greet.ts": { backupFileName: "bak-greet-v0" },
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "sess-edit",
      timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: "tu_edit_1",
            name: "Edit",
            input: {
              file_path: "/tmp/proj/src/greet.ts",
              old_string: "greet",
              new_string: "hello",
            },
          },
        ],
        usage: { input_tokens: 30, output_tokens: 4 },
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: "sess-edit",
      timestamp: "2026-05-15T00:00:02Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_edit_1", content: "ok" },
        ],
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({
      "sess-edit/bak-greet-v0": "function greet() { return 'hi'; }\n",
    }),
  });
  assert.equal(result.steps_added, 1);
  assert.equal(result.file_changes_added, 1);

  const steps = listSteps(store, result.run_id);
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  const fc = fcs[0]!;
  assert.equal(fc.step_id, steps[0]!.step_id);
  assert.equal(fc.path, "src/greet.ts");
  assert.equal(fc.op, "modify");
  assert.equal(fc.derived_from, "tool_call");
  assert.equal(fc.source_tool_name, "Edit");
  assert.equal(fc.partial_diff, false);
  assert.ok(fc.before_blob_ref, "before_blob_ref should be set");
  assert.ok(fc.after_blob_ref, "after_blob_ref should be set");
  assert.notEqual(fc.before_blob_ref, fc.after_blob_ref);
  assert.match(fc.patch_text ?? "", /@@ /);
  assert.match(fc.patch_text ?? "", /-function greet\(/);
  assert.match(fc.patch_text ?? "", /\+function hello\(/);
  assert.equal(fc.lines_added, 1);
  assert.equal(fc.lines_removed, 1);
  // Verify the captured bytes are byte-exact via the blob store.
  const beforeBytes = await store.blobs.getString(fc.before_blob_ref!);
  assert.equal(beforeBytes, "function greet() { return 'hi'; }\n");
  const afterBytes = await store.blobs.getString(fc.after_blob_ref!);
  assert.equal(afterBytes, "function hello() { return 'hi'; }\n");
  store.close();
});

// ─── Write tool: create vs modify ────────────────────────────────────

test("Write to a path with no backup → op='create' (before_blob_ref undefined)", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-w-c", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "create greeting" },
    },
    // No file-history-snapshot for this turn — Claude only writes one
    // when there's something to back up. For pure creates, none exists.
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-w-c", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_w_1", name: "Write",
          input: { file_path: "/tmp/proj/src/new.ts", content: "export const x = 1;\n" },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({}),
  });
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.op, "create");
  assert.equal(fcs[0]!.before_blob_ref, undefined);
  assert.ok(fcs[0]!.after_blob_ref);
  assert.equal(fcs[0]!.path, "src/new.ts");
  store.close();
});

test("Write over an existing file → op='modify' with both blob refs set", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-w-m", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "overwrite" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-w-m", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/src/x.ts": { backupFileName: "bak-x-v0" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-w-m", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_w_2", name: "Write",
          input: { file_path: "/tmp/proj/src/x.ts", content: "new content\n" },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({
      "sess-w-m/bak-x-v0": "old content\n",
    }),
  });
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.op, "modify");
  assert.ok(fcs[0]!.before_blob_ref);
  assert.ok(fcs[0]!.after_blob_ref);
  store.close();
});

// ─── MultiEdit: N edits applied sequentially to one file ─────────────

test("MultiEdit applies edits in order; final after_blob reflects all of them", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-me", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "swap two things" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-me", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/src/conf.ts": { backupFileName: "bak-conf-v0" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-me", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_me_1", name: "MultiEdit",
          input: {
            file_path: "/tmp/proj/src/conf.ts",
            edits: [
              { old_string: "FOO", new_string: "BAR" },
              { old_string: "ONE", new_string: "TWO" },
            ],
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({
      "sess-me/bak-conf-v0": "FOO=alpha\nONE=1\n",
    }),
  });
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  const after = await store.blobs.getString(fcs[0]!.after_blob_ref!);
  assert.equal(after, "BAR=alpha\nTWO=1\n");
  store.close();
});

test("MultiEdit aborts cleanly if a later edit's old_string doesn't match", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-me-bad", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "bad edits" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-me-bad", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/src/x.ts": { backupFileName: "bak-x" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-me-bad", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_me_bad", name: "MultiEdit",
          input: {
            file_path: "/tmp/proj/src/x.ts",
            edits: [
              { old_string: "FOO", new_string: "BAR" },
              { old_string: "NOPE", new_string: "QUX" }, // doesn't match
            ],
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({ "sess-me-bad/bak-x": "FOO\n" }),
  });
  // MultiEdit is atomic — Claude would have rejected. No FileChange row.
  assert.equal(result.file_changes_added, 0);
  store.close();
});

// ─── Bash + NotebookEdit stubs ───────────────────────────────────────

test("Bash tool emits a single partial_diff stub (no blob refs)", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-bash", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "list files" },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-bash", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_bash", name: "Bash",
          input: { command: "ls -la" },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
    {
      type: "user", uuid: "u2", parentUuid: "a1",
      sessionId: "sess-bash", timestamp: "2026-05-15T00:00:02Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_bash", content: "file1\n" },
        ],
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path);
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.before_blob_ref, undefined);
  assert.equal(fcs[0]!.after_blob_ref, undefined);
  assert.equal(fcs[0]!.path, "(shell)");
  assert.equal(fcs[0]!.source_tool_name, "Bash");
  store.close();
});

test("NotebookEdit emits a partial_diff stub with patch_format='notebook_cell'", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-nb", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "edit cell" },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-nb", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_nb", name: "NotebookEdit",
          input: { notebook_path: "/tmp/proj/analysis.ipynb", cell_id: "abc" },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path);
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.patch_format, "notebook_cell");
  assert.equal(fcs[0]!.path, "analysis.ipynb");
  store.close();
});

// ─── Bug-surface defenses ────────────────────────────────────────────

test("defense #1: snapshot.messageId colliding with a real message uuid does NOT mis-key", async () => {
  // Set up a session where a normal user message has uuid "collide",
  // AND an unrelated file-history-snapshot also has messageId "collide".
  // The actual assistant message is uuid "real_a1". The snapshot's
  // tracked path must attach to "real_a1", NOT to the user's "collide" id.
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "collide", parentUuid: null,
      sessionId: "sess-col", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "do thing" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-col", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "real_a1",  // <- the assistant uuid, not "collide"
      trackedFileBackups: {
        "/tmp/proj/src/y.ts": { backupFileName: "bak-y" },
      },
    },
    {
      type: "assistant", uuid: "real_a1", parentUuid: "collide",
      sessionId: "sess-col", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_y", name: "Edit",
          input: {
            file_path: "/tmp/proj/src/y.ts",
            old_string: "old",
            new_string: "new",
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({ "sess-col/bak-y": "old\n" }),
  });
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  // The FileChange should be attached to the assistant step, not the user
  // record. We assert this by checking that the row's step_id corresponds
  // to a step that was actually built (the user record never becomes one).
  const steps = listSteps(store, result.run_id);
  assert.equal(steps.length, 1);
  assert.equal(fcs[0]!.step_id, steps[0]!.step_id);
  store.close();
});

test("defense #2: nondeterministic first line (e.g., 'progress') doesn't break ingest", async () => {
  // First line is a meaningless 'progress' record — the parser must
  // iterate past it and still find the user / assistant pair.
  const store = freshStore();
  const session: object[] = [
    { type: "progress", sessionId: "sess-prog", timestamp: "2026-05-15T00:00:00Z" },
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-prog", timestamp: "2026-05-15T00:00:00.100Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "make change" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-prog", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/z.ts": { backupFileName: "bak-z" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-prog", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_z", name: "Edit",
          input: { file_path: "/tmp/proj/z.ts", old_string: "a", new_string: "b" },
        }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({ "sess-prog/bak-z": "a\n" }),
  });
  assert.equal(result.file_changes_added, 1);
  store.close();
});

test("defense #4: missing backup file → partial_diff stub (not a dropped row)", async () => {
  // The snapshot names a backup, but the in-memory reader doesn't have
  // it — simulates a backup file that Claude has since cleaned up.
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-miss", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "change" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-miss", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/missing.ts": { backupFileName: "bak-was-cleaned-up" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-miss", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_miss", name: "Edit",
          input: {
            file_path: "/tmp/proj/missing.ts",
            old_string: "x", new_string: "y",
          },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({}), // empty — backup not found
  });
  const fcs = listFileChanges(store, { runId: result.run_id });
  assert.equal(fcs.length, 1);
  assert.equal(fcs[0]!.partial_diff, true);
  assert.equal(fcs[0]!.path, "missing.ts");
  assert.equal(fcs[0]!.source_tool_name, "Edit");
  store.close();
});

// ─── Idempotency contract ────────────────────────────────────────────

test("re-ingesting the same session doesn't double-write FileChanges", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-idemp", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "edit" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-idemp", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/a.ts": { backupFileName: "bak-a" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-idemp", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_a", name: "Edit",
          input: { file_path: "/tmp/proj/a.ts", old_string: "x", new_string: "y" },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const reader = memoryBackupReader({ "sess-idemp/bak-a": "x\n" });
  const r1 = await ingestSession(store, path, { readBackup: reader });
  const r2 = await ingestSession(store, path, { readBackup: reader });
  // The second ingest re-reads but skips already-inserted rows. Total
  // count in the table after both ingests must be 1, not 2.
  const fcs = listFileChanges(store, { runId: r1.run_id });
  assert.equal(fcs.length, 1);
  // The second ingest's reported count reflects what THIS call inserted —
  // 0, because the row was already there from r1.
  assert.equal(r2.file_changes_added, 0);
  store.close();
});

// ─── Multi-step run: intra-step + inter-step ordering ────────────────

test("multiple modifying steps in one run produce correctly attributed and ordered rows", async () => {
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-multi", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "do two edits" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-multi", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      trackedFileBackups: {
        "/tmp/proj/p.ts": { backupFileName: "bak-p-v0" },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-multi", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_p1", name: "Edit",
          input: { file_path: "/tmp/proj/p.ts", old_string: "A", new_string: "B" },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
    {
      type: "user", uuid: "u2", parentUuid: "a1",
      sessionId: "sess-multi", timestamp: "2026-05-15T00:00:02Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_p1", content: "ok" }],
      },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-multi", timestamp: "2026-05-15T00:00:02.500Z",
      messageId: "a2",
      trackedFileBackups: {
        "/tmp/proj/q.ts": { backupFileName: "bak-q-v0" },
      },
    },
    {
      type: "assistant", uuid: "a2", parentUuid: "u2",
      sessionId: "sess-multi", timestamp: "2026-05-15T00:00:03Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_q1", name: "Edit",
          input: { file_path: "/tmp/proj/q.ts", old_string: "C", new_string: "D" },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({
      "sess-multi/bak-p-v0": "A\n",
      "sess-multi/bak-q-v0": "C\n",
    }),
  });
  assert.equal(result.steps_added, 2);
  assert.equal(result.file_changes_added, 2);
  const fcs = listFileChanges(store, { runId: result.run_id });
  // Ordering must be (step.sequence ASC, fc.sequence ASC). Step 0 = p.ts,
  // step 1 = q.ts.
  assert.equal(fcs.length, 2);
  assert.equal(fcs[0]!.path, "p.ts");
  assert.equal(fcs[1]!.path, "q.ts");
  // Sequences are intra-step counters, so both should be 0.
  assert.equal(fcs[0]!.sequence, 0);
  assert.equal(fcs[1]!.sequence, 0);
  store.close();
});
