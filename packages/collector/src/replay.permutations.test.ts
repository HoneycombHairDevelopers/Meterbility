import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { applyFileChange } from "./replay.ts";
import type { WorkingTree } from "@meterbility/shared";

/**
 * Combinatorial + property-based coverage of `applyFileChange` —
 * the pure-function core of v0.3's replay algorithm (SPEC §3.6).
 *
 * Existing tests in `file_changes.test.ts` exercise the integration
 * end-to-end (ingest → DB → workingTreeAt) on one canonical sequence
 * (modify → create → rename → chmod → delete). This file enumerates
 * the non-trivial *operation sequences* that exercise replay's
 * correctness contracts: idempotence, last-op-wins, disjoint
 * commutativity, and edge cases like ops on missing paths.
 *
 * Testing the pure helper directly (rather than going through the
 * store) means each case is one constant-time `Map` walk — the file
 * runs in well under 100ms even with the property-based section.
 */

/** Minimal FileChange-shape understood by `applyFileChange`. */
interface FCOp {
  op: "create" | "modify" | "delete" | "rename" | "chmod";
  path: string;
  old_path?: string;
  after_blob_ref?: string;
  mode_after?: number;
  partial_diff?: boolean;
}

/** Build a FileChange with op + path; fills in `after_blob_ref` for
 *  content-bearing ops so the assertions can read it back. */
function op(
  kind: FCOp["op"],
  path: string,
  extra: Partial<FCOp> = {},
): FCOp {
  const needsBlob =
    (kind === "create" || kind === "modify" || kind === "rename") &&
    extra.after_blob_ref === undefined;
  return {
    op: kind,
    path,
    ...(needsBlob ? { after_blob_ref: `blob:${kind}:${path}` } : {}),
    ...extra,
  };
}

/** Apply a sequence of ops to a starting tree; return the final tree. */
function replay(
  initial: Iterable<[string, { blob_ref: string; mode: number }]>,
  ops: FCOp[],
): WorkingTree {
  const tree: WorkingTree = new Map(initial);
  for (const fc of ops) applyFileChange(tree, fc);
  return tree;
}

const EMPTY: Array<[string, { blob_ref: string; mode: number }]> = [];

/* ────────────────────────────────────────────────────────────────────
 * Section 1 — Single-path op-sequence permutations.
 *
 * One file's lifetime across a small sequence of ops. The "last
 * meaningful op wins" contract is what most of these pin down.
 * ──────────────────────────────────────────────────────────────────── */

interface SingleCase {
  name: string;
  ops: FCOp[];
  /** `present` checks for membership; `absent` checks for non-membership;
   *  `blob` checks the expected after_blob_ref of the surviving entry. */
  expect:
    | { present: true; path: string; blob?: string; mode?: number }
    | { present: false; path: string };
}

const SINGLE_PATH_CASES: SingleCase[] = [
  {
    name: "create alone — file is present",
    ops: [op("create", "a.ts")],
    expect: { present: true, path: "a.ts", blob: "blob:create:a.ts" },
  },
  {
    name: "create → delete — file is absent",
    ops: [op("create", "a.ts"), op("delete", "a.ts")],
    expect: { present: false, path: "a.ts" },
  },
  {
    name: "create → delete → create — second create wins",
    ops: [
      op("create", "a.ts", { after_blob_ref: "blob:v1" }),
      op("delete", "a.ts"),
      op("create", "a.ts", { after_blob_ref: "blob:v2" }),
    ],
    expect: { present: true, path: "a.ts", blob: "blob:v2" },
  },
  {
    name: "create → modify → modify — latest modify wins",
    ops: [
      op("create", "a.ts", { after_blob_ref: "blob:v1" }),
      op("modify", "a.ts", { after_blob_ref: "blob:v2" }),
      op("modify", "a.ts", { after_blob_ref: "blob:v3" }),
    ],
    expect: { present: true, path: "a.ts", blob: "blob:v3" },
  },
  {
    name: "delete on never-existed path — tree stays empty",
    ops: [op("delete", "a.ts")],
    expect: { present: false, path: "a.ts" },
  },
  {
    name: "rename A→B → rename B→A — back to original path",
    ops: [
      op("rename", "b.ts", {
        old_path: "a.ts",
        after_blob_ref: "blob:shared",
      }),
      op("rename", "a.ts", {
        old_path: "b.ts",
        after_blob_ref: "blob:shared",
      }),
    ],
    // Need the initial tree to have a.ts for the rename to be visible.
    expect: { present: true, path: "a.ts", blob: "blob:shared" },
  },
  {
    name: "rename → modify(new path) — modify lands at the new path",
    ops: [
      op("rename", "b.ts", {
        old_path: "a.ts",
        after_blob_ref: "blob:renamed",
      }),
      op("modify", "b.ts", { after_blob_ref: "blob:modified" }),
    ],
    expect: { present: true, path: "b.ts", blob: "blob:modified" },
  },
  {
    name: "chmod alone on missing path — no-op (path stays absent)",
    ops: [op("chmod", "a.ts", { mode_after: 0o100755 })],
    expect: { present: false, path: "a.ts" },
  },
  {
    name: "create then chmod — mode is updated, blob preserved",
    ops: [
      op("create", "a.ts", {
        after_blob_ref: "blob:created",
        mode_after: 0o100644,
      }),
      op("chmod", "a.ts", { mode_after: 0o100755 }),
    ],
    expect: {
      present: true,
      path: "a.ts",
      blob: "blob:created",
      mode: 0o100755,
    },
  },
  {
    name: "partial_diff modify is a no-op (Bash side effect placeholder)",
    ops: [
      op("create", "a.ts", { after_blob_ref: "blob:original" }),
      op("modify", "a.ts", {
        after_blob_ref: "blob:would-have-been-new",
        partial_diff: true,
      }),
    ],
    expect: { present: true, path: "a.ts", blob: "blob:original" },
  },
];

