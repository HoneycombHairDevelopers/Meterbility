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
 * Contract: NEVER block the agent. Every before* event (and any event
 * we can't identify because the payload was empty/unparseable) is
 * answered with {"continue": true} on stdout BEFORE any persistence
 * work runs — capture is an observer and doesn't vote (no `permission`
 * field; Cursor's own approval flow decides). Every failure path exits 0.
 */
export function registerCursorHookCommand(program: Command): void {
  program
    .command("cursor-hook")
    .description(
      "Cursor Hooks entry point: capture file edits, shell commands, and run completion (reads the event from stdin)",
    )
    .option("--json", "Print a JSON summary of what was captured to stderr")
    .action(async (opts: { json?: boolean }) => {
      const respond = (): void => {
        process.stdout.write(JSON.stringify({ continue: true }) + "\n");
      };
      let responded = false;
      try {
        const payload = await readStdinJson();
        const event = payload.hook_event_name;
        // Fail-open FIRST: Cursor blocks the agent on stdout for
        // permission-gated (before*) events. Respond before touching
        // the store so a capture failure or stall can never leave the
        // agent hanging. An unknown/empty payload might be a before*
        // event whose body we couldn't parse — respond for those too.
        if (!event || event.startsWith("before")) {
          respond();
          responded = true;
        }
        const store = openStore();
        try {
          // Capture only — the fail-open response already went out.
          const res = await handleCursorHookEvent(store, payload);
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
        // Fail open for permission-gated events (unless already sent).
        if (!responded) respond();
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
  })().catch(() => "");
  const text = await Promise.race([
    read,
    new Promise<string>((resolve) => {
      const t = setTimeout(() => {
        // Destroy stdin so the open stream can't keep the process
        // alive after the timeout fires — the hook must actually exit.
        process.stdin.destroy();
        resolve("");
      }, 5_000);
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
