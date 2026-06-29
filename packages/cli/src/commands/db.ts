import { Command } from "commander";
import pc from "picocolors";
import { resolveSetting } from "@meterbility/collector";
import { openStore } from "../util.ts";

/**
 * Resolve the Postgres URL: --url flag > METERBILITY_DB_URL env > settings table.
 * Returns undefined if nothing is configured (PostgresStore.open will then
 * throw a clear error).
 */
function resolvePostgresUrl(
  store: import("@meterbility/collector").Store,
  flag?: string,
): string | undefined {
  if (flag) return flag;
  return resolveSetting(store, "postgres.url", "METERBILITY_DB_URL");
}

export function registerDbCommand(program: Command): void {
  const db = program
    .command("db")
    .description("Hosted backend management (Postgres, optional)");

  db
    .command("postgres-init")
    .description(
      "Connect to a Postgres URL and ensure Meterbility's schema is present.",
    )
    .option(
      "--url <conn>",
      "Postgres connection URL (defaults to METERBILITY_DB_URL or postgres.url setting)",
    )
    .action(async (opts: { url?: string }) => {
      const { PostgresStore } = await import("@meterbility/store-postgres");
      const sqlite = openStore();
      let store: Awaited<ReturnType<typeof PostgresStore.open>>;
      try {
        store = await PostgresStore.open({
          url: resolvePostgresUrl(sqlite, opts.url),
        });
      } finally {
        sqlite.close();
      }
      try {
        const r = await store.client.query<{ value: string }>(
          "SELECT value FROM meta WHERE key='schema_version'",
        );
        console.log(
          `${pc.green("connected")}  schema_version=${r.rows[0]?.value ?? "?"}`,
        );
      } finally {
        await store.close();
      }
    });

  db
    .command("postgres-sync")
    .description(
      "Copy local SQLite runs / steps / blobs into Postgres. Idempotent.",
    )
    .option(
      "--url <conn>",
      "Postgres URL (defaults to METERBILITY_DB_URL or postgres.url setting)",
    )
    .option(
      "--limit <n>",
      "Cap runs synced (default 1000)",
      (v) => parseInt(v, 10),
    )
    .action(async (opts: { url?: string; limit?: number }) => {
      const { PostgresStore, syncSqliteToPostgres } = await import(
        "@meterbility/store-postgres"
      );
      const sqlite = openStore();
      const postgres = await PostgresStore.open({
        url: resolvePostgresUrl(sqlite, opts.url),
      });
      try {
        const t0 = Date.now();
        const r = await syncSqliteToPostgres(sqlite, postgres, {
          limitRuns: opts.limit,
        });
        const dt = Date.now() - t0;
        console.log(
          pc.bold(
            `synced ${r.runs} runs · ${r.steps} steps · ${r.blobs} blobs (${(r.bytes / 1024).toFixed(1)}KB) in ${dt}ms`,
          ),
        );
      } finally {
        sqlite.close();
        await postgres.close();
      }
    });
}