for (const c of SINGLE_PATH_CASES) {
  test(`replay perm: ${c.name}`, () => {
    // For the rename-back case, seed `a.ts` so the first rename has
    // something to move. Every other case starts empty.
    const initial: Array<[string, { blob_ref: string; mode: number }]> =
      c.name.startsWith("rename A→B → rename B→A")
        ? [["a.ts", { blob_ref: "blob:shared", mode: 0o100644 }]]
        : EMPTY;
    const tree = replay(initial, c.ops);
    if (c.expect.present) {
      const entry = tree.get(c.expect.path);
      assert.ok(entry, `${c.expect.path} must be present`);
      if (c.expect.blob !== undefined) {
        assert.equal(entry!.blob_ref, c.expect.blob);
      }
      if (c.expect.mode !== undefined) {
        assert.equal(entry!.mode, c.expect.mode);
      }
    } else {
      assert.equal(
        tree.has(c.expect.path),
        false,
        `${c.expect.path} must be absent`,
      );
    }
  });
}

/* ────────────────────────────────────────────────────────────────────
 * Section 2 — Multi-path interactions.
 *
 * Sequences that touch more than one path. The interesting case is
 * `rename`, which mutates two paths atomically; everything else
 * affects exactly one path per op.
 * ──────────────────────────────────────────────────────────────────── */

test("replay multi-path: rename leaves old_path absent, new path with rename blob", () => {
  const tree = replay(
    [["a.ts", { blob_ref: "blob:orig", mode: 0o100644 }]],
    [op("rename", "b.ts", { old_path: "a.ts", after_blob_ref: "blob:renamed" })],
  );
  assert.equal(tree.has("a.ts"), false, "old_path is dropped");
  assert.equal(tree.get("b.ts")?.blob_ref, "blob:renamed");
});

test("replay multi-path: deleting one path doesn't touch a sibling", () => {
  const tree = replay(
    [
      ["a.ts", { blob_ref: "blob:a", mode: 0o100644 }],
      ["b.ts", { blob_ref: "blob:b", mode: 0o100644 }],
    ],
    [op("delete", "a.ts")],
  );
  assert.equal(tree.has("a.ts"), false);
  assert.equal(tree.get("b.ts")?.blob_ref, "blob:b");
});

test("replay multi-path: rename collision overwrites the destination", () => {
  // a.ts exists. b.ts exists. Rename a.ts → b.ts. The new b.ts is the
  // rename's after_blob_ref; the old b.ts content is gone. This is the
  // git mv semantics — the destination doesn't survive.
  const tree = replay(
    [
      ["a.ts", { blob_ref: "blob:a", mode: 0o100644 }],
      ["b.ts", { blob_ref: "blob:b-existing", mode: 0o100644 }],
    ],
    [op("rename", "b.ts", { old_path: "a.ts", after_blob_ref: "blob:a-renamed" })],
  );
  assert.equal(tree.has("a.ts"), false);
  assert.equal(tree.get("b.ts")?.blob_ref, "blob:a-renamed");
});

/* ────────────────────────────────────────────────────────────────────
 * Section 3 — Property: determinism.
 *
 * Replaying the same op sequence twice on the same starting tree
 * yields identical Maps. Catches any future regression where
 * applyFileChange picks up state from outside its inputs (e.g. a
 * memoized resolver, a global cache).
 * ──────────────────────────────────────────────────────────────────── */

