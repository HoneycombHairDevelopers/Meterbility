import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  getBaselineTree,
  getRun,
  listFileChanges,
  workingTreeAt,
} from "@spool/collector";
import { ingestSession } from "./ingest.ts";

/**
 * v0.3 Turn 5 — lazy baseline capture, end-to-end via ingestSession.
 *
 * The integration these tests cover:
 *
 *   "Session JSONL with an Edit  ▸  baseline_tree captured against
 *    the real cwd  ▸  workingTreeAt(end) reflects the post-edit state."
 *
 * We build a tmpdir as the cwd, write a real source file there, and
 * craft a session whose Edit modifies it. The lazy trigger should fire
 * on the first FileChange-producing step and populate runs.baseline_tree_id.
 */

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-baseline-int-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

function writeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spool-int-repo-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function writeSession(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "spool-int-session-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function memoryBackupReader(map: Record<string, string>) {
  return async (sessionId: string, backupFileName: string) => {
    const key = `${sessionId}/${backupFileName}`;
    return map[key] !== undefined ? Buffer.from(map[key], "utf-8") : undefined;
  };
}

test("ingest with captureBaseline=true (default) sets runs.baseline_tree_id on first FileChange", async () => {
  const store = freshStore();
  const repoCwd = writeRepo({
    "src/greet.ts": "function greet() { return 'hi'; }\n",
    "README.md": "# repo\n",
  });
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-int-1", timestamp: "2026-05-15T00:00:00Z",
      cwd: repoCwd,
      message: { role: "user", content: "rename greet" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-int-1", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      snapshot: {
        messageId: "a1",
        trackedFileBackups: {
          "src/greet.ts": { backupFileName: "bak-greet" },
        },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-int-1", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_e", name: "Edit",
          input: {
            file_path: join(repoCwd, "src/greet.ts"),
            old_string: "greet",
            new_string: "hello",
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({
      "sess-int-1/bak-greet": "function greet() { return 'hi'; }\n",
    }),
  });
  assert.equal(result.file_changes_added, 1);

  const run = getRun(store, result.run_id);
  assert.ok(run);
  assert.ok(
    run!.baseline_tree_id,
    "baseline_tree_id must be populated after first FileChange",
  );
  const baseline = getBaselineTree(store, run!.baseline_tree_id!);
  assert.ok(baseline);

  // workingTreeAt(end) shows the post-edit state: src/greet.ts → "hello"
  // version, README.md untouched.
  const tree = await workingTreeAt(store, run!.run_id);
  assert.ok(tree.size >= 2);
  const greet = tree.get("src/greet.ts")!;
  assert.equal(
    await store.blobs.getString(greet.blob_ref),
    "function hello() { return 'hi'; }\n",
  );
  const readme = tree.get("README.md")!;
  assert.equal(await store.blobs.getString(readme.blob_ref), "# repo\n");
  store.close();
});

test("ingest with captureBaseline=false leaves runs.baseline_tree_id unset", async () => {
  const store = freshStore();
  const repoCwd = writeRepo({ "src/x.ts": "x\n" });
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-int-2", timestamp: "2026-05-15T00:00:00Z",
      cwd: repoCwd,
      message: { role: "user", content: "edit" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-int-2", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      snapshot: {
        messageId: "a1",
        trackedFileBackups: {
          "src/x.ts": { backupFileName: "bak-x" },
        },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-int-2", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_x", name: "Edit",
          input: {
            file_path: join(repoCwd, "src/x.ts"),
            old_string: "x", new_string: "y",
          },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({ "sess-int-2/bak-x": "x\n" }),
    captureBaseline: false, // <-- the opt-out
  });
  const run = getRun(store, result.run_id);
  assert.equal(run!.baseline_tree_id, undefined);
  // The FileChange row still landed — that's the point of the
  // opt-out: capture file changes, skip the walk.
  assert.equal(listFileChanges(store, { runId: result.run_id }).length, 1);
  store.close();
});

