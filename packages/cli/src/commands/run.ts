import { spawn } from "node:child_process";
import net from "node:net";
import { Command } from "commander";
import pc from "picocolors";
import { startProxy } from "@spool-ai/proxy";

/**
 * `spool run -- <command...>` — one-command zero-instrumentation capture.
 *
 * Spawns a short-lived proxy on a free port, sets ANTHROPIC_BASE_URL +
 * OPENAI_BASE_URL in the child process's env, runs the user command,
 * and tears the proxy down on exit. Useful for one-shot scripts:
 *
 *   $ spool run -- python myagent.py
 *   $ spool run --project my-app -- node agent.js
 *   $ spool run -- npx tsx mything.ts
 *
 * Anything after `--` is the user command + its args. stdin/stdout/
 * stderr are inherited from the parent so the child looks unchanged.
 *
 * Exit code mirrors the child's. SIGINT to the parent gracefully
 * shuts down both the child and the proxy.
 */
export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a command with the Spool proxy auto-wired (zero code change capture)")
    .allowUnknownOption(true)
    .option("--port <n>", "Pin the proxy to a port (default: random free port)", (v) => parseInt(v, 10))
    .option(
      "--project <name>",
      "Project label written to captured runs (defaults to cwd)",
    )
    .option(
      "--agent <name>",
      "Agent label written to captured runs (defaults to 'proxy')",
    )
    .option("--quiet", "Suppress per-request capture log lines")
    .option(
      "--no-openai",
      "Don't set OPENAI_BASE_URL (only proxy Anthropic calls)",
    )
    .option(
      "--no-anthropic",
      "Don't set ANTHROPIC_BASE_URL (only proxy OpenAI calls)",
    )
    .option(
      "--anthropic-target <url>",
      "Override the Anthropic upstream (default: https://api.anthropic.com)",
    )
    .option(
      "--openai-target <url>",
      "Override the OpenAI upstream (default: https://api.openai.com)",
    )
    .action(async (
      opts: {
        port?: number;
        project?: string;
        agent?: string;
        quiet?: boolean;
        openai: boolean;
        anthropic: boolean;
        anthropicTarget?: string;
        openaiTarget?: string;
      },
      cmd: Command,
    ) => {
      // Commander hands us everything after `--` in `cmd.args`.
      // Older commander versions stuff it into `program.args` instead;
      // accept both and refuse if empty.
      const userArgs = collectUserArgs(cmd);
      if (userArgs.length === 0) {
        console.error(
          pc.red("spool run: missing command. Usage: spool run -- <command> [args]"),
        );
        process.exit(2);
      }

      const port = opts.port ?? (await pickFreePort());
      const handle = await startProxy({
        port,
        spec: {
          project: opts.project ?? process.cwd(),
          agent: opts.agent ?? "proxy",
        },
        upstreams: {
          ...(opts.anthropicTarget ? { anthropic: opts.anthropicTarget } : {}),
          ...(opts.openaiTarget ? { openai: opts.openaiTarget } : {}),
        },
        logger: opts.quiet ? () => {} : (line) => process.stderr.write(pc.dim(`[spool] ${line}\n`)),
      });

      const childEnv = { ...process.env };
      if (opts.anthropic !== false) {
        childEnv.ANTHROPIC_BASE_URL = handle.url;
      }
      if (opts.openai !== false) {
        // OpenAI's SDK convention includes /v1 in the base URL (the SDK
        // doesn't append it). Anthropic's SDK does append /v1 itself,
        // so we leave the base bare.
        childEnv.OPENAI_BASE_URL = handle.url + "/v1";
      }

      if (!opts.quiet) {
        process.stderr.write(
          pc.dim(
            `[spool] proxy ${handle.url} → spawning: ${userArgs.join(" ")}\n`,
          ),
        );
      }

      const [bin, ...rest] = userArgs;
      const child = spawn(bin!, rest, {
        env: childEnv,
        stdio: "inherit",
      });

      const shutdown = async (code: number) => {
        await handle.close();
        process.exit(code);
      };

      let signaled = false;
      const onSig = (sig: NodeJS.Signals) => {
        if (signaled) return;
        signaled = true;
        // Forward the signal to the child; the close handler below will
        // tear down the proxy once the child actually exits.
        try {
          child.kill(sig);
        } catch {
          // ignore
        }
      };
      process.on("SIGINT", () => onSig("SIGINT"));
      process.on("SIGTERM", () => onSig("SIGTERM"));

      child.on("exit", (code, signal) => {
        // small grace period so any in-flight capture writes finish
        // (the proxy fires capture asynchronously after returning the
        // response to the client; the child has already moved on).
        setTimeout(() => {
          if (!opts.quiet) {
            process.stderr.write(
              pc.dim(
                `[spool] child exited ${code ?? `(signal ${signal})`} — proxy stopping\n`,
              ),
            );
          }
          void shutdown(code ?? (signal ? 130 : 0));
        }, 250);
      });
      child.on("error", (err) => {
        process.stderr.write(pc.red(`spool run: failed to spawn child: ${err.message}\n`));
        void shutdown(127);
      });
    });
}

function collectUserArgs(cmd: Command): string[] {
  // Prefer cmd.args (the args parsed for this subcommand); fall back to
  // process.argv heuristic for safety.
  if (cmd.args && cmd.args.length > 0) return cmd.args.slice();
  const dashIdx = process.argv.indexOf("--");
  if (dashIdx >= 0) return process.argv.slice(dashIdx + 1);
  return [];
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate free port")));
      }
    });
    srv.on("error", reject);
  });
}
