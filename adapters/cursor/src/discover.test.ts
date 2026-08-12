import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceCwdById } from "./discover.ts";

function freshUserDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-user-neg-"));
  process.env.CURSOR_USER_DIR = dir;
  return dir;
}

test("workspaceCwdById negative paths degrade to undefined", async () => {
  const userDir = freshUserDir();
  try {
    // No workspaceStorage dir at all.
    assert.equal(await workspaceCwdById("nope"), undefined);

    // Workspace dir exists but no workspace.json (ephemeral window).
    mkdirSync(join(userDir, "workspaceStorage", "ws-empty"), { recursive: true });
    assert.equal(await workspaceCwdById("ws-empty"), undefined);

    // Malformed workspace.json.
    const bad = join(userDir, "workspaceStorage", "ws-bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "workspace.json"), "{not json");
    assert.equal(await workspaceCwdById("ws-bad"), undefined);

    // folder present but not a string.
    const wrong = join(userDir, "workspaceStorage", "ws-wrong");
    mkdirSync(wrong, { recursive: true });
    writeFileSync(join(wrong, "workspace.json"), JSON.stringify({ folder: 42 }));
    assert.equal(await workspaceCwdById("ws-wrong"), undefined);
  } finally {
    delete process.env.CURSOR_USER_DIR;
  }
});

test("workspaceCwdById decodes file:// URIs and passes through non-URI folders", async () => {
  const userDir = freshUserDir();
  try {
    const enc = join(userDir, "workspaceStorage", "ws-enc");
    mkdirSync(enc, { recursive: true });
    writeFileSync(
      join(enc, "workspace.json"),
      JSON.stringify({ folder: "file:///tmp/my%20project" }),
    );
    assert.equal(await workspaceCwdById("ws-enc"), "/tmp/my project");

    const plain = join(userDir, "workspaceStorage", "ws-plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(plain, "workspace.json"),
      JSON.stringify({ folder: "/tmp/plain-path" }),
    );
    assert.equal(await workspaceCwdById("ws-plain"), "/tmp/plain-path");
  } finally {
    delete process.env.CURSOR_USER_DIR;
  }
});
