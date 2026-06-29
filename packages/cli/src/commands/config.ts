import { Command } from "commander";
import pc from "picocolors";
import {
  deleteSetting,
  getSetting,
  isSecret,
  listSettings,
  maskSecret,
  setSetting,
  type SettingKey,
} from "@meterbility/collector";
import { openStore } from "../util.ts";

const KNOWN_KEYS: SettingKey[] = [
  "slack.webhook",
  "slack.default_events",
  "live.watch_tools",
  "live.stall_seconds",
  "fork.default_model",
  "fork.default_max_iterations",
  "anthropic.api_key",
  "postgres.url",
];

/**
 * `meter config` — read/write the same `settings` table the web Settings
 * page mutates. Provides terminal-side parity so users who live in the CLI
 * don't need to spin up the web UI just to set a Slack webhook or a default
 * fork model.
 *
 * Secrets (api_key/webhook/url-style keys) are masked on display unless
 * `--reveal` is passed. `set` writes are not validated against KNOWN_KEYS
 * because we want forward-compat with new SettingKey values without forcing
 * a CLI bump.
 */
export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description(
      "Get/set persisted Meterbility settings (mirrors the web UI's Settings page)",
    );

  config
    .command("list")
    .alias("ls")
    .description("List all configured settings (secrets masked)")
    .option("--reveal", "Show secret values in plaintext")
    .option("--json", "Emit JSON for scripting")
    .action((opts: { reveal?: boolean; json?: boolean }) => {
      const store = openStore();
      try {
        const rows = listSettings(store);
        if (opts.json) {
          const payload = rows.map((r) => ({
            key: r.key,
            value:
              opts.reveal || !isSecret(r.key) ? r.value : maskSecret(r.value),
            updated_at: r.updated_at,
            secret: isSecret(r.key),
          }));
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log(pc.dim("(no settings configured)"));
          console.log(
            pc.dim(
              "  set one with:  meter config set <key> <value>\n  known keys:   " +
                KNOWN_KEYS.join(", "),
            ),
          );
          return;
        }
        for (const r of rows) {
          const displayed =
            opts.reveal || !isSecret(r.key) ? r.value : maskSecret(r.value);
          const tag = isSecret(r.key) ? pc.yellow(" [secret]") : "";
          console.log(
            `  ${pc.cyan(r.key.padEnd(28))} ${displayed}${tag}  ${pc.dim(r.updated_at)}`,
          );
        }
      } finally {
        store.close();
      }
    });

  config
    .command("get <key>")
    .description("Print a single setting value (raw, no masking)")
    .action((key: string) => {
      const store = openStore();
      try {
        const v = getSetting(store, key as SettingKey);
        if (v === undefined) {
          console.error(pc.red(`not set: ${key}`));
          process.exit(1);
        }
        // Raw on stdout so it's pipe-friendly: `export X=$(meter config get foo)`
        process.stdout.write(v + "\n");
      } finally {
        store.close();
      }
    });

  config
    .command("set <key> <value>")
    .description(
      `Persist a setting. Known keys: ${KNOWN_KEYS.join(", ")}`,
    )
    .action((key: string, value: string) => {
      const store = openStore();
      try {
        setSetting(store, key as SettingKey, value);
        const display = isSecret(key) ? maskSecret(value) : value;
        console.log(
          `${pc.green("set")}  ${pc.cyan(key)} = ${display}${isSecret(key) ? pc.yellow(" [secret]") : ""}`,
        );
        if (!KNOWN_KEYS.includes(key as SettingKey)) {
          console.log(
            pc.dim(
              `  note: '${key}' is not a known SettingKey — saved anyway. Known keys: ${KNOWN_KEYS.join(", ")}`,
            ),
          );
        }
      } finally {
        store.close();
      }
    });

  config
    .command("rm <key>")
    .alias("unset")
    .description("Delete a setting")
    .action((key: string) => {
      const store = openStore();
      try {
        const existing = getSetting(store, key as SettingKey);
        if (existing === undefined) {
          console.error(pc.red(`not set: ${key}`));
          process.exit(1);
        }
        deleteSetting(store, key as SettingKey);
        console.log(`${pc.green("removed")}  ${pc.cyan(key)}`);
      } finally {
        store.close();
      }
    });
}
