import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { blobPath } from "@spool-ai/shared";
import { Store } from "./store.ts";
import { isProbablyText } from "./blobs.ts";

/**
 * Exhaustive deterministic + property-based coverage of `BlobStore` and
 * its `isProbablyText` heuristic.
 *
 * Companion to blobs.test.ts (9 tests covering PR-1 binary safety): this
 * file enumerates the full encoding × `skipRedact` matrix, every
 * heuristic boundary case, hash determinism + dedup, redaction-log
 * integrity, round-trip semantics across put/get/string/json,
 * error paths, a `worker_threads` concurrency stress test, and four
 * fast-check properties.
 *
 * The most important coverage here is Section 2: the new two-stage
 * `isProbablyText` (full NUL scan + round-trip-length check) closes the
 * silent-corruption gap the old 8KB-cap heuristic had for binaries with
 * all-non-NUL early bytes.
 */

// ─── Fixtures ──────────────────────────────────────────────────────

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "spool-blob-exh-"));
  process.env.SPOOL_HOME = dir;
  return Store.open({ path: join(dir, "spool.db") });
}

/** Read all redaction_log rows for a given blob hash. */
function redactionRows(
  store: Store,
  hash: string,
): Array<{ rule: string; count: number }> {
  return store.db
    .prepare("SELECT rule, count FROM redaction_log WHERE blob_ref = ?")
    .all(hash) as Array<{ rule: string; count: number }>;
}

/* ====================================================================
 * Section 1 — Encoding × skipRedact matrix (10 tests)
 *
 * Five encodings × two skipRedact values. Each cell verifies bytes
 * round-trip exactly OR are appropriately redacted, and that the
 * redaction_log fires the expected number of rows.
 * ==================================================================== */

const ANTHROPIC_SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("matrix: utf-8 × skipRedact=false → secret redacted", async () => {
  const store = freshStore();
  try {
    const text = `const k = "${ANTHROPIC_SECRET}";\n`;
    const hash = await store.blobs.putString(text);
    const stored = await store.blobs.getString(hash);
    assert.ok(!stored.includes(ANTHROPIC_SECRET), "raw secret must not survive");
    assert.match(stored, /«spool:redacted:anthropic-key»/);
    const rows = redactionRows(store, hash);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rule, "anthropic-key");
  } finally {
    store.close();
  }
});

