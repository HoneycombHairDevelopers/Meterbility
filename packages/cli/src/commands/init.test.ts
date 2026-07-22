import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeHooks } from "./init.ts";

/**
 * `meter init --hooks` mutates the user's `.claude/settings.json` —
 * the one file where a bug corrupts their Claude Code configuration.
 * These tests pin the install/merge/refusal contract directly against
 * the exported helper.
 */

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "meter-init-hooks-"));
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, ".claude", "settings.json"), "utf-8"),
  ) as Record<string, unknown>;
}

test("init --hooks: fresh install writes both matcher groups", async () => {
  const root = freshRoot();
  try {
    const result = await installClaudeHooks(root);
    assert.equal(result, "installed");
    const s = readSettings(root) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };
    for (const [event, phase] of [
      ["PreToolUse", "pre"],
      ["PostToolUse", "post"],
    ] as const) {
      assert.equal(s.hooks[event]!.length, 1);
      assert.equal(s.hooks[event]![0]!.matcher, "Bash");
      assert.deepEqual(s.hooks[event]![0]!.hooks, [
        { type: "command", command: `meter capture ${phase}` },
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --hooks: idempotent, including after a meter-dev rewrite", async () => {
  const root = freshRoot();
  try {
    await installClaudeHooks(root);
    // Second run — nothing added.
    assert.equal(await installClaudeHooks(root), "already-present");
    // User pointed the commands at a dev shim (the checklist flow);
    // idempotency keys on the capture subcommand, not the binary name.
    const path = join(root, ".claude", "settings.json");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replaceAll("meter capture", "meter-dev capture"),
    );
    assert.equal(await installClaudeHooks(root), "already-present");
    const s = readSettings(root) as { hooks: Record<string, unknown[]> };
    assert.equal(s.hooks.PreToolUse!.length, 1, "no duplicate groups");
    assert.equal(s.hooks.PostToolUse!.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --hooks: preserves unrelated settings and existing hooks", async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(ls*)"] },
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "my-linter --fix" }],
          },
        ],
      },
    };
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify(existing, null, 2),
    );

    assert.equal(await installClaudeHooks(root), "installed");
    const s = readSettings(root) as {
      permissions: unknown;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    assert.deepEqual(s.permissions, existing.permissions, "unrelated keys kept");
    // The user's Edit hook survives; ours is appended alongside it.
    const postCommands = s.hooks.PostToolUse!.flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(postCommands.includes("my-linter --fix"));
    assert.ok(postCommands.includes("meter capture post"));
    assert.equal(s.hooks.PreToolUse!.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --hooks: refuses to touch a malformed settings.json", async () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const path = join(root, ".claude", "settings.json");
    const garbage = '{ "hooks": [unclosed';
    writeFileSync(path, garbage);

    const result = await installClaudeHooks(root);
    assert.equal(result, "already-present"); // skipped, not clobbered
    assert.equal(
      readFileSync(path, "utf-8"),
      garbage,
      "malformed file left byte-for-byte untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --hooks: refuses unexpected shapes (valid JSON, wrong structure)", async () => {
  // Valid JSON that isn't the shape we understand must get the same
  // refuse-and-warn treatment as malformed JSON — never crash, never
  // silently rewrite (a top-level array would serialize back empty).
  for (const content of [
    '{"hooks": []}', // hooks as array
    '{"hooks": {"PreToolUse": {}}}', // event as object
    '["not", "an", "object"]', // top-level array
  ]) {
    const root = freshRoot();
    try {
      mkdirSync(join(root, ".claude"), { recursive: true });
      const path = join(root, ".claude", "settings.json");
      writeFileSync(path, content);
      const result = await installClaudeHooks(root);
      assert.equal(result, "already-present", `refused for: ${content}`);
      assert.equal(
        readFileSync(path, "utf-8"),
        content,
        `file untouched for: ${content}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
