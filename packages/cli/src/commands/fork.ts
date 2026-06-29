import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import type { ForkEdit, ForkEditType } from "@meterbility/shared";
import {
  forkRun,
  anthropicResponder,
  continueFork,
  fakeResponder,
  type ContinuationModelCaller,
  type ToolExecutor,
} from "@meterbility/server";
import { getSetting } from "@meterbility/collector";
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
    .option(
      "--continue <mode>",
      "After the first suffix step, continue the agent loop. Values: simulate (use original tool results) | live (caller-provided executor; CLI supports bash-only safe mode)",
    )
    .option(
      "--max-iterations <n>",
      "Cap continuation loop iterations",
      (v) => parseInt(v, 10),
      25,
    )
    .option(
      "--allow-tool <name>",
      "(live continuation) Tools the executor will run. Repeatable.",
      (v: string, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
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
        continue?: string;
        maxIterations: number;
        allowTool: string[];
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
      const store = openStore();
      // Settings fallback: --live-model and --max-iterations both fall back
      // to the settings table when the user didn't explicitly pass them.
      const flagModel =
        opts.liveModel && opts.liveModel !== "claude-opus-4-7"
          ? opts.liveModel
          : undefined;
      const liveModelEffective =
        flagModel ??
        getSetting(store, "fork.default_model") ??
        "claude-opus-4-7";
      const maxIterFromSetting = getSetting(
        store,
        "fork.default_max_iterations",
      );
      const maxIterationsEffective =
        opts.maxIterations !== 25
          ? opts.maxIterations
          : maxIterFromSetting
            ? parseInt(maxIterFromSetting, 10) || opts.maxIterations
            : opts.maxIterations;
      const responder = opts.fake
        ? fakeResponder(opts.fake)
        : opts.live
          ? buildAnthropicResponder(liveModelEffective)
          : undefined;
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

        // Optional multi-step continuation.
        if (opts.continue) {
          if (opts.continue !== "simulate" && opts.continue !== "live") {
            throw new Error(
              `unknown --continue mode: ${opts.continue}\nallowed: simulate, live`,
            );
          }
          if (opts.continue === "live" && !process.env.ANTHROPIC_API_KEY) {
            throw new Error(
              "--continue=live requires ANTHROPIC_API_KEY for the model loop",
            );
          }
          const modelCaller = buildContinuationCaller(liveModelEffective);
          const cont = await continueFork(store, result.fork_run_id, {
            mode: opts.continue,
            modelCaller,
            toolExecutor:
              opts.continue === "live"
                ? buildBashOnlyExecutor(opts.allowTool)
                : undefined,
            maxIterations: maxIterationsEffective,
            originRunId: runId,
          });
          console.log(pc.bold("\ncontinuation"));
          console.log(`  ${pc.dim("mode")}         ${opts.continue}`);
          console.log(`  ${pc.dim("iterations")}   ${cont.iterations_run}`);
          console.log(`  ${pc.dim("steps added")}  ${cont.steps_added}`);
          console.log(
            `  ${pc.dim("terminal")}     ${terminalColor(cont.terminal_reason)}`,
          );
        }

        console.log(
          pc.dim(
            `\nopen with:  meter inspect ${result.fork_run_id.slice(0, 12)}` +
              `\ndiff vs origin:  meter diff ${runId.slice(0, 12)} ${result.fork_run_id.slice(0, 12)}`,
          ),
        );
      } finally {
        store.close();
      }
    });
}

function terminalColor(reason: string): string {
  switch (reason) {
    case "model_completed":
      return pc.green(reason);
    case "max_iterations":
      return pc.yellow(reason);
    case "simulate_miss":
      return pc.yellow(reason);
    case "tool_error":
    case "model_error":
      return pc.red(reason);
    default:
      return reason;
  }
}

