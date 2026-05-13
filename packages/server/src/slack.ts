import type { LiveEvent, LiveInspector } from "./live.ts";

/**
 * Slack notifier — subscribes to a LiveInspector and posts shaped Block
 * Kit messages to an incoming webhook. Stays out of the hot path: posts
 * are fire-and-forget, errors are logged but don't crash the watcher.
 *
 * Anchor URLs use the server's externally-reachable origin (passed via
 * `serverUrl`) so operators can jump from Slack into Spool's web UI.
 */

export type SlackEventKind =
  | "alert"
  | "run:created"
  | "run:completed";

export interface SlackNotifierOptions {
  /** Incoming-webhook URL (https://hooks.slack.com/services/...). */
  webhookUrl: string;
  /** External origin of the local Spool web UI for clickable links. */
  serverUrl?: string;
  /** Which event types to post. Defaults to alerts only. */
  events?: SlackEventKind[];
  /** Optional channel override (only honored by some workspaces). */
  channel?: string;
  /** Cap posts per minute to keep things tame. Default 30. */
  rateLimitPerMinute?: number;
}

export class SlackNotifier {
  private opts: Required<Omit<SlackNotifierOptions, "channel">> & {
    channel?: string;
  };
  private bucket: number[] = []; // post timestamps
  private detach?: () => void;

  constructor(opts: SlackNotifierOptions) {
    if (!opts.webhookUrl || !/^https:\/\/hooks\.slack\.com\//.test(opts.webhookUrl)) {
      throw new Error("invalid Slack webhook URL");
    }
    this.opts = {
      webhookUrl: opts.webhookUrl,
      serverUrl: opts.serverUrl ?? "",
      events: opts.events ?? ["alert"],
      rateLimitPerMinute: opts.rateLimitPerMinute ?? 30,
      channel: opts.channel,
    };
  }

  attach(live: LiveInspector): void {
    if (this.detach) this.detach();
    const handler = (e: LiveEvent) => void this.handleEvent(e);
    live.on("data", handler);
    this.detach = () => live.off("data", handler);
  }

  detachFrom(): void {
    if (this.detach) this.detach();
    this.detach = undefined;
  }

  async handleEvent(e: LiveEvent): Promise<void> {
    if (!this.opts.events.includes(e.type as SlackEventKind)) return;
    const payload = this.formatPayload(e);
    if (!payload) return;
    if (!this.acquireRateLimitToken()) return;
    try {
      const res = await fetch(this.opts.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[spool/slack] webhook returned ${res.status}: ${await res.text()}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[spool/slack] post failed:`, (err as Error).message);
    }
  }

  /**
   * Send a one-off test message — used by `spool slack test`.
   */
  async sendTest(): Promise<void> {
    const payload = {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Spool is connected" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "If you can read this, your webhook is wired correctly. " +
              "Alerts will arrive here when an agent run loops, stalls, or crosses a context threshold.",
          },
        },
      ],
    };
    if (!this.acquireRateLimitToken()) {
      throw new Error("rate-limited");
    }
    const res = await fetch(this.opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
  }

  private acquireRateLimitToken(): boolean {
    const now = Date.now();
    this.bucket = this.bucket.filter((t) => now - t < 60_000);
    if (this.bucket.length >= this.opts.rateLimitPerMinute) return false;
    this.bucket.push(now);
    return true;
  }

  private formatPayload(e: LiveEvent): Record<string, unknown> | undefined {
    const link = (runId: string) =>
      this.opts.serverUrl
        ? `${this.opts.serverUrl.replace(/\/$/, "")}/runs/${runId}`
        : `run ${runId.slice(0, 12)}`;

    if (e.type === "alert") {
      const color = alertColor(e.kind);
      return {
        ...(this.opts.channel ? { channel: this.opts.channel } : {}),
        attachments: [
          {
            color,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*${labelForAlert(e.kind)}* on run \`${e.run_id.slice(0, 12)}\`\n${escapeSlack(e.message)}`,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Open in Spool" },
                    url: link(e.run_id),
                  },
                ],
              },
            ],
          },
        ],
      };
    }
    if (e.type === "run:created") {
      return {
        ...(this.opts.channel ? { channel: this.opts.channel } : {}),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `▶︎ New run: *${escapeSlack(e.run.title ?? e.run.run_id)}* (${escapeSlack(e.run.source_runtime)})\n<${link(e.run.run_id)}|open in Spool>`,
            },
          },
        ],
      };
    }
    if (e.type === "run:completed") {
      const icon = e.run.status === "ok" ? "✅" : e.run.status === "error" ? "❌" : "⏹";
      return {
        ...(this.opts.channel ? { channel: this.opts.channel } : {}),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${icon} *${escapeSlack(e.run.title ?? e.run.run_id)}* finished · ${e.run.step_count} steps · ${formatCost(e.run.cost_cents)}\n<${link(e.run.run_id)}|open in Spool>`,
            },
          },
        ],
      };
    }
    return undefined;
  }
}

function alertColor(kind: string): string {
  switch (kind) {
    case "loop":
      return "#f85149";
    case "tool_called":
      return "#58a6ff";
    case "context_threshold":
      return "#d29922";
    case "stall":
      return "#8b949e";
    default:
      return "#bc8cff";
  }
}

function labelForAlert(kind: string): string {
  switch (kind) {
    case "loop":
      return "Loop detected";
    case "tool_called":
      return "Watched tool called";
    case "context_threshold":
      return "Context utilization";
    case "stall":
      return "Run stalled";
    default:
      return kind;
  }
}

function formatCost(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (Math.abs(dollars) >= 0.005) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

function escapeSlack(s: string): string {
  // Slack's mrkdwn flavor — escape the three meta characters that
  // matter for our use case.
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
