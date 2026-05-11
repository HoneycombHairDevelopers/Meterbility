import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { dbPath, spoolHome } from "@spool/shared";
import { ensureSchema } from "./schema.ts";
import { BlobStore } from "./blobs.ts";

/**
 * One-stop entry into the local data plane. `open()` creates the
 * `$SPOOL_HOME` tree if needed, applies the schema, and exposes both the
 * raw SQLite handle (for queries.ts) and the blob store.
 */
export class Store {
  readonly db: Database.Database;
  readonly blobs: BlobStore;

  private constructor(db: Database.Database) {
    this.db = db;
    this.blobs = new BlobStore(db);
  }

  static open(opts?: { path?: string }): Store {
    const path = opts?.path ?? dbPath();
    mkdirSync(spoolHome(), { recursive: true });
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    ensureSchema(db);
    return new Store(db);
  }

  static async openAsync(opts?: { path?: string }): Promise<Store> {
    const path = opts?.path ?? dbPath();
    await mkdir(spoolHome(), { recursive: true });
    await mkdir(dirname(path), { recursive: true });
    return this.open(opts);
  }

  close(): void {
    this.db.close();
  }
}