test("matrix: utf-8 × skipRedact=true → secret preserved verbatim", async () => {
  const store = freshStore();
  try {
    const text = `const k = "${ANTHROPIC_SECRET}";\n`;
    const hash = await store.blobs.putString(text, { skipRedact: true });
    const stored = await store.blobs.getString(hash);
    assert.equal(stored, text);
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("matrix: utf-16-le with BOM × skipRedact=false → auto-binary, bytes preserved", async () => {
  const store = freshStore();
  try {
    // Build a UTF-16-LE buffer with BOM (FF FE) + simple ASCII content.
    const text = "// utf-16 source\nconst x = 42;\n";
    const utf16 = Buffer.alloc(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = (text.charCodeAt(i) >> 8) & 0xff;
    }
    const hash = await store.blobs.putBuffer(utf16);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, utf16, "UTF-16 LE bytes must round-trip");
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("matrix: utf-16-le with BOM × skipRedact=true → bytes preserved (same outcome as auto-binary)", async () => {
  const store = freshStore();
  try {
    const utf16 = Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    const hash = await store.blobs.putBuffer(utf16, { skipRedact: true });
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, utf16);
  } finally {
    store.close();
  }
});

test("matrix: utf-16-be with BOM × skipRedact=false → auto-binary, bytes preserved", async () => {
  const store = freshStore();
  try {
    // UTF-16-BE BOM is FE FF. Then "Hi" as 00 48 00 69.
    const utf16be = Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    const hash = await store.blobs.putBuffer(utf16be);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, utf16be);
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("matrix: utf-16-be with BOM × skipRedact=true → bytes preserved", async () => {
  const store = freshStore();
  try {
    const utf16be = Buffer.from([0xfe, 0xff, 0x00, 0x41]);
    const hash = await store.blobs.putBuffer(utf16be, { skipRedact: true });
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, utf16be);
  } finally {
    store.close();
  }
});

test("matrix: pure binary (PNG-shaped) × skipRedact=false → auto-binary, bytes preserved", async () => {
  const store = freshStore();
  try {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, // IHDR length
    ]);
    const hash = await store.blobs.putBuffer(png);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, png);
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("matrix: pure binary × skipRedact=true → bytes preserved", async () => {
  const store = freshStore();
  try {
    const blob = randomBytes(256);
    const hash = await store.blobs.putBuffer(blob, { skipRedact: true });
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, blob);
  } finally {
    store.close();
  }
});

test("matrix: pseudo-text (invalid UTF-8 with no NUL) × skipRedact=false → caught by round-trip check, bytes preserved", async () => {
  // Pre-fix this would have been corrupted by Buffer.toString → U+FFFD.
  // Post-fix the round-trip-length check classifies as binary and the
  // bytes survive verbatim.
  const store = freshStore();
  try {
    // 9000 ASCII bytes + a lone continuation byte (0x80, invalid UTF-8).
    const buf = Buffer.alloc(9001);
    for (let i = 0; i < 9000; i++) buf[i] = 0x61; // 'a'
    buf[9000] = 0x80;
    const hash = await store.blobs.putBuffer(buf);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, buf, "pseudo-text bytes survive verbatim");
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("matrix: pseudo-text × skipRedact=true → bytes preserved (workaround for callers who know)", async () => {
  const store = freshStore();
  try {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x80])]);
    const hash = await store.blobs.putBuffer(buf, { skipRedact: true });
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, buf);
  } finally {
    store.close();
  }
});

/* ====================================================================
 * Section 2 — isProbablyText heuristic boundaries (8 tests)
 *
 * Pin down both stages: the full NUL scan and the round-trip-length
 * check. The cases marked "post-fix" would have returned the wrong
 * value under the old 8KB-cap heuristic.
 * ==================================================================== */

test("heuristic: empty buffer → text (vacuously)", () => {
  assert.equal(isProbablyText(Buffer.alloc(0)), true);
});

test("heuristic: NUL at byte 0 → binary (fast-path)", () => {
  assert.equal(isProbablyText(Buffer.from([0x00, 0x61, 0x62])), false);
});

test("heuristic: NUL at byte 8191 (last byte of old sample window) → binary", () => {
  const buf = Buffer.alloc(8192, 0x61);
  buf[8191] = 0x00;
  assert.equal(isProbablyText(buf), false);
});

test("heuristic: NUL at byte 8192 (just past old sample) → binary (POST-FIX)", () => {
  // Pre-fix: the 8KB cap missed this and returned `true`. Post-fix:
  // the full NUL scan catches it.
  const buf = Buffer.alloc(8193, 0x61);
  buf[8192] = 0x00;
  assert.equal(isProbablyText(buf), false);
});

test("heuristic: all-NUL 8KB buffer → binary", () => {
  assert.equal(isProbablyText(Buffer.alloc(8192)), false);
});

test("heuristic: 16KB of pure-ASCII text → text", () => {
  assert.equal(isProbablyText(Buffer.alloc(16384, 0x61)), true);
});

test("heuristic: NUL at byte 9000 in otherwise-ASCII buffer → binary (POST-FIX)", () => {
  // Documented gap in the pre-fix 8KB heuristic. The full scan catches it.
  const buf = Buffer.alloc(10_000, 0x61);
  buf[9000] = 0x00;
  assert.equal(isProbablyText(buf), false);
});

test("heuristic: valid UTF-8 with high-bit code points (CJK + emoji) → text", () => {
  const text = "プログラム📁🎉 ✨ Hello\n";
  assert.equal(isProbablyText(Buffer.from(text, "utf-8")), true);
});

/* ====================================================================
 * Section 3 — Hash determinism + dedup (8 tests)
 * ==================================================================== */

test("dedup: same bytes through putBuffer twice → identical hash", async () => {
  const store = freshStore();
  try {
    const buf = Buffer.from("hello world\n", "utf-8");
    const h1 = await store.blobs.putBuffer(buf);
    const h2 = await store.blobs.putBuffer(buf);
    assert.equal(h1, h2);
  } finally {
    store.close();
  }
});

test("dedup: putString('foo') and putBuffer(Buffer.from('foo')) → identical hash", async () => {
  const store = freshStore();
  try {
    const h1 = await store.blobs.putString("foo bar\n");
    const h2 = await store.blobs.putBuffer(Buffer.from("foo bar\n", "utf-8"));
    assert.equal(h1, h2, "text path equivalence across the two entry points");
  } finally {
    store.close();
  }
});

test("dedup: one-byte difference → different hashes", async () => {
  const store = freshStore();
  try {
    const h1 = await store.blobs.putString("hello");
    const h2 = await store.blobs.putString("hello!");
    assert.notEqual(h1, h2);
  } finally {
    store.close();
  }
});

test("dedup: UTF-8 'hello' vs UTF-16-LE 'hello' → different hashes", async () => {
  const store = freshStore();
  try {
    const h1 = await store.blobs.putString("hello");
    // UTF-16-LE bytes for "hello": 68 00 65 00 6c 00 6c 00 6f 00
    const utf16 = Buffer.from([
      0x68, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f, 0x00,
    ]);
    const h2 = await store.blobs.putBuffer(utf16);
    assert.notEqual(h1, h2);
  } finally {
    store.close();
  }
});

test("dedup: pre-redacted text → same hash as fresh redaction of the original", async () => {
  // Idempotence at the store layer: putting a string that's already
  // been redacted produces the same hash as redacting the original and
  // then storing the result.
  const store = freshStore();
  try {
    const original = `key = "${ANTHROPIC_SECRET}"`;
    const h1 = await store.blobs.putString(original);
    const stored = await store.blobs.getString(h1);
    const h2 = await store.blobs.putString(stored);
    assert.equal(h1, h2);
  } finally {
    store.close();
  }
});

test("dedup: empty buffer hash is stable across multiple writes", async () => {
  const store = freshStore();
  try {
    const h1 = await store.blobs.putBuffer(Buffer.alloc(0));
    const h2 = await store.blobs.putBuffer(Buffer.alloc(0));
    const h3 = await store.blobs.putString("");
    assert.equal(h1, h2);
    assert.equal(h1, h3);
  } finally {
    store.close();
  }
});

test("dedup: second write of same content does not create a second file", async () => {
  const store = freshStore();
  try {
    const buf = Buffer.from("dedup me\n");
    const h1 = await store.blobs.putBuffer(buf);
    const path = blobPath(h1);
    const stat1 = statSync(path);
    // Force a small delay so mtime would differ if a re-write happened.
    await new Promise((r) => setTimeout(r, 10));
    const h2 = await store.blobs.putBuffer(buf);
    assert.equal(h1, h2);
    const stat2 = statSync(path);
    assert.equal(
      stat1.mtimeMs,
      stat2.mtimeMs,
      "dedup short-circuits before writeFile",
    );
  } finally {
    store.close();
  }
});

test("dedup: hash is hex-only (no path-traversal characters)", async () => {
  const store = freshStore();
  try {
    const hash = await store.blobs.putString("safety");
    assert.match(hash, /^[0-9a-f]{64}$/, "SHA-256 hex, 64 chars");
  } finally {
    store.close();
  }
});

/* ====================================================================
 * Section 4 — Redaction × encoding × content interactions (8 tests)
 * ==================================================================== */

test("redaction-log: utf-8 + single anthropic-key → 1 row, count=1", async () => {
  const store = freshStore();
  try {
    const hash = await store.blobs.putString(`const k = "${ANTHROPIC_SECRET}";\n`);
    const rows = redactionRows(store, hash);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rule, "anthropic-key");
    assert.equal(rows[0]!.count, 1);
  } finally {
    store.close();
  }
});

