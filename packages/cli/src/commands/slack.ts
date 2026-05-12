import { Command } from "commander";
import pc from "picocolors";
import { SlackNotifier } from "@spool/server";

export function registerSlackCommand(program: Command): void {
  const slack = program
    .command("slack")
    .description("Slack integration utilities");

  slack
    .command("test")
    .description("Send a one-off Slack message to verify the webhook")
    .option(
      "--webhook <url>",
      "Webhook URL (or set SPOOL_SLACK_WEBHOOK)",
    )
    .action(async (opts: { webhook?: string }) => {
      const url = opts.webhook ?? process.env.SPOOL_SLACK_WEBHOOK;
      if (!url) {
        throw new Error(
          "missing --webhook or SPOOL_SLACK_WEBHOOK environment variable",
        );
      }
      const n = new SlackNotifier({ webhookUrl: url });
      await n.sendTest();
      console.log(`${pc.green("ok")}  test message sent`);
    });
}
