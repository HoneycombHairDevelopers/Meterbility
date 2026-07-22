import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  Store,
  insertRun,
  insertStep,
  insertFileChange,
  listFileChanges,
  upsertAgent,
  upsertProjectByCwd,
} from "@meterbility/collector";
import type { Run, Step } from "@meterbility/shared";
import { FileSentinel, type FileSentinelEvent } from "./file_sentinel.ts";

/**
 * Deterministic daemon tests: no OS watcher involved. Each test primes
 * the snapshot, mutates the filesystem, then feeds paths through
 * `enqueue()` + `flushNow()` — the exact pipeline `fs.watch` drives in
 * production, minus the platform-dependent event timing.
 */

interface Ctx {
  home: string;
  root: string;
  store: Store;
  events: FileSentinelEvent[];
  daemon: FileSentinel;
  runId: string;
  stepId: string;
  cleanup(): void;
}

async function setup(opts: {
  files?: Record<string, string>;
  stepAgeMs?: number;
  runStatus?: Run["status"];
  runCwd?: string | null;
} = {}): Promise<Ctx> {
  const home = mkdtempSync(join(tmpdir(), "meter-fw-"));
  process.env.METERBILITY_HOME = home;
  // macOS tmpdir is a /var → /private/var symlink; resolve so the
  // daemon's path math matches the run's cwd.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "meter-fw-root-")));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const store = Store.open({ path: join(home, "meterbility.db") });

  const project = upsertProjectByCwd(store, root, "fw-test");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const stepAge = opts.stepAgeMs ?? 1_000;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_runtime: "claude-code",
    status: opts.runStatus ?? "in_progress",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    cwd: opts.runCwd === null ? undefined : (opts.runCwd ?? root),
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 1,
    tags: [],
  };
  insertRun(store, run);
  const stepId = `stp_${randomUUID()}`;
  const step: Step = {
    step_id: stepId,
    run_id: runId,
    sequence: 0,
    timestamp: new Date(Date.now() - stepAge).toISOString(),
    model: "claude-opus-4-7",
    context_snapshot_id: "snap_x",
    decision_ref: "blob_dec",
    action: { kind: "tool_call", tool_name: "Bash", tool_input: { command: "make build" } },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
  };
  insertStep(store, step);

  const daemon = new FileSentinel(store, { root });
  const events: FileSentinelEvent[] = [];
  daemon.on("data", (e: FileSentinelEvent) => events.push(e));
  await daemon.prime();

  return {
    home,
    root,
    store,
    events,
    daemon,
    runId,
    stepId,
    cleanup: () => {
      daemon.stop();
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("watch --files: modify emits a full-fidelity filesystem_watch row", async () => {
  const ctx = await setup({ files: { "src/app.ts": "line one\nline two\n" } });
  try {
    writeFileSync(join(ctx.root, "src/app.ts"), "line one\nline CHANGED\n");
    ctx.daemon.enqueue("src/app.ts");
    await ctx.daemon.flushNow();

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    const fc = rows[0]!;
    assert.equal(fc.derived_from, "filesystem_watch");
    assert.equal(fc.op, "modify");
    assert.equal(fc.path, "src/app.ts");
    assert.equal(fc.partial_diff, false);
    assert.ok(fc.before_blob_ref);
    assert.ok(fc.after_blob_ref);
    assert.equal(fc.lines_added, 1);
    assert.equal(fc.lines_removed, 1);
    assert.match(fc.patch_text ?? "", /-line two/);
    assert.match(fc.patch_text ?? "", /\+line CHANGED/);
    const notes = fc.normalizer_notes as Record<string, unknown>;
    assert.equal(notes.attributed_by, "temporal_proximity");
    assert.equal(typeof notes.gap_ms, "number");

    const captured = ctx.events.find((e) => e.type === "file:captured");
    assert.ok(captured && captured.type === "file:captured");
    assert.equal(captured.step_id, ctx.stepId);
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: create and delete round-trip", async () => {
  const ctx = await setup({ files: { "keep.txt": "kept\n" } });
  try {
    writeFileSync(join(ctx.root, "fresh.txt"), "hello\nworld\n");
    ctx.daemon.enqueue("fresh.txt");
    await ctx.daemon.flushNow();

    unlinkSync(join(ctx.root, "keep.txt"));
    ctx.daemon.enqueue("keep.txt");
    await ctx.daemon.flushNow();

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 2);
    const create = rows.find((r) => r.op === "create")!;
    assert.equal(create.path, "fresh.txt");
    assert.equal(create.before_blob_ref, undefined);
    assert.ok(create.after_blob_ref);
    assert.equal(create.lines_added, 2);

    const del = rows.find((r) => r.op === "delete")!;
    assert.equal(del.path, "keep.txt");
    assert.ok(del.before_blob_ref);
    assert.equal(del.after_blob_ref, undefined);
    assert.equal(del.lines_removed, 1);
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: ignored paths never reach processing", async () => {
  const ctx = await setup();
  try {
    mkdirSync(join(ctx.root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(ctx.root, "node_modules/pkg/index.js"), "x");
    writeFileSync(join(ctx.root, ".env"), "SECRET=1");
    ctx.daemon.enqueue("node_modules/pkg/index.js");
    ctx.daemon.enqueue(".env");
    ctx.daemon.enqueue(".git/HEAD");
    await ctx.daemon.flushNow();

    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
    assert.equal(ctx.events.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: unchanged content is skipped", async () => {
  const ctx = await setup({ files: { "same.txt": "stable\n" } });
  try {
    writeFileSync(join(ctx.root, "same.txt"), "stable\n"); // touch, same bytes
    ctx.daemon.enqueue("same.txt");
    await ctx.daemon.flushNow();

    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
    assert.deepEqual(
      ctx.events.map((e) => e.type),
      ["file:skipped"],
    );
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: full tool_call row for the same path wins", async () => {
  const ctx = await setup({ files: { "src/x.ts": "a\n" } });
  try {
    const beforeRef = await ctx.store.blobs.putString("a\n");
    const afterRef = await ctx.store.blobs.putString("b\n");
    insertFileChange(ctx.store, {
      run_id: ctx.runId,
      step_id: ctx.stepId,
      sequence: 0,
      derived_from: "tool_call",
      path: "src/x.ts",
      op: "modify",
      before_blob_ref: beforeRef,
      after_blob_ref: afterRef,
      partial_diff: false,
      gitignored: false,
      bom: false,
      lines_added: 1,
      lines_removed: 1,
      redacted: false,
    });

    writeFileSync(join(ctx.root, "src/x.ts"), "b\n");
    ctx.daemon.enqueue("src/x.ts");
    await ctx.daemon.flushNow();

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1); // only the tool_call row
    assert.equal(rows[0]!.derived_from, "tool_call");
    const skipped = ctx.events.find((e) => e.type === "file:skipped");
    assert.ok(skipped && skipped.type === "file:skipped");
    assert.equal(skipped.reason, "duplicate-tool-call");
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: watch row sequences continue after existing rows", async () => {
  const ctx = await setup({ files: { "src/x.ts": "a\n" } });
  try {
    // A partial Bash stub at sequence 0 (what the JSONL adapter emits)
    // must NOT block the watch row — it's exactly what we supplement.
    insertFileChange(ctx.store, {
      run_id: ctx.runId,
      step_id: ctx.stepId,
      sequence: 0,
      derived_from: "tool_call",
      path: "(shell)",
      op: "modify",
      partial_diff: true,
      gitignored: false,
      bom: false,
      lines_added: 0,
      lines_removed: 0,
      redacted: false,
    });

    writeFileSync(join(ctx.root, "src/x.ts"), "b\n");
    ctx.daemon.enqueue("src/x.ts");
    await ctx.daemon.flushNow();

    const rows = listFileChanges(ctx.store, { stepId: ctx.stepId });
    assert.equal(rows.length, 2);
    const watchRow = rows.find((r) => r.derived_from === "filesystem_watch")!;
    assert.equal(watchRow.sequence, 1);
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: no in-progress run → unattributed, no row", async () => {
  const ctx = await setup({
    files: { "a.txt": "x\n" },
    runStatus: "ok",
  });
  try {
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    ctx.daemon.enqueue("a.txt");
    await ctx.daemon.flushNow();

    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
    const un = ctx.events.find((e) => e.type === "file:unattributed");
    assert.ok(un && un.type === "file:unattributed");
    assert.equal(un.reason, "no-active-run");
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: stale step outside the window → no-recent-step", async () => {
  const ctx = await setup({
    files: { "a.txt": "x\n" },
    stepAgeMs: 10 * 60_000, // 10 minutes > 120s default window
  });
  try {
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    ctx.daemon.enqueue("a.txt");
    await ctx.daemon.flushNow();

    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
    const un = ctx.events.find((e) => e.type === "file:unattributed");
    assert.ok(un && un.type === "file:unattributed");
    assert.equal(un.reason, "no-recent-step");
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: run cwd mismatch → no-active-run", async () => {
  const ctx = await setup({
    files: { "a.txt": "x\n" },
    runCwd: "/somewhere/else/entirely",
  });
  try {
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    ctx.daemon.enqueue("a.txt");
    await ctx.daemon.flushNow();

    const un = ctx.events.find((e) => e.type === "file:unattributed");
    assert.ok(un && un.type === "file:unattributed");
    assert.equal(un.reason, "no-active-run");
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: binary content gets a binary row, no patch text", async () => {
  const ctx = await setup();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    writeFileSync(join(ctx.root, "img.png"), png);
    ctx.daemon.enqueue("img.png");
    await ctx.daemon.flushNow();

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.op, "create");
    assert.equal(rows[0]!.patch_format, "binary");
    assert.equal(rows[0]!.patch_text, undefined);
    assert.equal(rows[0]!.encoding, "binary");
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: deleting a directory fans out to tracked children", async () => {
  const ctx = await setup({
    files: { "pkg/a.txt": "one\n", "pkg/b.txt": "two\n" },
  });
  try {
    rmSync(join(ctx.root, "pkg"), { recursive: true });
    ctx.daemon.enqueue("pkg");
    await ctx.daemon.flushNow();

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.path).sort(),
      ["pkg/a.txt", "pkg/b.txt"],
    );
    assert.ok(rows.every((r) => r.op === "delete" && r.before_blob_ref));
  } finally {
    ctx.cleanup();
  }
});

test("watch --files: duplicate event for identical content is deduped", async () => {
  const ctx = await setup({ files: { "a.txt": "x\n" } });
  try {
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    ctx.daemon.enqueue("a.txt");
    await ctx.daemon.flushNow();
    // fs.watch commonly fires twice for one write; second pass sees
    // snapshot == disk → unchanged.
    ctx.daemon.enqueue("a.txt");
    await ctx.daemon.flushNow();

    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 1);
    const skips = ctx.events.filter((e) => e.type === "file:skipped");
    assert.equal(skips.length, 1);
  } finally {
    ctx.cleanup();
  }
});

// ─── Tier 1: real fs.watch integration ───────────────────────────────

/**
 * The only test that binds an actual OS watcher — everything above
 * drives enqueue()/flushNow() directly. Event timing is platform-
 * dependent (macOS FSEvents coalesce, inotify doesn't), so this polls
 * for convergence with a generous deadline instead of asserting on
 * sleeps. If it flakes on an exotic CI platform, the deterministic
 * suite above remains the functional gate; this one proves the wiring.
 */
test("watch --files: real fs.watch events flow end-to-end", async () => {
  const ctx = await setup({ files: { "hello.txt": "before\n" } });
  const live = new FileSentinel(ctx.store, {
    root: ctx.root,
    debounceMs: 150,
  });
  const events: FileWatcherEventLog = [];
  live.on("data", (e: FileSentinelEvent) => events.push(e.type));
  try {
    await live.start();
    // macOS FSEvents starts its stream asynchronously — writes landing
    // in the first instants after fs.watch() can be silently dropped.
    // Give the OS watcher a beat before mutating (real agent runs
    // always start well after `meter watch --files` is up).
    await new Promise((r) => setTimeout(r, 500));

    writeFileSync(join(ctx.root, "hello.txt"), "before\nafter\n"); // modify
    writeFileSync(join(ctx.root, "fresh.sh"), "#!/bin/sh\necho hi\n"); // create

    // Poll until both rows land or the deadline passes.
    const deadline = Date.now() + 10_000;
    let rows = listFileChanges(ctx.store, { runId: ctx.runId });
    while (rows.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      rows = listFileChanges(ctx.store, { runId: ctx.runId });
    }

    assert.equal(rows.length, 2, `events seen: ${events.join(",")}`);
    const mod = rows.find((r) => r.path === "hello.txt")!;
    assert.equal(mod.op, "modify");
    assert.equal(mod.lines_added, 1);
    const created = rows.find((r) => r.path === "fresh.sh")!;
    assert.equal(created.op, "create");
    assert.ok(events.includes("sentinel:ready"));
  } finally {
    live.stop();
    ctx.cleanup();
  }
});

type FileWatcherEventLog = Array<FileSentinelEvent["type"]>;

test("watch --files: oversize file degrades to a partial stub (create + modify)", async () => {
  const ctx = await setup();
  const small = new FileSentinel(ctx.store, { root: ctx.root, maxFileBytes: 8 });
  try {
    await small.prime();
    writeFileSync(join(ctx.root, "big.dat"), "0123456789ABCDEF"); // 16 > 8
    small.enqueue("big.dat");
    await small.flushNow();

    let rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.op, "create");
    assert.equal(rows[0]!.partial_diff, true);
    assert.equal(rows[0]!.before_blob_ref, undefined);
    assert.equal(rows[0]!.after_blob_ref, undefined);
    assert.equal(rows[0]!.size_after, 16);

    // Oversize modify: existence tracked, still stub, sizes honest.
    writeFileSync(join(ctx.root, "big.dat"), "0123456789ABCDEF!!"); // 18
    small.enqueue("big.dat");
    await small.flushNow();
    rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 2);
    const mod = rows.find((r) => r.op === "modify")!;
    assert.equal(mod.partial_diff, true);
    assert.equal(mod.size_before, 16);
    assert.equal(mod.size_after, 18);
  } finally {
    small.stop();
    ctx.cleanup();
  }
});

test("watch --files: NaN/invalid attribution window falls back to the default", async () => {
  // Regression: `gapMs > NaN` is always false, which silently DISABLED
  // the window (a stale step would grab every ambient edit forever).
  const ctx = await setup({
    files: { "n.txt": "x\n" },
    stepAgeMs: 10 * 60_000, // stale — outside the (default) window
  });
  const nan = new FileSentinel(ctx.store, {
    root: ctx.root,
    attributionWindowMs: Number.NaN,
  });
  const events: FileSentinelEvent[] = [];
  nan.on("data", (e: FileSentinelEvent) => events.push(e));
  try {
    await nan.prime();
    writeFileSync(join(ctx.root, "n.txt"), "y\n");
    nan.enqueue("n.txt");
    await nan.flushNow();
    const un = events.find((e) => e.type === "file:unattributed");
    assert.ok(un && un.type === "file:unattributed", "window enforced");
    assert.equal(un.reason, "no-recent-step");
  } finally {
    nan.stop();
    ctx.cleanup();
  }
});
