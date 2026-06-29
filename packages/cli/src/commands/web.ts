import { Command } from "commander";
import pc from "picocolors";
import { serveApp, SlackNotifier, type SlackEventKind } from "@meterbility/server";
import { resolveSetting, getSetting } from "@meterbility/collector";
import { openStore } from "../util.ts";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Serve the Meterbility web UI on a local port")
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
      "Slack incoming-webhook URL (or set METERBILITY_SLACK_WEBHOOK)",
    )
    .option(
      "--slack-event <kind>",
      "Slack event type to forward (repeatable). Default: alert. Other values: run:created, run:completed",
      (v: string, prev: string[] = []) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-unauth-bind",
      "Allow binding to a non-loopback host without web.bind_token set. " +
        "Per SPEC-V0_3 §11 this requires explicit opt-in — the default " +
        "behavior is to refuse, since anyone on the network can read all " +
        "runs and step blobs through the unauthenticated /api/* surface.",
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
      allowUnauthBind?: boolean;
    }) => {
      const store = openStore();

      // ── v0.3 §11 — non-loopback bind safety ───────────────────────
      //
      // Loopback (127.x.x.x, ::1, localhost) is always safe — only
      // processes on the same machine can connect. Anything else
      // exposes the server to the LAN, and an unauthenticated /api/*
      // surface there leaks every run and step blob to anyone with a
      // route to the host. Three gates apply:
      //
      //   1. If the bind is loopback: do nothing (current behavior).
      //   2. If non-loopback AND web.bind_token is set: just print a
      //      loud warning — the token gates /api/* so data is safe.
      //   3. If non-loopback AND no token: refuse to start unless
      //      --allow-unauth-bind was passed (per the spec). That flag
      //      inverts the trust model — insecure config is opt-in.
      const isLoopback =
        opts.host === "127.0.0.1" ||
        opts.host === "::1" ||
        opts.host === "localhost" ||
        opts.host.startsWith("127.");
      if (!isLoopback) {
        const bindToken = getSetting(store, "web.bind_token");
        if (!bindToken && !opts.allowUnauthBind) {
          console.error(
            pc.red("refusing to bind: ") +
              `--host=${opts.host} is non-loopback and web.bind_token is not set.\n` +
              pc.dim(
                "  Anyone on this network would be able to read every run " +
                  "and step blob via /api/*.\n" +
                  "  Fix either:\n" +
                  "    • meter config set web.bind_token <random-string>\n" +
                  "    • or re-run with --allow-unauth-bind to opt into the " +
                  "insecure config.\n" +
                  "  See SPEC-V0_3 §11.",
              ),
          );
          store.close();
          process.exit(1);
        }
        // Either token is set or the user explicitly opted into
        // unauth. Loud yellow warning regardless — the LAN bind is
        // the part that surprises people, not the auth state.
        console.warn(
          pc.yellow("⚠  binding to ") +
            pc.yellow(`${opts.host}:${opts.port}`) +
            pc.yellow(" — non-loopback exposure"),
        );
        if (!bindToken) {
          console.warn(
            pc.yellow(
              "   /api/* is UNAUTHENTICATED. Anyone on this network can " +
                "read all runs and step blobs.",
            ),
          );
        } else {
          console.warn(
            pc.dim(
              "   /api/* is gated by web.bind_token. Pass it as " +
                "`Authorization: Bearer <token>` from clients.",
            ),
          );
        }
      }
      // Settings table fallback: if a CLI flag wasn't given, look up the
      // persisted value from the `settings` table (same source the web UI's
      // Settings page writes to). Env vars still win over both.
      const watchToolsEffective =
        opts.watchTool.length > 0
          ? opts.watchTool
          : (getSetting(store, "live.watch_tools") ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
      const stallFromSetting = getSetting(store, "live.stall_seconds");
      const stallSecondsEffective =
        opts.stallSeconds !== 120
          ? opts.stallSeconds
          : stallFromSetting
            ? parseInt(stallFromSetting, 10) || opts.stallSeconds
            : opts.stallSeconds;
      const { url, live } = serveApp(store, {
        port: opts.port,
        host: opts.host,
        live: opts.live === true,
        liveOptions: {
          watchTools: watchToolsEffective,
          stallSeconds: stallSecondsEffective,
        },
      });
      console.log(pc.green("Meterbility running at ") + pc.cyan(url));
      if (live) {
        console.log(
          pc.dim(
            `live mode on — watching Claude Code sessions every ${1500}ms. Watching tools: ${watchToolsEffective.join(", ") || "(none)"}.`,
          ),
        );
        const webhook =
          opts.slackWebhook ??
          resolveSetting(store, "slack.webhook", "METERBILITY_SLACK_WEBHOOK") ??
          "";
        const slackEventsFromSetting = getSetting(
          store,
          "slack.default_events",
        );
        if (webhook) {
          try {
            const fallbackEvents = slackEventsFromSetting
              ? slackEventsFromSetting
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : ["alert"];
            const events = (
              opts.slackEvent.length > 0 ? opts.slackEvent : fallbackEvents
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
