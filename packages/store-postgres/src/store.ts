import pg from "pg";
import type { Client } from "pg";
import { ensurePostgresSchema } from "./schema.ts";

/**
 * Async, network-backed equivalent of the SQLite Store. Connects via
 * the standard `pg` driver. Caller is responsible for `close()` when
 * done.
 *
 * Connection URL precedence:
 *   1. opts.url
 *   2. process.env.SPOOL_DB_URL
 *   3. process.env.DATABASE_URL
 *   4. throw
 */
export class PostgresStore {
  readonly client: Client;
  private constructor(client: Client) {
    this.client = client;
  }

  static async open(opts?: { url?: string }): Promise<PostgresStore> {
    const url =
      opts?.url ??
      process.env.SPOOL_DB_URL ??
      process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "PostgresStore requires a connection URL. Pass opts.url or set SPOOL_DB_URL.",
      );
    }
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await ensurePostgresSchema(client);
    return new PostgresStore(client);
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  /** Convenience for blob storage in Postgres mode (bytea-backed). */
  async putBlob(content: Buffer | string, ref: string): Promise<void> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    await this.client.query(
      `INSERT INTO blobs(blob_ref, content, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (blob_ref) DO NOTHING`,
      [ref, buf],
    );
  }

  async getBlob(ref: string): Promise<Buffer | undefined> {
    const r = await this.client.query<{ content: Buffer }>(
      "SELECT content FROM blobs WHERE blob_ref = $1",
      [ref],
    );
    return r.rows[0]?.content;
  }

  async getBlobString(ref: string): Promise<string | undefined> {
    const buf = await this.getBlob(ref);
    return buf ? buf.toString("utf-8") : undefined;
  }
}
