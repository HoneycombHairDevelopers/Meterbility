/**
 * Shape probe — Claude Code JSONL drift detector.
 *
 * Claude Code's on-disk JSONL format is undocumented and changes
 * without notice (see the `file-history-snapshot` rewrite that drove
 * the `schema-modification` branch). This probe validates each parsed
 * record against the shape `types.ts` claims, dedupes findings by
 * structural hash so a single drift produces one warning instead of
 * thousands, and stays best-effort — it never throws. The parser keeps
 * working via defensive `?.` lookups; the probe's warning is the
 * signal to update the type.
 *
 * Integration points:
 *
 *   1. `LiveInspector.start()` runs the probe against the newest few
 *      sessions during silent backfill. Drift is logged to stderr once
 *      per unique shape hash.
 *
 *   2. A future CI job can call `probeRecords` over a fixture corpus
 *      and fail the build on any returned warnings.
 *
 * Adding a new known record type:
 *
 *   1. Add the interface to `types.ts`.
 *   2. Add a matching entry to `EXPECTED_SHAPES` below.
 *   3. Run the test suite — the regression test pins the canonical
 *      file-history-snapshot drift case so we never regress on that
 *      specifically.
 */

import type { ClaudeRecord } from "./types.ts";

/** A single divergent shape, deduplicated across all records that match it. */
export interface ShapeWarning {
  /** `record.type` of the divergent records (or "<missing>" if absent). */
  recordType: string;
  /**
   * Dedupe key — `(recordType, sorted missingKeys, sorted unexpectedKeys,
   * sorted typeMismatch paths)`. Two records reporting the same KIND of
   * drift collapse to one warning. We deliberately do NOT dedupe by the
   * full record structuralHash, because that splits "same drift" warnings
   * across content-shape variants — e.g., two assistant records with
   * identical unexpected keys but differently-sized content arrays would
   * otherwise produce separate warnings and drown the actual signal.
   */
  driftKey: string;
  /** Required keys our spec demanded but the record didn't have. */
  missingKeys: string[];
  /**
   * Keys present on the record that our spec doesn't know about. New CC
   * fields land here — usually the most useful drift signal.
   */
  unexpectedKeys: string[];
  /** Fields where the value type didn't match the spec. */
  typeMismatches: TypeMismatch[];
  /** Number of records sharing this drift key. */
  count: number;
  /**
   * A redacted "shape sketch" of one matching record — string values
   * are replaced with their type names so we can log it without
   * leaking session content.
   */
  exampleShape: unknown;
}

export interface TypeMismatch {
  /** Dot-path into the record, e.g. `snapshot.trackedFileBackups`. */
  path: string;
  /** What our spec expected (e.g. "object", "string", "string|null"). */
  expected: string;
  /** What we actually observed. */
  actual: string;
}

// ─── Expected shapes ────────────────────────────────────────────────
//
// Each entry encodes what we believe the record SHOULD look like, per
// the matching interface in `types.ts`. Keys here MUST stay in sync
// with types.ts — when you intentionally change one, change the other.
//
// The format is deliberately not Zod-y: required/optional are explicit
// objects rather than a chain of method calls, so an LLM (or human)
// can scan the file and immediately see "what does CC owe us."

type TypeName =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array"
  | "undefined";

interface FieldSpec {
  /** Allowed primitive type names, OR a nested ShapeSpec for "object". */
  types: TypeName[];
  /** For objects, validate the nested shape. */
  nested?: ShapeSpec;
  /** For arrays, validate every element against this spec. */
  element?: FieldSpec;
  /**
   * For string-keyed maps (records). When present, the value is
   * treated as `Record<string, X>` and X is validated against this.
   */
  recordValue?: FieldSpec;
  /**
   * Skip deep validation. Used for `message.content` items'
   * `input` / `content`, which carry arbitrary tool payloads we
   * deliberately don't constrain.
   */
  opaque?: boolean;
}

interface ShapeSpec {
  required: Record<string, FieldSpec>;
  optional: Record<string, FieldSpec>;
}

const BASE_OPTIONAL: Record<string, FieldSpec> = {
  sessionId: { types: ["string"] },
  timestamp: { types: ["string"] },
  uuid: { types: ["string"] },
  parentUuid: { types: ["string", "null"] },
  cwd: { types: ["string"] },
  gitBranch: { types: ["string"] },
  version: { types: ["string"] },
};

const MESSAGE_SPEC: ShapeSpec = {
  required: {
    role: { types: ["string"] },
    content: {
      // string OR array of content blocks
      types: ["string", "array"],
      element: { types: ["object"], opaque: true },
    },
  },
  optional: {
    model: { types: ["string"] },
    id: { types: ["string"] },
    usage: {
      types: ["object"],
      nested: {
        required: {
          input_tokens: { types: ["number"] },
          output_tokens: { types: ["number"] },
        },
        optional: {
          cache_read_input_tokens: { types: ["number"] },
          cache_creation_input_tokens: { types: ["number"] },
          cache_creation: {
            types: ["object"],
            nested: {
              required: {},
              optional: {
                ephemeral_5m_input_tokens: { types: ["number"] },
                ephemeral_1h_input_tokens: { types: ["number"] },
              },
            },
          },
          service_tier: { types: ["string"] },
        },
      },
    },
  },
};

