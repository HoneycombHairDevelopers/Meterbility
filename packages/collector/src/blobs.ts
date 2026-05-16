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
 * Quick heuristic: a buffer with a NUL byte in the first 8 KB is almost
 * certainly binary. UTF-8 text, even Asian-script-heavy text, never
 * contains 0x00. Used to gate redaction so PNG / .woff2 / lockfile bytes
 * don't get round-tripped through `String#replace` and shredded.
 *
 * Why "first 8 KB" and not the whole buffer: the test catches every real
 * binary format we care about (PNG signature has NULs in IHDR, .woff2
 * header is full of zeros, .pyc starts with a magic + NUL, ELF/Mach-O
 * obviously) and stays O(1) for multi-megabyte files. False negatives
 * (binary file with all-nonzero first 8 KB) are theoretically possible
 * but extraordinarily rare; callers who *know* they have binary should
 * pass `skipRedact: true` explicitly.
 */
export function isProbablyText(buf: Buffer): boolean {
  const sampleEnd = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleEnd; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

/**
 * Content-addressed blob store.
 *
 * Layout: $SPOOL_HOME/blobs/<aa>/<bb>/<sha256>
 *
 * Two-level sharding (256 × 256) keeps any single directory under a few
 * thousand files even on heavy users. Writes are write-once: if the file
 * exists, we trust it (SHA collision is the universe's problem, not ours).
 *
 * Every text write passes through the redaction pass and emits a
 * `redaction_log` row when a rule fires so the user can audit what was
 * scrubbed. **Binary writes skip redaction entirely** — `redactBuffer`
 * goes via `String#replace`, which would shred any non-UTF-8 bytes. The
 * `isProbablyText` heuristic gates this automatically; callers who
 * already know the bytes are binary (e.g. v0.3 file capture) can also
 * pass `skipRedact: true` to be explicit.
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
    // Skip the redaction round-trip if (a) the caller already knows the
    // bytes are binary or pre-redacted, or (b) our heuristic flags the
    // first 8 KB as binary. Otherwise PNG / .woff2 / lockfile / .pyc
    // bytes get destroyed by `Buffer.toString("utf-8")` replacing
    // invalid sequences with U+FFFD (3 bytes encoded, not the originals).
    const shouldSkip = opts?.skipRedact === true || !isProbablyText(buf);
    const { buffer: scrubbed, redactions } = shouldSkip
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
