import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeRecord,
  probeRecords,
  structuralHash,
  formatWarning,
  typeName,
} from "./shape_probe.ts";

// ─── typeName ───────────────────────────────────────────────────────

test("typeName narrows null, array, object distinctly from typeof", () => {
  assert.equal(typeName(null), "null");
  assert.equal(typeName([]), "array");
  assert.equal(typeName({}), "object");
  assert.equal(typeName("x"), "string");
  assert.equal(typeName(1), "number");
  assert.equal(typeName(true), "boolean");
  assert.equal(typeName(undefined), "undefined");
});

// ─── structuralHash ─────────────────────────────────────────────────

test("structuralHash: same shape, different values → same hash", () => {
  const a = { x: 1, y: "foo" };
  const b = { x: 99, y: "bar" };
  assert.equal(structuralHash(a), structuralHash(b));
});

test("structuralHash: different shape → different hash", () => {
  assert.notEqual(
    structuralHash({ x: 1 }),
    structuralHash({ x: "1" }),
  );
  assert.notEqual(
    structuralHash({ x: 1 }),
    structuralHash({ x: 1, y: 2 }),
  );
});

test("structuralHash: key order doesn't matter", () => {
  assert.equal(
    structuralHash({ a: 1, b: 2 }),
    structuralHash({ b: 2, a: 1 }),
  );
});

test("structuralHash: array length doesn't matter when element shape matches", () => {
  // Two arrays of strings hash the same regardless of length.
  assert.equal(
    structuralHash(["a", "b"]),
    structuralHash(["x", "y", "z"]),
  );
});

test("structuralHash: arrays with distinct element shapes capture both", () => {
  // Mixed-type array distinguishes from same-type array.
  assert.notEqual(
    structuralHash([1, "x"]),
    structuralHash([1, 2]),
  );
});

test("structuralHash: null is distinct from string and from object", () => {
  assert.notEqual(structuralHash(null), structuralHash("null"));
  assert.notEqual(structuralHash(null), structuralHash({}));
});

// ─── probeRecord — known-good ────────────────────────────────────────

test("probeRecord: minimal user record passes", () => {
  const r = {
    type: "user",
    message: { role: "user", content: "hello" },
  };
  assert.equal(probeRecord(r), null);
});

test("probeRecord: assistant record with content blocks passes", () => {
  const r = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "Edit", input: { path: "x" } },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
      },
    },
    requestId: "req-1",
  };
  assert.equal(probeRecord(r), null);
});

test("probeRecord: system record passes", () => {
  const r = { type: "system", subtype: "summary", durationMs: 123 };
  assert.equal(probeRecord(r), null);
});

test("probeRecord: current file-history-snapshot shape passes", () => {
  const r = {
    type: "file-history-snapshot",
    messageId: "a1",
    isSnapshotUpdate: false,
    snapshot: {
      messageId: "a1",
      trackedFileBackups: {
        "src/foo.ts": { backupFileName: "bak-1", version: 1, backupTime: "t" },
        "src/bar.ts": { backupFileName: null },
      },
      timestamp: "2026-05-19T00:00:00Z",
    },
  };
  assert.equal(probeRecord(r), null);
});

// ─── probeRecord — divergence ───────────────────────────────────────

test("probeRecord: missing required field warns", () => {
  const r = {
    type: "file-history-snapshot",
    messageId: "a1",
    // no `snapshot` — should warn
  };
  const w = probeRecord(r);
  assert.ok(w);
  assert.equal(w.recordType, "file-history-snapshot");
  assert.deepEqual(w.missingKeys, ["snapshot"]);
});

test("probeRecord: unexpected key warns", () => {
  const r = {
    type: "user",
    message: { role: "user", content: "hi" },
    aBrandNewFieldCcAdded: 123,
  };
  const w = probeRecord(r);
  assert.ok(w);
  assert.ok(w.unexpectedKeys.includes("aBrandNewFieldCcAdded"));
});

test("probeRecord: wrong primitive type at a known field warns", () => {
  const r = {
    type: "file-history-snapshot",
    messageId: 12345, // expected string
    snapshot: {
      messageId: "a1",
      trackedFileBackups: {},
    },
  };
  const w = probeRecord(r);
  assert.ok(w);
  assert.equal(w.typeMismatches.length, 1);
  assert.equal(w.typeMismatches[0]!.path, "messageId");
  assert.equal(w.typeMismatches[0]!.expected, "string");
  assert.equal(w.typeMismatches[0]!.actual, "number");
});

