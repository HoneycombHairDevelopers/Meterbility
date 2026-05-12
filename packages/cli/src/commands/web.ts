import { Command } from "commander";
import pc from "picocolors";
import { serveApp, SlackNotifier, type SlackEventKind } from "@spool/server";
import { openStore } from "../util.ts";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Serve the Spool web UI on a local port")
    .option("-p, --port <n>", "Port", (v) => parseInt(v, 10), 4317)
    .option("-h, --host <addr>", "Host", "127.0.0.1")
    .option("--no-open", "Do not auto-open the browser")
    .option(
      "--live",
      "Watch ~/.claude/projects for live agent activity (fleet view + SSE)",
    )
    .option(
      "--watch-tool <name>",
      "Fire an alert when this tool is invoked (repeatable)",
      (val: string, prev: string[] = []) => [...prev, val],
      [] as string[],
    )
    .option(
      "--stall-seconds <n>",
      "Stall alert threshold in seconds",
      (v) => parseInt(v, 10),
      120,
    )
    .option(
      "--slack-webhook <url>",
      "Slack incoming-webhook URL (or set SPOOL_SLACK_WEBHOOK)",
    )
    .option(
      "--slack-event <kind>",
      "Slack event type to forward (repeatable). Default: alert. Other values: run:created, run:completed",
      (v: string, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
    .action(async (opts: {
      port: number;
      host: string;
      open: boolean;
      live?: boolean;
      watchTool: string[];
      stallSeconds: number;
      slackWebhook?: string;
      slackEvent: string[];
    }) => {
      const store = openStore();
      const { url, live } = serveApp(store, {
        port: opts.port,
        host: opts.host,
        live: opts.live === true,
        liveOptions: {
          watchTools: opts.watchTool,
          stallSeconds: opts.stallSeconds,
        },
      });
      console.log(pc.green("Spool running at ") + pc.cyan(url));
      if (live) {
        console.log(
          pc.dim(
            `live mode on — watching Claude Code sessions every ${1500}ms. Watching tools: ${opts.watchTool.join(", ") || "(none)"}.`,
          ),
        );
        const webhook =
          opts.slackWebhook ?? process.env.SPOOL_SLACK_WEBHOOK ?? "";
        if (webhook) {
          try {
            const events = (
              opts.slackEvent.length > 0 ? opts.slackEvent : ["alert"]
            ) as SlackEventKind[];
            const slack = new SlackNotifier({
              webhookUrl: webhook,
              serverUrl: url,
              events,
            });
            slack.attach(live);
            console.log(
              pc.dim(
                `slack notifications enabled · forwarding: ${events.join(", ")}`,
              ),
            );
          } catch (err) {
            console.error(
              pc.red("slack disabled: ") + (err as Error).message,
            );
          }
        }
        live.on("data", (e) => {
          if (e.type === "alert") {
            console.log(
              pc.yellow(`alert[${e.kind}]`) +
                ` ${e.run_id.slice(0, 12)} · ${e.message}`,
            );
          } else if (e.type === "run:created") {
            console.log(
              pc.blue("run:created") +
                ` ${e.run.run_id.slice(0, 12)} · ${e.run.title ?? ""}`,
            );
          } else if (e.type === "run:completed") {
            console.log(
              pc.green("run:completed") +
                ` ${e.run.run_id.slice(0, 12)} · status=${e.run.status}`,
            );
          }
        });
      }
      console.log(pc.dim("press ctrl-c to stop"));
      if (opts.open !== false) {
        await openBrowser(url);
      }
    });
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
