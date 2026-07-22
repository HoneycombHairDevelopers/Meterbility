import { Command } from "commander";
import pc from "picocolors";
import {
  capturePre,
  capturePost,
  drainStash,
  type HookPayload,
} from "@meterbility/server";
import { openStore } from "../util.ts";

/**
 * `meter capture` — the Claude Code hook entry point for exact file
 * capture (v0.4). Installed by `meter init --hooks` as:
 *
 *   PreToolUse(Bash)  → meter capture pre
 *   PostToolUse(Bash) → meter capture post
 *
 * Claude Code delivers the hook payload as JSON on stdin; we read it,
 * run the pre/post scan (see @meterbility/server hook_capture.ts), and
 * ALWAYS exit 0 — a capture failure must never degrade the user's
 * agent session. Errors go to stderr for `claude --debug` visibility.
 *
 * `meter capture drain` retries attribution for stashed observations
 * without a hook payload — useful after the fact if a session's
 * transcript lagged past the hook invocations.
 */
export function registerCaptureCommand(program: Command): void {
  program
    .command("capture <phase>")
    .description(
      "Claude Code hook entry point: capture file side effects around a tool call (pre|post|drain)",
    )
    .option("--json", "Print a JSON summary of what was captured")
    .action(async (phase: string, opts: { json?: boolean }) => {
      if (phase !== "pre" && phase !== "post" && phase !== "drain") {
        console.error(
          pc.red(`meter capture: unknown phase "${phase}" (want pre|post|drain)`),
        );
        process.exit(2);
      }
      try {
        const payload: HookPayload =
          phase === "drain" ? {} : await readStdinJson();
        const store = openStore();
        try {
          if (phase === "pre") {
            const res = await capturePre(store, payload);
            if (opts.json) process.stdout.write(JSON.stringify(res) + "\n");
          } else if (phase === "post") {
            const res = await capturePost(store, payload);
            if (opts.json) process.stdout.write(JSON.stringify(res) + "\n");
          } else {
            const res = await drainStash(store);
            if (opts.json) {
              process.stdout.write(JSON.stringify(res) + "\n");
            } else {
              console.log(
                `drained ${res.inserted.length} change${res.inserted.length === 1 ? "" : "s"}` +
                  (res.pending > 0 ? `, ${res.pending} still pending` : "") +
                  (res.expired > 0 ? `, ${res.expired} expired` : ""),
              );
            }
          }
        } finally {
          store.close();
        }
      } catch (err) {
        // Never block the agent: report and exit clean.
        console.error(`meter capture ${phase}: ${String(err)}`);
      }
      process.exit(0);
    });
}

/** Read the hook payload Claude Code pipes to stdin. An empty or
 *  non-JSON stdin (e.g. manual invocation) yields an empty payload —
 *  capture then falls back to process.cwd() with no attribution. */
async function readStdinJson(): Promise<HookPayload> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as HookPayload;
  } catch {
    return {};
  }
}
