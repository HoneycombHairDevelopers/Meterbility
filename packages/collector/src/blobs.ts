import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  blobPath,
  blobRoot,
  hashJson,
  redactBuffer,
  sha256,
} from "@spool/shared";
import type Database from "better-sqlite3";

/**
 * Content-addressed blob store.
 *
 * Layout: $SPOOL_HOME/blobs/<aa>/<bb>/<sha256>
 *
 * Two-level sharding (256 × 256) keeps any single directory under a few
 * thousand files even on heavy users. Writes are write-once: if the file
 * exists, we trust it (SHA collision is the universe's problem, not ours).
 *
 * Every write passes through the redaction pass and emits a
 * `redaction_log` row when a rule fires so the user can audit what was
 * scrubbed.
 */
export class BlobStore {
  constructor(private db: Database.Database) {}

  async putString(content: string, opts?: { skipRedact?: boolean }): Promise<string> {
    return this.putBuffer(Buffer.from(content, "utf-8"), opts);
  }

  async putJson(value: unknown, opts?: { skipRedact?: boolean }): Promise<string> {
    return this.putString(JSON.stringify(value), opts);
  }

  /**
   * Hash without persisting — useful when you want a snapshot id before
   * deciding whether to write.
   */
  hashJson(value: unknown): string {
    return hashJson(value);
  }

  async putBuffer(buf: Buffer, opts?: { skipRedact?: boolean }): Promise<string> {
    const { buffer: scrubbed, redactions } = opts?.skipRedact
      ? { buffer: buf, redactions: [] as Array<{ rule: string; count: number }> }
      : redactBuffer(buf);
    const hash = sha256(scrubbed);
    const path = blobPath(hash);
    try {
      await stat(path);
      return hash;
    } catch {
      // not present — write it
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, scrubbed);
    if (redactions.length) {
      const stmt = this.db.prepare(
        "INSERT INTO redaction_log(blob_ref, rule, count, created_at) VALUES (?,?,?,?)",
      );
      const now = new Date().toISOString();
      for (const r of redactions) stmt.run(hash, r.rule, r.count, now);
    }
    return hash;
  }

  async getString(hash: string): Promise<string> {
    const buf = await this.getBuffer(hash);
    return buf.toString("utf-8");
  }

  async getJson<T = unknown>(hash: string): Promise<T> {
    const text = await this.getString(hash);
    return JSON.parse(text) as T;
  }

  async getBuffer(hash: string): Promise<Buffer> {
    return readFile(blobPath(hash));
  }

  async tryGetString(hash: string): Promise<string | undefined> {
    try {
      return await this.getString(hash);
    } catch {
      return undefined;
    }
  }

  rootDir(): string {
    return blobRoot();
  }
}