test("probeRecord: trackedFileBackups entry with wrong value-type warns", () => {
  const r = {
    type: "file-history-snapshot",
    messageId: "a1",
    snapshot: {
      messageId: "a1",
      trackedFileBackups: {
        "src/foo.ts": { backupFileName: 999 }, // expected string|null
      },
    },
  };
  const w = probeRecord(r);
  assert.ok(w);
  assert.equal(w.typeMismatches.length, 1);
  assert.equal(
    w.typeMismatches[0]!.path,
    "snapshot.trackedFileBackups.src/foo.ts.backupFileName",
  );
  assert.equal(w.typeMismatches[0]!.expected, "string|null");
});

test("probeRecord: unknown record type produces a categorized warning", () => {
  const r = { type: "totally-new-cc-record-type", foo: "bar" };
  const w = probeRecord(r);
  assert.ok(w);
  assert.equal(w.recordType, "unknown-type:totally-new-cc-record-type");
  assert.ok(w.unexpectedKeys.includes("type"));
  assert.ok(w.unexpectedKeys.includes("foo"));
});

test("probeRecord: non-object input warns rather than crashing", () => {
  assert.ok(probeRecord(null));
  assert.ok(probeRecord("just a string"));
  assert.ok(probeRecord(42));
});

// ─── probeRecords — dedup ───────────────────────────────────────────

test("probeRecords: identical drift across N records → one warning with count=N", () => {
  const drifted = {
    type: "user",
    message: { role: "user", content: "hi" },
    newFieldCcAdded: 1,
  };
  const warnings = probeRecords([drifted, { ...drifted }, { ...drifted }]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.count, 3);
});

test("probeRecords: distinct drifts produce distinct warnings, sorted by count desc", () => {
  const driftA = {
    type: "user",
    message: { role: "user", content: "hi" },
    a: 1,
  };
  const driftB = {
    type: "user",
    message: { role: "user", content: "hi" },
    b: "x",
  };
  const warnings = probeRecords([driftA, driftA, driftA, driftB, driftB]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0]!.count, 3);
  assert.equal(warnings[1]!.count, 2);
});

test("probeRecords: good records mixed with drifted ones — only drifted produce warnings", () => {
  const good = { type: "user", message: { role: "user", content: "ok" } };
  const drifted = { ...good, someNewField: 1 };
  const warnings = probeRecords([good, good, drifted, good]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.count, 1);
});

// ─── Regression: canonical drift case ───────────────────────────────

test("REGRESSION: the OLD pre-rewrite file-history-snapshot shape is flagged", () => {
  // This is exactly the shape that broke the parser silently and drove
  // the schema-modification branch — top-level `trackedFileBackups`
  // with absolute paths, no nested `snapshot` object. If this test
  // ever stops failing it means we've forgotten the lesson.
  const oldShape = {
    type: "file-history-snapshot",
    messageId: "a1",
    trackedFileBackups: {
      "/abs/path/src/foo.ts": { backupFileName: "bak-1" },
    },
    sessionId: "s1",
    timestamp: "2026-04-01T00:00:00Z",
  };
  const w = probeRecord(oldShape);
  assert.ok(w, "old shape must produce a warning");
  assert.equal(w.recordType, "file-history-snapshot");
  // Required `snapshot` was missing, and `trackedFileBackups` lived at
  // the top level where we no longer expect it.
  assert.ok(
    w.missingKeys.includes("snapshot"),
    `expected missingKeys to include 'snapshot', got ${w.missingKeys.join(",")}`,
  );
  assert.ok(
    w.unexpectedKeys.includes("trackedFileBackups"),
    `expected unexpectedKeys to include 'trackedFileBackups', got ${w.unexpectedKeys.join(",")}`,
  );
});

// ─── formatWarning ──────────────────────────────────────────────────

test("formatWarning: produces a multi-line block with type and count", () => {
  const w = probeRecord({
    type: "file-history-snapshot",
    messageId: "a1",
    // missing snapshot, extra field
    surpriseField: 1,
  })!;
  const text = formatWarning({ ...w, count: 7 });
  assert.match(text, /\[meter\/shape-probe\] file-history-snapshot \(×7\)/);
  assert.match(text, /missing: snapshot/);
  assert.match(text, /unexpected: surpriseField/);
});
