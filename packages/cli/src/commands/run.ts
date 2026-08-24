import { spawn } from "node:child_process";
import net from "node:net";
import { Command } from "commander";
import pc from "picocolors";
import { startProxy, type ProviderInput } from "@meterbility/proxy";
import { makeUpstreamCollector } from "../upstream-option.ts";

/**
 * `meter run -- <command...>` — one-command zero-instrumentation capture.
 *
 * Spawns a short-lived proxy on a free port, sets ANTHROPIC_BASE_URL +
 * OPENAI_BASE_URL in the child process's env, runs the user command,
 * and tears the proxy down on exit. Useful for one-shot scripts:
 *
 *   $ meter run -- python myagent.py
 *   $ meter run --project my-app -- node agent.js
 *   $ meter run -- npx tsx mything.ts
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
    .description("Run a command with the Meterbility proxy auto-wired (zero code change capture)")
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
      "Re-point the anthropic provider (default: https://api.anthropic.com)",
    )
    .option(
      "--openai-target <url>",
      "Re-point the openai provider (default: https://api.openai.com)",
    )
    .option(
      "--upstream <name[:dialect]=url>",
      "Register a named provider and wire its env var (repeatable; at most one per dialect here — env vars are singular). Example: --upstream nvidia=https://integrate.api.nvidia.com",
      makeUpstreamCollector("meter run"),
      [] as ProviderInput[],
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
        upstream: ProviderInput[];
      },
      cmd: Command,
    ) => {
      // Commander hands us everything after `--` in `cmd.args`.
      // Older commander versions stuff it into `program.args` instead;
      // accept both and refuse if empty.
      const userArgs = collectUserArgs(cmd);
      if (userArgs.length === 0) {
        console.error(
          pc.red("meter run: missing command. Usage: meter run -- <command> [args]"),
        );
        process.exit(2);
      }

      // Env vars are singular per dialect (one OPENAI_BASE_URL), so
      // `meter run` can wire at most one named upstream per dialect.
      // Concurrent same-dialect providers still work via `meter proxy`
      // with hand-set client env — this wrapper just can't express it.
      for (const dialect of ["openai", "anthropic"] as const) {
        const sameDialect = opts.upstream.filter((u) => u.dialect === dialect);
        if (sameDialect.length > 1) {
          console.error(
            pc.red(
              `meter run: ${sameDialect.length} ${dialect}-dialect upstreams (${sameDialect
                .map((u) => u.name)
                .join(", ")}) but ${
                dialect === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"
              } can only point at one. Use \`meter proxy --upstream ...\` and set client env vars yourself for concurrent same-dialect capture.`,
            ),
          );
          process.exit(2);
        }
      }

      const port = opts.port ?? (await pickFreePort());
      let handle;
      try {
        handle = await startProxy({
          port,
          spec: {
            project: opts.project ?? process.cwd(),
            agent: opts.agent ?? "proxy",
          },
          upstreams: {
            ...(opts.anthropicTarget ? { anthropic: opts.anthropicTarget } : {}),
            ...(opts.openaiTarget ? { openai: opts.openaiTarget } : {}),
          },
          providers: opts.upstream,
          logger: opts.quiet ? () => {} : (line) => process.stderr.write(pc.dim(`[meter] ${line}\n`)),
        });
      } catch (err) {
        console.error(pc.red(`meter run: ${(err as Error).message}`));
        process.exit(2);
      }

      const childEnv = { ...process.env };
      // Named upstreams win their dialect's env var over the bare
      // default; --no-openai/--no-anthropic suppress default-provider
      // wiring only, never a named upstream the user asked for.
      const namedAnthropic = opts.upstream.find((u) => u.dialect === "anthropic");
      const namedOpenai = opts.upstream.find((u) => u.dialect === "openai");
      if (namedAnthropic) {
        // Anthropic's SDK appends /v1 itself — base stays bare.
        childEnv.ANTHROPIC_BASE_URL = `${handle.url}/${namedAnthropic.name}`;
      } else if (opts.anthropic !== false) {
        childEnv.ANTHROPIC_BASE_URL = handle.url;
      }
      if (namedOpenai) {
        // OpenAI's SDK convention includes /v1 in the base URL (the SDK
        // doesn't append it).
        childEnv.OPENAI_BASE_URL = `${handle.url}/${namedOpenai.name}/v1`;
      } else if (opts.openai !== false) {
        childEnv.OPENAI_BASE_URL = handle.url + "/v1";
      }

      if (!opts.quiet) {
        process.stderr.write(
          pc.dim(
            `[meter] proxy ${handle.url} → spawning: ${userArgs.join(" ")}\n`,
          ),
        );
        // meter-live design §6: capture just started — this is the
        // exact moment an attach hint is useful. run is excluded from
        // the generic pre-command nudge (child-stdio purity); this
        // line is its replacement, on stderr like the other [meter]
        // chrome, silenced by --quiet.
        process.stderr.write(
          pc.dim(`[meter] capture live — \`meter live\` in another terminal to watch\n`),
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
                `[meter] child exited ${code ?? `(signal ${signal})`} — proxy stopping\n`,
              ),
            );
          }
          void shutdown(code ?? (signal ? 130 : 0));
        }, 250);
      });
      child.on("error", (err) => {
        process.stderr.write(pc.red(`meter run: failed to spawn child: ${err.message}\n`));
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
