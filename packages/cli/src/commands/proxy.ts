import { Command } from "commander";
import pc from "picocolors";
import { startProxy, type ProxyOptions } from "@spool-ai/proxy";

/**
 * `spool proxy` — long-running local LLM-API forward proxy.
 *
 * Standard usage:
 *
 *   $ spool proxy                  # listens on 127.0.0.1:8765
 *   $ ANTHROPIC_BASE_URL=http://127.0.0.1:8765 python myagent.py
 *   $ OPENAI_BASE_URL=http://127.0.0.1:8765/v1 python myagent.py
 *
 * Or use `spool run -- <command>` to auto-wire env vars in one shot.
 *
 * Each captured request becomes a Spool Step in the local store —
 * visible in `spool list` / `spool web` immediately, no extra ingest.
 */
export function registerProxyCommand(program: Command): void {
  program
    .command("proxy")
    .description("Run a local LLM-API forward proxy that captures every call as a Spool Step")
    .option("-p, --port <n>", "Port to listen on", (v) => parseInt(v, 10), 8765)
    .option("-h, --host <addr>", "Host to bind", "127.0.0.1")
    .option(
      "--project <name>",
      "Project label written to captured runs (defaults to cwd)",
    )
    .option(
      "--agent <name>",
      "Agent label written to captured runs (defaults to 'proxy')",
    )
    .option(
      "--anthropic-target <url>",
      "Override the Anthropic upstream (default: https://api.anthropic.com)",
    )
    .option(
      "--openai-target <url>",
      "Override the OpenAI upstream (default: https://api.openai.com)",
    )
    .option("--quiet", "Suppress per-request log lines")
    .action(async (opts: {
      port: number;
      host: string;
      project?: string;
      agent?: string;
      anthropicTarget?: string;
      openaiTarget?: string;
      quiet?: boolean;
    }) => {
      const proxyOpts: ProxyOptions = {
        port: opts.port,
        host: opts.host,
        spec: {
          project: opts.project ?? process.cwd(),
          agent: opts.agent ?? "proxy",
        },
        upstreams: {
          ...(opts.anthropicTarget ? { anthropic: opts.anthropicTarget } : {}),
          ...(opts.openaiTarget ? { openai: opts.openaiTarget } : {}),
        },
        logger: opts.quiet ? () => {} : (line) => console.log(pc.dim(line)),
      };
      const handle = await startProxy(proxyOpts);
      console.log(pc.green("spool proxy ready ") + pc.cyan(handle.url));
      console.log(
        pc.dim(
          "  set in your shell:\n" +
            `    export ANTHROPIC_BASE_URL=${handle.url}\n` +
            `    export OPENAI_BASE_URL=${handle.url}/v1\n` +
            "  or wrap a command with:\n" +
            `    spool run -- python myagent.py`,
        ),
      );
      console.log(pc.dim("press ctrl-c to stop"));
      const stop = async () => {
        await handle.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
}
