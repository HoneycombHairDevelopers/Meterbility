import { Command } from "commander";
import pc from "picocolors";
import { openStore } from "../util.ts";

export function registerDbCommand(program: Command): void {
  const db = program
    .command("db")
    .description("Hosted backend management (Postgres, optional)");

  db
    .command("postgres-init")
    .description(
      "Connect to a Postgres URL and ensure Spool's schema is present.",
    )
    .option(
      "--url <conn>",
      "Postgres connection URL (defaults to SPOOL_DB_URL)",
    )
    .action(async (opts: { url?: string }) => {
      const { PostgresStore } = await import("@spool/store-postgres");
      const store = await PostgresStore.open({ url: opts.url });
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
    .option("--url <conn>", "Postgres URL (defaults to SPOOL_DB_URL)")
    .option(
      "--limit <n>",
      "Cap runs synced (default 1000)",
      (v) => parseInt(v, 10),
    )
    .action(async (opts: { url?: string; limit?: number }) => {
      const { PostgresStore, syncSqliteToPostgres } = await import(
        "@spool/store-postgres"
      );
      const sqlite = openStore();
      const postgres = await PostgresStore.open({ url: opts.url });
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
