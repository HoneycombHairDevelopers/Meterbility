import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import type { ForkEdit, ForkEditType } from "@spool/shared";
import { forkRun, anthropicResponder, fakeResponder } from "@spool/server";
import { openStore } from "../util.ts";

const EDIT_TYPES: ForkEditType[] = [
  "replace_system_prompt",
  "add_context",
  "remove_tool",
  "modify_tool_description",
  "replace_user_message",
  "inject_message",
  "change_model",
];

export function registerForkCommand(program: Command): void {
  program
    .command("fork <run-id>")
    .description("Replay a run with an edit applied at a chosen step")
    .requiredOption(
      "--at <seq-or-step-id>",
      "Sequence index or step id to fork from",
    )
    .requiredOption(
      "--edit <type>",
      `Edit type (${EDIT_TYPES.join("|")})`,
    )
    .option(
      "--payload <json>",
      "Edit payload as JSON (string or object)",
    )
    .option("--payload-file <path>", "Read payload from a file (treated as text)")
    .option("--text <string>", "Shortcut: set payload to { text: <string> }")
    .option(
      "--live",
      "Run a live model call for the suffix step (requires ANTHROPIC_API_KEY)",
    )
    .option("--live-model <model>", "Model for live suffix", "claude-opus-4-7")
    .option("--fake <text>", "Use a fake responder that emits the given text")
    .action(async (
      runId: string,
      opts: {
        at: string;
        edit: string;
        payload?: string;
        payloadFile?: string;
        text?: string;
        live?: boolean;
        liveModel?: string;
        fake?: string;
      },
    ) => {
      if (!EDIT_TYPES.includes(opts.edit as ForkEditType)) {
        throw new Error(
          `unsupported edit type: ${opts.edit}\nallowed: ${EDIT_TYPES.join(", ")}`,
        );
      }
      const edit: ForkEdit = {
        type: opts.edit as ForkEditType,
        payload: await resolvePayload(opts),
      };
      const responder = opts.fake
        ? fakeResponder(opts.fake)
        : opts.live
          ? buildAnthropicResponder(opts.liveModel ?? "claude-opus-4-7")
          : undefined;
      const store = openStore();
      try {
        const at = Number.isFinite(Number(opts.at))
          ? Number(opts.at)
          : opts.at;
        const result = await forkRun(
          store,
          {
            origin_run_id: runId,
            at,
            edit,
          },
          responder,
        );
        console.log(pc.bold("\nfork created"));
        console.log(`  ${pc.dim("fork_id")}      ${result.fork_id}`);
        console.log(`  ${pc.dim("fork_run_id")}  ${result.fork_run_id}`);
        console.log(`  ${pc.dim("prefix")}       ${result.prefix_steps} steps`);
        console.log(
          `  ${pc.dim("suffix")}       ${result.live ? pc.green("live step appended") : pc.yellow("none — use --live or --fake to extend")}`,
        );
        console.log(
          pc.dim(
            `\nopen with:  spool inspect ${result.fork_run_id.slice(0, 12)}` +
              `\ndiff vs origin:  spool diff ${runId.slice(0, 12)} ${result.fork_run_id.slice(0, 12)}`,
          ),
        );
      } finally {
        store.close();
      }
    });
}

async function resolvePayload(opts: {
  payload?: string;
  payloadFile?: string;
  text?: string;
}): Promise<unknown> {
  if (opts.text !== undefined) return { text: opts.text };
  if (opts.payloadFile) {
    const buf = await readFile(opts.payloadFile, "utf-8");
    try {
      return JSON.parse(buf);
    } catch {
      return { text: buf };
    }
  }
  if (opts.payload) {
    try {
      return JSON.parse(opts.payload);
    } catch {
      return { text: opts.payload };
    }
  }
  return null;
}

function buildAnthropicResponder(model: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "--live requires ANTHROPIC_API_KEY in the environment",
    );
  }
  return (() => {
    // Lazy: build responder inside the call so we don't load the SDK
    // until a fork actually wants live suffix.
    return async (args: import("@spool/server").LiveResponderArgs) => {
      const { Store } = await import("@spool/collector");
      const store = Store.open();
      try {
        const fn = anthropicResponder(store, { apiKey, model });
        return fn(args);
      } finally {
        store.close();
      }
    };
  })();
}