const EXPECTED_SHAPES: Record<string, ShapeSpec> = {
  user: {
    required: {
      type: { types: ["string"] },
      message: { types: ["object"], nested: MESSAGE_SPEC },
    },
    optional: BASE_OPTIONAL,
  },
  assistant: {
    required: {
      type: { types: ["string"] },
      message: { types: ["object"], nested: MESSAGE_SPEC },
    },
    optional: { ...BASE_OPTIONAL, requestId: { types: ["string"] } },
  },
  system: {
    required: {
      type: { types: ["string"] },
    },
    optional: {
      ...BASE_OPTIONAL,
      subtype: { types: ["string"] },
      durationMs: { types: ["number"] },
      messageCount: { types: ["number"] },
    },
  },
  "file-history-snapshot": {
    required: {
      type: { types: ["string"] },
      messageId: { types: ["string"] },
      snapshot: {
        types: ["object"],
        nested: {
          required: {
            messageId: { types: ["string"] },
            trackedFileBackups: {
              types: ["object"],
              recordValue: {
                types: ["object"],
                nested: {
                  required: {
                    backupFileName: { types: ["string", "null"] },
                  },
                  optional: {
                    version: { types: ["number"] },
                    backupTime: { types: ["string"] },
                  },
                },
              },
            },
          },
          optional: { timestamp: { types: ["string"] } },
        },
      },
    },
    optional: {
      ...BASE_OPTIONAL,
      isSnapshotUpdate: { types: ["boolean"] },
    },
  },
};

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Validate one parsed record. Returns null if the shape matches the
 * spec for its `type`, or a ShapeWarning describing the divergence.
 * Records whose `type` isn't in EXPECTED_SHAPES produce a warning
 * categorized as `unknown-type:<type>` — new record types are drift
 * we want to know about.
 */
export function probeRecord(record: unknown): ShapeWarning | null {
  if (typeof record !== "object" || record === null) {
    const mismatch: TypeMismatch[] = [
      { path: "$", expected: "object", actual: typeName(record) },
    ];
    return {
      recordType: "<non-object>",
      driftKey: driftKeyOf("<non-object>", [], [], mismatch),
      missingKeys: [],
      unexpectedKeys: [],
      typeMismatches: mismatch,
      count: 1,
      exampleShape: typeName(record),
    };
  }

  const obj = record as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "<missing>";
  const spec = EXPECTED_SHAPES[type];

  if (!spec) {
    // Unknown record type — flag it. The drift key is just the type
    // name, so every record of an unknown type collapses to one warning.
    const recordType = `unknown-type:${type}`;
    return {
      recordType,
      driftKey: driftKeyOf(recordType, [], Object.keys(obj), []),
      missingKeys: [],
      unexpectedKeys: Object.keys(obj),
      typeMismatches: [],
      count: 1,
      exampleShape: shapeSketch(obj),
    };
  }

  const finding = validateAgainstSpec(obj, spec, "");
  if (
    finding.missingKeys.length === 0 &&
    finding.unexpectedKeys.length === 0 &&
    finding.typeMismatches.length === 0
  ) {
    return null;
  }

  return {
    recordType: type,
    driftKey: driftKeyOf(
      type,
      finding.missingKeys,
      finding.unexpectedKeys,
      finding.typeMismatches,
    ),
    missingKeys: finding.missingKeys,
    unexpectedKeys: finding.unexpectedKeys,
    typeMismatches: finding.typeMismatches,
    count: 1,
    exampleShape: shapeSketch(obj),
  };
}

/**
 * Build the dedupe key. Sorting on all three lists makes it stable
 * regardless of the order in which the validator happened to discover
 * the divergences.
 */
function driftKeyOf(
  recordType: string,
  missingKeys: string[],
  unexpectedKeys: string[],
  typeMismatches: TypeMismatch[],
): string {
  const mismatch = typeMismatches
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((m) => `${m.path}=${m.expected}→${m.actual}`)
    .join(";");
  return [
    recordType,
    `missing:${missingKeys.slice().sort().join(",")}`,
    `unexpected:${unexpectedKeys.slice().sort().join(",")}`,
    `mismatch:${mismatch}`,
  ].join("|");
}

/**
 * Probe a batch of records. Findings are deduplicated by structural
 * hash — N records with the same drift produce one warning whose
 * `count` is N. Result is sorted by descending count so the most
 * common drift surfaces first.
 */
export function probeRecords(records: ReadonlyArray<ClaudeRecord | unknown>): ShapeWarning[] {
  const byKey = new Map<string, ShapeWarning>();
  for (const r of records) {
    const w = probeRecord(r);
    if (!w) continue;
    const existing = byKey.get(w.driftKey);
    if (existing) existing.count += 1;
    else byKey.set(w.driftKey, w);
  }
  return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
}

/**
 * Format one warning for terminal output. Keeps it dense — operators
 * skim these in a startup log alongside other lines.
 */