const PATH_CHAR = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
);
const pathSegment = fc.string({
  unit: PATH_CHAR,
  minLength: 1,
  maxLength: 6,
});
const pathPool = fc
  .array(pathSegment, { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join("/") + ".ts");

const opArb: fc.Arbitrary<FCOp> = fc
  .tuple(
    fc.constantFrom("create", "modify", "delete", "chmod" as const),
    pathPool,
    fc.integer({ min: 0, max: 999 }),
  )
  .map(([kind, path, mark]) => {
    if (kind === "delete") return { op: "delete", path };
    if (kind === "chmod") return { op: "chmod", path, mode_after: 0o100755 };
    return { op: kind, path, after_blob_ref: `blob:${kind}:${path}:${mark}` };
  });

test("property: replay is deterministic — same ops → same tree", () => {
  fc.assert(
    fc.property(
      fc.array(opArb, { maxLength: 20 }),
      (ops) => {
        const a = replay(EMPTY, ops);
        const b = replay(EMPTY, ops);
        if (a.size !== b.size) return false;
        for (const [k, va] of a) {
          const vb = b.get(k);
          if (!vb) return false;
          if (vb.blob_ref !== va.blob_ref || vb.mode !== va.mode) return false;
        }
        return true;
      },
    ),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Section 4 — Property: last meaningful op wins for each path.
 *
 * For any path P, the final state of P in the tree is determined
 * solely by the last op in the sequence that targets P. Earlier ops
 * on P are "overwritten" — except when a partial_diff op is the
 * supposed-last op, which is a no-op (so the prior real op wins).
 *
 * This property pins down the v0.3 §3.6 contract: "later steps win
 * over earlier ones." Without it, an out-of-order replay could leak
 * pre-fork state into a post-fork tree.
 * ──────────────────────────────────────────────────────────────────── */

test("property: per-path final state is determined by the last non-partial op on that path", () => {
  fc.assert(
    fc.property(fc.array(opArb, { maxLength: 15 }), (ops) => {
      const tree = replay(EMPTY, ops);
      // Group ops by path; the *last* non-partial op decides.
      const byPath = new Map<string, FCOp>();
      for (const o of ops) {
        if (o.partial_diff) continue;
        byPath.set(o.path, o);
      }
      for (const [path, lastOp] of byPath) {
        if (lastOp.op === "delete") {
          if (tree.has(path)) return false;
        } else if (lastOp.op === "chmod") {
          // chmod on a never-existed path is a no-op. Tree presence
          // depends on whether *any* prior op established the path.
          // We don't reverse-engineer that here; just check that IF
          // present, the mode matches.
          const e = tree.get(path);
          if (e && lastOp.mode_after !== undefined && e.mode !== lastOp.mode_after) {
            return false;
          }
        } else if (lastOp.op === "create" || lastOp.op === "modify") {
          const e = tree.get(path);
          if (!e || e.blob_ref !== lastOp.after_blob_ref) return false;
        }
        // rename excluded from this property — it touches two paths.
      }
      return true;
    }),
  );
});

/* ────────────────────────────────────────────────────────────────────
 * Section 5 — Property: disjoint-path commutativity.
 *
 * Two op sequences whose path sets don't overlap can be interleaved
 * in any order; the resulting tree is the same. Same idea as git's
 * notion that conflict-free patches commute.
 *
 * The check: split ops by even/odd index into two halves, ensure
 * their path sets are disjoint (skip the trial otherwise), then
 * verify that running the halves in either order produces the same
 * tree.
 * ──────────────────────────────────────────────────────────────────── */

test("property: ops on disjoint path sets commute across order", () => {
  fc.assert(
    fc.property(fc.array(opArb, { maxLength: 12 }), (ops) => {
      const left: FCOp[] = [];
      const right: FCOp[] = [];
      ops.forEach((o, i) => (i % 2 === 0 ? left : right).push(o));
      const leftPaths = new Set(left.map((o) => o.path));
      const rightPaths = new Set(right.map((o) => o.path));
      // Skip trials where the halves overlap — commutativity only
      // holds for path-disjoint slices.
      for (const p of rightPaths) if (leftPaths.has(p)) return true;

      const ab = replay(EMPTY, [...left, ...right]);
      const ba = replay(EMPTY, [...right, ...left]);
      if (ab.size !== ba.size) return false;
      for (const [k, va] of ab) {
        const vb = ba.get(k);
        if (!vb || vb.blob_ref !== va.blob_ref || vb.mode !== va.mode) {
          return false;
        }
      }
      return true;
    }),
  );
});
