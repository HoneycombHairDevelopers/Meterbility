import type { Command } from "commander";
import pc from "picocolors";
import {
  handleCursorHookEvent,
  type CursorHookPayload,
} from "@meterbility/cursor-adapter";
import { openStore } from "../util.ts";

/**
 * `meter cursor-hook` — Cursor Hooks entry point (Cursor ≥1.7).
 *
 * Configured in ~/.cursor/hooks.json (or a project's .cursor/hooks.json):
 *
 *   {
 *     "version": 1,
 *     "hooks": {
 *       "afterFileEdit":        [{ "command": "meter cursor-hook" }],
 *       "beforeShellExecution": [{ "command": "meter cursor-hook" }],
 *       "stop":                 [{ "command": "meter cursor-hook" }]
 *     }
 *   }
 *
 * Cursor sends the event payload on stdin (JSON) with hook_event_name
 * discriminating; conversation_id is the composerId, which joins hook
 * captures to DB-ingested runs.
 *
 * Contract: NEVER block the agent. beforeShellExecution always answers
 * {"continue": true, "permission": "allow"}; every failure path exits 0.
 */
export function registerCursorHookCommand(program: Command): void {
  program
    .command("cursor-hook")
    .description(
      "Cursor Hooks entry point: capture file edits, shell commands, and run completion (reads the event from stdin)",
    )
    .option("--json", "Print a JSON summary of what was captured to stderr")
    .action(async (opts: { json?: boolean }) => {
      try {
        const payload = await readStdinJson();
        const store = openStore();
        try {
          const res = await handleCursorHookEvent(store, payload);
          // before* events expect a JSON permission response on stdout.
          if (res.response) {
            process.stdout.write(JSON.stringify(res.response) + "\n");
          }
          if (opts.json) {
            process.stderr.write(JSON.stringify(res) + "\n");
          }
        } finally {
          store.close();
        }
      } catch (err) {
        // Capture must never break the user's Cursor session.
        console.error(
          pc.red(`meter cursor-hook: ${(err as Error).message}`),
        );
        // Fail open for permission-gated events.
        process.stdout.write(
          JSON.stringify({ continue: true, permission: "allow" }) + "\n",
        );
      }
      process.exitCode = 0;
    });
}

async function readStdinJson(): Promise<CursorHookPayload> {
  if (process.stdin.isTTY) return {};
  const read = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  })();
  const text = await Promise.race([
    read,
    new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve(""), 5_000);
      t.unref?.();
    }),
  ]);
  if (!text) return {};
  try {
    return JSON.parse(text) as CursorHookPayload;
  } catch {
    return {};
  }
}
