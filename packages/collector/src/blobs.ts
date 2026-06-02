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
 * Two-stage heuristic for "is this buffer safe to send through the
 * redaction pipeline?". Used to gate `redactBuffer` so PNG / .woff2 /
 * lockfile / `.pyc` bytes don't get round-tripped through
 * `String#replace` and shredded by U+FFFD substitution.
 *
 * Stage 1 — Full-buffer NUL scan. UTF-8 source code — even with CJK,
 * emoji, every weird code point — never contains 0x00. A NUL byte
 * anywhere is strong evidence of binary content. For files whose
 * binary signature is at the start (PNG, ELF, .pyc, .woff2) this
 * bails at byte 7-12 and is effectively O(1). Removing the previous
 * 8KB cap closes the rare-but-real "binary file with all-non-NUL
 * first 8KB" gap (gzip headers, some compressed formats can hit it).
 *
 * Stage 2 — Round-trip-length check. Even with no NUL, a buffer can
 * still be invalid UTF-8 (stray continuation bytes, truncated multi-
 * byte sequences). The redaction pipeline calls
 * `Buffer.toString('utf-8')` which silently replaces invalid bytes
 * with U+FFFD (3 encoded bytes per replacement). If the re-encoded
 * length differs from the input, the round trip is lossy and would
 * corrupt the caller's bytes. Classify as binary so the bytes survive.
 *
 * Both stages are O(n). Cost is dominated by the redaction pipeline
 * itself (which also runs `toString` on the buffer), so this adds at
 * most one extra full pass to the redact path. Callers who already
 * know their bytes are binary can still pass `skipRedact: true` to
 * skip both stages entirely.
 */
export function isProbablyText(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return false;
  }
  if (
    buf.length > 0 &&
    Buffer.byteLength(buf.toString("utf-8"), "utf-8") !== buf.length
  ) {
    return false;
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

  /**
   * Binary-safe variant of `tryGetString`. Used by /api/blob/:hash/render
   * which has to look at raw bytes for MIME sniffing before deciding
   * whether to render text or serve as image/octet-stream.
   */
  async tryGetBuffer(hash: string): Promise<Buffer | undefined> {
    try {
      return await this.getBuffer(hash);
    } catch {
      return undefined;
    }
  }

  /**
   * Write pre-computed HTML (or other text) under a caller-chosen
   * synthetic key, bypassing the content-addressed hash. Used by the
   * blob_render cache to store rendered HTML under a key derived
   * from `sha(blob_hash + lang + RENDER_VERSION)` rather than the
   * content's own hash — this way two different renders of the same
   * source code (e.g. lang=auto vs lang=typescript) cache separately
   * but predictably.
   *
   * Skips redaction (renders are derived from already-stored blobs
   * that went through redaction at put time).
   */
  async putWithKey(content: string, key: string): Promise<void> {
    const path = blobPath(key);
    try {
      await stat(path);
      return; // already cached
    } catch {
      // not present — write it
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(content, "utf-8"));
  }

  rootDir(): string {
    return blobRoot();
  }
}