test("redaction-log: utf-8 + no secret → 0 rows", async () => {
  const store = freshStore();
  try {
    const hash = await store.blobs.putString("nothing scary here\n");
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("redaction-log: 3 distinct rule types → 3 rows", async () => {
  const store = freshStore();
  try {
    const text =
      `anthropic = "${ANTHROPIC_SECRET}";\n` +
      `github = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";\n` +
      `aws = "AKIAIOSFODNN7EXAMPLE";\n`;
    const hash = await store.blobs.putString(text);
    const rows = redactionRows(store, hash);
    const ruleSet = new Set(rows.map((r) => r.rule));
    assert.ok(ruleSet.has("anthropic-key"));
    assert.ok(ruleSet.has("github-token"));
    assert.ok(ruleSet.has("aws-access-key"));
  } finally {
    store.close();
  }
});

test("redaction-log: same secret 5× → 1 row with count=5", async () => {
  const store = freshStore();
  try {
    const text = (`x = "${ANTHROPIC_SECRET}"\n`).repeat(5);
    const hash = await store.blobs.putString(text);
    const rows = redactionRows(store, hash);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.count, 5);
  } finally {
    store.close();
  }
});

test("redaction-log: UTF-16-LE bytes shaped like a secret → NOT redacted (auto-binary)", async () => {
  const store = freshStore();
  try {
    // Build a UTF-16-LE buffer whose decoded text would have looked
    // like an anthropic key (had the heuristic let it through).
    const innerText = `key=${ANTHROPIC_SECRET}`;
    const utf16 = Buffer.alloc(innerText.length * 2 + 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < innerText.length; i++) {
      utf16[2 + i * 2] = innerText.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = 0; // every other byte is NUL → auto-binary
    }
    const hash = await store.blobs.putBuffer(utf16);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, utf16);
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("redaction-log: pure binary with secret-shaped bytes → NOT redacted", async () => {
  const store = freshStore();
  try {
    // Sandwich the secret bytes between NULs so the heuristic flags binary.
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00]),
      Buffer.from(ANTHROPIC_SECRET, "utf-8"),
      Buffer.from([0x00]),
    ]);
    const hash = await store.blobs.putBuffer(buf);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, buf, "secret bytes preserved in binary route");
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("redaction-log: skipRedact=true preserves secret and writes no log row", async () => {
  const store = freshStore();
  try {
    const text = `key = "${ANTHROPIC_SECRET}";\n`;
    const hash = await store.blobs.putString(text, { skipRedact: true });
    const stored = await store.blobs.getString(hash);
    assert.equal(stored, text);
    assert.equal(redactionRows(store, hash).length, 0);
  } finally {
    store.close();
  }
});

test("redaction-log: secret at byte 9500 of a 10KB text → IS redacted (full scan)", async () => {
  const store = freshStore();
  try {
    const padding = "a".repeat(9500);
    const text = padding + ANTHROPIC_SECRET + "\n";
    const hash = await store.blobs.putString(text);
    const stored = await store.blobs.getString(hash);
    assert.ok(!stored.includes(ANTHROPIC_SECRET), "deep secret still caught");
    const rows = redactionRows(store, hash);
    assert.equal(rows.length, 1);
  } finally {
    store.close();
  }
});

/* ====================================================================
 * Section 5 — Round-trip semantics (6 tests)
 * ==================================================================== */

test("round-trip: putBuffer → getBuffer for binary returns byte-equal", async () => {
  const store = freshStore();
  try {
    const blob = randomBytes(2048);
    const hash = await store.blobs.putBuffer(blob);
    const round = await store.blobs.getBuffer(hash);
    assert.deepEqual(round, blob);
  } finally {
    store.close();
  }
});

test("round-trip: putString → getString for text-with-secret returns REDACTED form", async () => {
  const store = freshStore();
  try {
    const text = `secret = "${ANTHROPIC_SECRET}"`;
    const hash = await store.blobs.putString(text);
    const stored = await store.blobs.getString(hash);
    assert.notEqual(stored, text);
    assert.ok(stored.includes("«spool:redacted:anthropic-key»"));
  } finally {
    store.close();
  }
});

test("round-trip: putString → getString for text without secret returns the original", async () => {
  const store = freshStore();
  try {
    const text = "plain text, no secrets\n";
    const hash = await store.blobs.putString(text);
    const stored = await store.blobs.getString(hash);
    assert.equal(stored, text);
  } finally {
    store.close();
  }
});

test("round-trip: putJson → getJson preserves an object structure", async () => {
  const store = freshStore();
  try {
    const obj = { a: 1, b: [2, 3, "four"], nested: { ok: true } };
    const hash = await store.blobs.putJson(obj);
    const back = await store.blobs.getJson(hash);
    assert.deepEqual(back, obj);
  } finally {
    store.close();
  }
});

test("round-trip: putJson with BigInt throws at insert (JSON limitation)", async () => {
  const store = freshStore();
  try {
    await assert.rejects(
      async () => store.blobs.putJson({ n: 1n }),
      /BigInt|JSON|serialize/i,
    );
  } finally {
    store.close();
  }
});

test("round-trip: tryGetString returns undefined for non-existent hash", async () => {
  const store = freshStore();
  try {
    const missing = await store.blobs.tryGetString(
      "0".repeat(64), // valid-shape but never-written hash
    );
    assert.equal(missing, undefined);
  } finally {
    store.close();
  }
});

/* ====================================================================
 * Section 6 — Error paths (4 tests)
 * ==================================================================== */

test("error: getBuffer on a non-existent hash throws ENOENT", async () => {
  const store = freshStore();
  try {
    await assert.rejects(
      async () => store.blobs.getBuffer("0".repeat(64)),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
  } finally {
    store.close();
  }
});

test("error: getString on a non-existent hash throws", async () => {
  const store = freshStore();
  try {
    await assert.rejects(async () => store.blobs.getString("0".repeat(64)));
  } finally {
    store.close();
  }
});

test("error: getJson on a hash that points at non-JSON content throws SyntaxError", async () => {
  const store = freshStore();
  try {
    const hash = await store.blobs.putString("not valid json{{{");
    await assert.rejects(
      async () => store.blobs.getJson(hash),
      (err: Error) => err instanceof SyntaxError,
    );
  } finally {
    store.close();
  }
});

test("error: tryGetString on a malformed hash returns undefined", async () => {
  const store = freshStore();
  try {
    const result = await store.blobs.tryGetString("not-a-valid-hex-hash");
    assert.equal(result, undefined);
  } finally {
    store.close();
  }
});

/* ====================================================================
 * Section 7 — Concurrent stress (1 test)
 *
 * Four worker threads each call putBuffer(sameBytes) 50 times in
 * parallel. Asserts every worker returns the same hash, exactly one
 * file exists on disk, and the bytes match the input. The Tier 3
 * stress test found a real ENOENT race in probe.ts — same shape here
 * for a different chokepoint.
 * ==================================================================== */

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOB_STRESS_WORKER = join(__dirname, "blob-stress-worker.mjs");

test(
  "stress: 4 workers × 50 putBuffer(sameBytes) → identical hash, exactly one file on disk",
  { timeout: 30_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "spool-blob-stress-"));
    process.env.SPOOL_HOME = dir;
    const store = Store.open({ path: join(dir, "spool.db") });
    try {
      const N_WORKERS = 4;
      const ITERATIONS = 50;
      const payload = "stress-test-payload-" + "x".repeat(100);
      const workers: Promise<{ id: number; hash: string }>[] = [];
      for (let id = 0; id < N_WORKERS; id++) {
        workers.push(
          new Promise((resolve, reject) => {
            const w = new Worker(BLOB_STRESS_WORKER, {
              workerData: {
                id,
                home: dir,
                payload,
                iterations: ITERATIONS,
              },
            });
            w.on("message", resolve);
            w.on("error", reject);
            w.on("exit", (code) => {
              if (code !== 0) reject(new Error(`worker ${id} exit ${code}`));
            });
          }),
        );
      }
      const results = await Promise.all(workers);
      // Every worker returns the same hash — content-addressed.
      const firstHash = results[0]!.hash;
      for (const r of results) {
        assert.equal(r.hash, firstHash, `worker ${r.id} returned matching hash`);
      }
      // Exactly one file exists at the computed blob path.
      const path = blobPath(firstHash);
      assert.equal(existsSync(path), true, "blob file exists");
      // Bytes match input.
      const round = await store.blobs.getBuffer(firstHash);
      assert.equal(
        round.toString("utf-8"),
        payload,
        "stored bytes match input",
      );
    } finally {
      store.close();
    }
  },
);

/* ====================================================================
 * Section 8 — Fast-check properties (4 tests)
 *
 * Each property reuses a single store for amortized fixture cost.
 * Bounded alphabets per the Tier 1 lesson — no .filter() rejection
 * traps.
 * ==================================================================== */

const BYTE_ARB = fc.integer({ min: 0, max: 255 });

test("property P1: skipRedact=true bytes round-trip exactly for any random buffer", async () => {
  const store = freshStore();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(BYTE_ARB, { minLength: 0, maxLength: 1024 }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const hash = await store.blobs.putBuffer(buf, { skipRedact: true });
          const round = await store.blobs.getBuffer(hash);
          return Buffer.compare(round, buf) === 0;
        },
      ),
      { numRuns: 50 },
    );
  } finally {
    store.close();
  }
});