export function formatWarning(w: ShapeWarning): string {
  const parts: string[] = [
    `[spool/shape-probe] ${w.recordType} (×${w.count})`,
  ];
  if (w.missingKeys.length) {
    parts.push(`  missing: ${w.missingKeys.join(", ")}`);
  }
  if (w.unexpectedKeys.length) {
    parts.push(`  unexpected: ${w.unexpectedKeys.join(", ")}`);
  }
  for (const m of w.typeMismatches) {
    parts.push(`  type mismatch at ${m.path}: expected ${m.expected}, got ${m.actual}`);
  }
  return parts.join("\n");
}

// ─── Validation core ────────────────────────────────────────────────

interface Finding {
  missingKeys: string[];
  unexpectedKeys: string[];
  typeMismatches: TypeMismatch[];
}

function validateAgainstSpec(
  obj: Record<string, unknown>,
  spec: ShapeSpec,
  pathPrefix: string,
): Finding {
  const finding: Finding = {
    missingKeys: [],
    unexpectedKeys: [],
    typeMismatches: [],
  };

  const known = new Set<string>();
  for (const key of Object.keys(spec.required)) known.add(key);
  for (const key of Object.keys(spec.optional)) known.add(key);

  for (const [key, fieldSpec] of Object.entries(spec.required)) {
    if (!(key in obj)) {
      finding.missingKeys.push(pathOf(pathPrefix, key));
      continue;
    }
    checkField(obj[key], fieldSpec, pathOf(pathPrefix, key), finding);
  }

  for (const [key, fieldSpec] of Object.entries(spec.optional)) {
    if (!(key in obj)) continue;
    if (obj[key] === undefined) continue;
    checkField(obj[key], fieldSpec, pathOf(pathPrefix, key), finding);
  }

  for (const key of Object.keys(obj)) {
    if (!known.has(key)) finding.unexpectedKeys.push(pathOf(pathPrefix, key));
  }

  return finding;
}

function checkField(
  value: unknown,
  field: FieldSpec,
  path: string,
  finding: Finding,
): void {
  const actual = typeName(value);
  if (!field.types.includes(actual)) {
    finding.typeMismatches.push({
      path,
      expected: field.types.join("|"),
      actual,
    });
    return;
  }
  if (field.opaque) return;

  if (actual === "object" && field.nested) {
    const sub = validateAgainstSpec(
      value as Record<string, unknown>,
      field.nested,
      path,
    );
    finding.missingKeys.push(...sub.missingKeys);
    finding.unexpectedKeys.push(...sub.unexpectedKeys);
    finding.typeMismatches.push(...sub.typeMismatches);
    return;
  }

  if (actual === "object" && field.recordValue) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      checkField(v, field.recordValue, `${path}.${key}`, finding);
    }
    return;
  }

  if (actual === "array" && field.element) {
    for (const [i, v] of (value as unknown[]).entries()) {
      checkField(v, field.element, `${path}[${i}]`, finding);
    }
  }
}

function pathOf(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

// ─── Shape utilities ────────────────────────────────────────────────

/**
 * The runtime "type name" we use throughout the probe. JavaScript's
 * builtin typeof returns "object" for arrays and null, which would
 * conflate cases the probe needs to distinguish, so we narrow:
 *   - null   → "null"
 *   - []     → "array"
 *   - {}     → "object"
 *   - other  → typeof value
 */
export function typeName(value: unknown): TypeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "undefined" || t === "object") {
    return t;
  }
  // `function`, `symbol`, `bigint` — never expected in JSONL records.
  return "object";
}

/**
 * Stable, recursive structural hash. Two values whose SHAPES (keys
 * and value types, recursively) match get the same hash, regardless
 * of values or key insertion order.
 *
 * Arrays collapse to the shape of their elements: `[1, 2, 3]` and
 * `[1, 2]` hash the same. That's intentional — CC records often
 * vary in array length but not element shape, and we don't want
 * length noise to inflate the dedupe map.
 */
export function structuralHash(value: unknown): string {
  return shapeOf(value);
}

function shapeOf(value: unknown): string {
  const t = typeName(value);
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj).sort().map((k) => `${k}:${shapeOf(obj[k])}`);
    return `{${entries.join(",")}}`;
  }
  if (t === "array") {
    const arr = value as unknown[];
    if (arr.length === 0) return "[]";
    // Collapse element shapes — any element shape that appears at
    // least once is in the signature. Keep them sorted for stability.
    const elementShapes = new Set<string>();
    for (const item of arr) elementShapes.add(shapeOf(item));
    return `[${Array.from(elementShapes).sort().join("|")}]`;
  }
  return t;
}

/**
 * A redacted "shape sketch" suitable for logging: strings/numbers/
 * booleans are replaced with their type name, structure is preserved.
 * Lets operators see WHAT changed without leaking session content
 * (file paths, prompts, tool outputs).
 */
function shapeSketch(value: unknown): unknown {
  const t = typeName(value);
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = shapeSketch(v);
    return out;
  }
  if (t === "array") {
    const arr = value as unknown[];
    if (arr.length === 0) return [];
    return [shapeSketch(arr[0])];
  }
  return `<${t}>`;
}
