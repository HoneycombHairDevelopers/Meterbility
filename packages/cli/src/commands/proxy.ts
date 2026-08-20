import { Command } from "commander";
import pc from "picocolors";
import {
  startProxy,
  type ProviderInput,
  type ProxyOptions,
} from "@meterbility/proxy";
import { makeUpstreamCollector } from "../upstream-option.ts";

/**
 * `meter proxy` — long-running local LLM-API forward proxy.
 *
 * Standard usage:
 *
 *   $ meter proxy                  # listens on 127.0.0.1:8765
 *   $ ANTHROPIC_BASE_URL=http://127.0.0.1:8765 python myagent.py
 *   $ OPENAI_BASE_URL=http://127.0.0.1:8765/v1 python myagent.py
 *
 * Named upstreams — any OpenAI- or Anthropic-dialect host, concurrent
 * on one port, each behind its own provider-prefixed base URL:
 *
 *   $ meter proxy --upstream nvidia=https://integrate.api.nvidia.com
 *   $ OPENAI_BASE_URL=http://127.0.0.1:8765/nvidia/v1 python myagent.py
 *
 * Or use `meter run -- <command>` to auto-wire env vars in one shot.
 *
 * Each captured request becomes a Meterbility Step in the local store —
 * visible in `meter list` / `meter web` immediately, no extra ingest.
 */
export function registerProxyCommand(program: Command): void {
  program
    .command("proxy")
    .description("Run a local LLM-API forward proxy that captures every call as a Meterbility Step")
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
      "Re-point the anthropic provider (bare + /anthropic/... aliases both follow; default: https://api.anthropic.com)",
    )
    .option(
      "--openai-target <url>",
      "Re-point the openai provider (bare + /openai/... aliases both follow; default: https://api.openai.com)",
    )
    .option(
      "--upstream <name[:dialect]=url>",
      "Register a named provider (repeatable). Dialect: openai (default) or anthropic. Example: --upstream nvidia=https://integrate.api.nvidia.com",
      makeUpstreamCollector("meter proxy"),
      [] as ProviderInput[],
    )
    .option("--quiet", "Suppress per-request log lines")
    .action(async (opts: {
      port: number;
      host: string;
      project?: string;
      agent?: string;
      anthropicTarget?: string;
      openaiTarget?: string;
      upstream: ProviderInput[];
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
        providers: opts.upstream,
        logger: opts.quiet ? () => {} : (line) => console.log(pc.dim(line)),
      };
      let handle;
      try {
        handle = await startProxy(proxyOpts);
      } catch (err) {
        console.error(pc.red(`meter proxy: ${(err as Error).message}`));
        process.exit(2);
      }
      console.log(pc.green("meter proxy ready ") + pc.cyan(handle.url));
      const namedLines = opts.upstream
        .map(
          (p) =>
            `    export ${p.dialect === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"}=${handle.url}/${p.name}${p.dialect === "anthropic" ? "" : "/v1"}  # ${p.name}\n`,
        )
        .join("");
      console.log(
        pc.dim(
          "  set in your shell:\n" +
            `    export ANTHROPIC_BASE_URL=${handle.url}\n` +
            `    export OPENAI_BASE_URL=${handle.url}/v1\n` +
            namedLines +
            "  or wrap a command with:\n" +
            `    meter run -- python myagent.py`,
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