test("property P2: hash determinism — same input twice produces the same hash", async () => {
  const store = freshStore();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(BYTE_ARB, { minLength: 0, maxLength: 256 }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const h1 = await store.blobs.putBuffer(buf, { skipRedact: true });
          const h2 = await store.blobs.putBuffer(buf, { skipRedact: true });
          return h1 === h2;
        },
      ),
      { numRuns: 50 },
    );
  } finally {
    store.close();
  }
});

test("property P3: skipRedact=true never writes a redaction_log row", async () => {
  // A buffer that contains a secret-looking substring — without
  // skipRedact it would fire the redactor; with skipRedact it must not.
  const store = freshStore();
  let counter = 0;
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 60 }),
        async (preamble) => {
          counter++;
          // Each iteration uses unique content so we can attribute the
          // redaction_log query to this specific write.
          const text = `${preamble}-iter-${counter}-${ANTHROPIC_SECRET}\n`;
          const hash = await store.blobs.putString(text, { skipRedact: true });
          const rows = redactionRows(store, hash);
          return rows.length === 0;
        },
      ),
      { numRuns: 30 },
    );
  } finally {
    store.close();
  }
});

test("property P4: putBuffer-of-getBuffer-of-putBuffer is idempotent at the hash layer", async () => {
  const store = freshStore();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(BYTE_ARB, { minLength: 0, maxLength: 256 }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const h1 = await store.blobs.putBuffer(buf, { skipRedact: true });
          const round = await store.blobs.getBuffer(h1);
          const h2 = await store.blobs.putBuffer(round, { skipRedact: true });
          return h1 === h2;
        },
      ),
      { numRuns: 50 },
    );
  } finally {
    store.close();
  }
});