test("ingest with a missing cwd doesn't crash — run lands without baseline", async () => {
  // Simulates ingesting a historical session whose project dir has
  // since been deleted. captureBaseline returns undefined, the row
  // is left unset, and ingest reports steps + file_changes as usual.
  const store = freshStore();
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-int-gone", timestamp: "2026-05-15T00:00:00Z",
      cwd: "/var/spool-test-deleted/repo-that-no-longer-exists",
      message: { role: "user", content: "edit something gone" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-int-gone", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      snapshot: {
        messageId: "a1",
        trackedFileBackups: {
          "a.ts": { backupFileName: "bak-a" },
        },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-int-gone", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_a", name: "Edit",
          input: {
            file_path:
              "/var/spool-test-deleted/repo-that-no-longer-exists/a.ts",
            old_string: "X", new_string: "Y",
          },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({ "sess-int-gone/bak-a": "X\n" }),
  });
  const run = getRun(store, result.run_id);
  assert.equal(run!.baseline_tree_id, undefined);
  assert.equal(result.file_changes_added, 1);
  store.close();
});

test("baseline is captured once per run — re-ingest doesn't re-walk", async () => {
  const store = freshStore();
  const repoCwd = writeRepo({ "src/z.ts": "z\n" });
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-int-once", timestamp: "2026-05-15T00:00:00Z",
      cwd: repoCwd,
      message: { role: "user", content: "edit z" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-int-once", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      snapshot: {
        messageId: "a1",
        trackedFileBackups: {
          "src/z.ts": { backupFileName: "bak-z" },
        },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-int-once", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_z", name: "Edit",
          input: {
            file_path: join(repoCwd, "src/z.ts"),
            old_string: "z", new_string: "zzz",
          },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const reader = memoryBackupReader({ "sess-int-once/bak-z": "z\n" });
  const r1 = await ingestSession(store, path, { readBackup: reader });
  const baselineId1 = getRun(store, r1.run_id)!.baseline_tree_id;
  assert.ok(baselineId1);

  // Re-ingest: the offset has advanced past EOF, so r2 returns
  // {status:"empty"} with no work to do — and crucially, no fresh
  // baseline walk. We assert this by reading back the run via r1's id
  // (r2.run_id is "" for empty results) and confirming the baseline
  // is unchanged.
  const r2 = await ingestSession(store, path, { readBackup: reader });
  assert.equal(r2.status, "empty");
  const baselineId2 = getRun(store, r1.run_id)!.baseline_tree_id;
  assert.equal(baselineId2, baselineId1);
  store.close();
});

test("workingTreeAt(stepSeq=0) returns the baseline as captured", async () => {
  // The replay contract: `stepSeq: 0` returns the pre-step state.
  // After lazy baseline capture, that state is the snapshot of the
  // repo as it stood when the first FileChange-producing step fired.
  const store = freshStore();
  const repoCwd = writeRepo({
    "src/a.ts": "alpha\n",
    "src/b.ts": "beta\n",
  });
  const session: object[] = [
    {
      type: "user", uuid: "u1", parentUuid: null,
      sessionId: "sess-int-base", timestamp: "2026-05-15T00:00:00Z",
      cwd: repoCwd,
      message: { role: "user", content: "edit a" },
    },
    {
      type: "file-history-snapshot",
      sessionId: "sess-int-base", timestamp: "2026-05-15T00:00:00.500Z",
      messageId: "a1",
      snapshot: {
        messageId: "a1",
        trackedFileBackups: {
          "src/a.ts": { backupFileName: "bak-a" },
        },
      },
    },
    {
      type: "assistant", uuid: "a1", parentUuid: "u1",
      sessionId: "sess-int-base", timestamp: "2026-05-15T00:00:01Z",
      message: {
        role: "assistant", model: "claude-opus-4-7",
        content: [{
          type: "tool_use", id: "tu_a", name: "Edit",
          input: {
            file_path: join(repoCwd, "src/a.ts"),
            old_string: "alpha", new_string: "ALPHA",
          },
        }],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
  ];
  const path = writeSession(session);
  const result = await ingestSession(store, path, {
    readBackup: memoryBackupReader({
      "sess-int-base/bak-a": "alpha\n",
    }),
  });
  const baseline = await workingTreeAt(store, result.run_id, { stepSeq: 0 });
  assert.equal(
    await store.blobs.getString(baseline.get("src/a.ts")!.blob_ref),
    "alpha\n",
  );
  assert.equal(
    await store.blobs.getString(baseline.get("src/b.ts")!.blob_ref),
    "beta\n",
  );
  // After step 0, src/a.ts is "ALPHA"
  const after = await workingTreeAt(store, result.run_id);
  assert.equal(
    await store.blobs.getString(after.get("src/a.ts")!.blob_ref),
    "ALPHA\n",
  );
  store.close();
});