function buildContinuationCaller(model: string): ContinuationModelCaller {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return async (args) => {
    if (!apiKey) {
      // For dry runs (no key), emit a trivial completion so simulate mode
      // can still demonstrate the loop's structure without spending money.
      return {
        model: "dry-run",
        decision_content: [
          { type: "text", text: "(dry run — set ANTHROPIC_API_KEY for live continuation)" },
        ],
        action: { kind: "message", text: "(dry run)" },
        tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
        latency_ms: 0,
      };
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { Store } = await import("@meterbility/collector");
    const store = Store.open();
    try {
      const client = new Anthropic({ apiKey });
      // Resolve content_refs to actual text for the API call.
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const m of args.history) {
        if (m.role === "tool") continue; // tool turns are summarized into the assistant's prior message
        const text = await store.blobs.tryGetString(m.content_ref);
        if (text) messages.push({ role: m.role, content: text });
      }
      const t0 = Date.now();
      const resp = await client.messages.create({
        model,
        max_tokens: 4096,
        system: args.system_prompt,
        messages: messages.length
          ? messages
          : [{ role: "user", content: "(no history)" }],
      });
      const t1 = Date.now();
      const blocks = resp.content ?? [];
      const toolUse = blocks.find(
        (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          b.type === "tool_use",
      );
      const text = blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const cc = (resp.usage as
        | {
            cache_creation?: {
              ephemeral_5m_input_tokens?: number;
              ephemeral_1h_input_tokens?: number;
            };
          }
        | undefined)?.cache_creation;
      const tokens5m = cc
        ? cc.ephemeral_5m_input_tokens ?? 0
        : (resp.usage?.cache_creation_input_tokens ?? 0);
      const tokens1h = cc?.ephemeral_1h_input_tokens ?? 0;
      return {
        model: resp.model,
        decision_content: resp.content,
        action: toolUse
          ? {
              kind: "tool_call",
              tool_name: toolUse.name,
              tool_use_id: toolUse.id,
              tool_input: toolUse.input,
            }
          : { kind: "message", text },
        tokens: {
          input: resp.usage?.input_tokens ?? 0,
          output: resp.usage?.output_tokens ?? 0,
          cached_read: resp.usage?.cache_read_input_tokens ?? 0,
          cache_creation: tokens5m,
          cache_creation_1h: tokens1h,
        },
        latency_ms: t1 - t0,
      };
    } finally {
      store.close();
    }
  };
}

function buildBashOnlyExecutor(allowList: string[]): ToolExecutor {
  // Safe-by-default: refuse to run any tool unless explicitly opted-in via
  // --allow-tool. Even "allowed" tools that aren't Bash get a placeholder
  // response so the loop continues, but we never run arbitrary shell.
  const allowSet = new Set(allowList);
  return async (call) => {
    if (!allowSet.has(call.tool_name)) {
      return {
        output: {
          meter_note: `tool '${call.tool_name}' not in --allow-tool set; skipped`,
        },
        is_error: false,
        summary: `skipped (not allowed): ${call.tool_name}`,
      };
    }
    if (call.tool_name === "Bash") {
      const input = call.tool_input as { command?: string } | undefined;
      const cmd = input?.command;
      if (!cmd || typeof cmd !== "string") {
        return {
          output: { error: "missing command" },
          is_error: true,
          summary: "missing command",
        };
      }
      // Hard refuse anything destructive-looking.
      if (/\brm\s+-[rRfF]|sudo\b|mkfs|dd\s+if=|--no-verify|>\s*\/dev\/sd/.test(cmd)) {
        return {
          output: { error: "command rejected as destructive" },
          is_error: true,
          summary: "destructive command rejected",
        };
      }
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("bash", ["-lc", cmd], {
        encoding: "utf-8",
        timeout: 30_000,
      });
      return {
        output: {
          stdout: r.stdout?.slice(0, 8_000) ?? "",
          stderr: r.stderr?.slice(0, 2_000) ?? "",
          exit_code: r.status,
        },
        is_error: (r.status ?? 0) !== 0,
        summary: (r.stdout?.split("\n")[0] ?? "").slice(0, 200),
      };
    }
    // Allowed but unhandled — return a no-op so the loop can continue.
    return {
      output: { meter_note: `tool '${call.tool_name}' has no live executor; no-op` },
      is_error: false,
      summary: `no-op: ${call.tool_name}`,
    };
  };
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
    return async (args: import("@meterbility/server").LiveResponderArgs) => {
      const { Store } = await import("@meterbility/collector");
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
