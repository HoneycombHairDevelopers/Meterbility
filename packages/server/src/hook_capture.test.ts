import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  capturePre,
  capturePost,
  drainStash,
  type CaptureOptions,
  type HookPayload,
} from "./hook_capture.ts";
import { FileSentinel } from "./file_sentinel.ts";

/**
 * Hook-capture pipeline tests. Ingest is injected as a no-op — the
 * store is scaffolded directly, which is exactly the state the real
 * ingest converges to; drain's retry loop is what bridges the gap in
 * production.
 */

interface Ctx {
  home: string;
  root: string;
  store: Store;
  opts: CaptureOptions;
  payload: HookPayload;
  runId: string;
  stepId: string;
  toolUseId: string;
  cleanup(): void;
}

function makeStep(
  runId: string,
  overrides: Partial<Step> & { step_id: string },
): Step {
  return {
    run_id: runId,
    sequence: 0,
    timestamp: new Date().toISOString(),
    model: "claude-opus-4-7",
    context_snapshot_id: "snap_x",
    decision_ref: "blob_dec",
    action: { kind: "tool_call", tool_name: "Bash" },
    outcome: { status: "ok" },
    tokens: { input: 0, output: 0, cached_read: 0, cache_creation: 0 },
    latency_ms: 0,
    cost_cents: 0,
    tags: [],
    status: "ok",
    ...overrides,
  };
}

async function setup(opts: {
  files?: Record<string, string>;
  command?: string;
  stepToolInput?: unknown;
  withStep?: boolean;
} = {}): Promise<Ctx> {
  const home = mkdtempSync(join(tmpdir(), "meter-hc-"));
  process.env.METERBILITY_HOME = home;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "meter-hc-root-")));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const store = Store.open({ path: join(home, "meterbility.db") });

  const sessionId = `sess-${randomUUID()}`;
  const command = opts.command ?? "make build";
  const project = upsertProjectByCwd(store, root, "hc-test");
  const agent = upsertAgent(store, project.project_id, "claude-code");
  const runId = `run_${randomUUID()}`;
  const run: Run = {
    run_id: runId,
    agent_id: agent.agent_id,
    project_id: project.project_id,
    source_session_id: sessionId,
    source_runtime: "claude-code",
    status: "in_progress",
    started_at: new Date().toISOString(),
    cwd: root,
    tokens_total_input: 0,
    tokens_total_output: 0,
    tokens_total_cached: 0,
    cost_cents: 0,
    step_count: 1,
    tags: [],
  };
  insertRun(store, run);

  const stepId = `stp_${randomUUID()}`;
  const toolUseId = `toolu_${randomUUID()}`;
  if (opts.withStep !== false) {
    insertStep(
      store,
      makeStep(runId, {
        step_id: stepId,
        action: {
          kind: "tool_call",
          tool_name: "Bash",
          tool_use_id: toolUseId,
          tool_input: opts.stepToolInput ?? { command },
        },
      }),
    );
  }

  const captureOpts: CaptureOptions = {
    stateDir: join(home, "capture-state"),
    ingest: async () => undefined,
  };
  const payload: HookPayload = {
    session_id: sessionId,
    transcript_path: join(home, "fake-transcript.jsonl"),
    cwd: root,
    tool_name: "Bash",
    tool_input: { command },
  };

  return {
    home,
    root,
    store,
    opts: captureOpts,
    payload,
    runId,
    stepId,
    toolUseId,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* closed */
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("capture: pre → change → post attributes exactly to the Bash step", async () => {
  const ctx = await setup({ files: { "src/out.txt": "one\ntwo\n" } });
  try {
    const pre = await capturePre(ctx.store, ctx.payload, ctx.opts);
    assert.equal(pre.primed, true);

    writeFileSync(join(ctx.root, "src/out.txt"), "one\nTWO!\n");
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 1);
    assert.equal(post.drained.inserted.length, 1);
    assert.equal(post.drained.pending, 0);

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    const fc = rows[0]!;
    assert.equal(fc.step_id, ctx.stepId);
    assert.equal(fc.tool_call_id, ctx.toolUseId);
    assert.equal(fc.derived_from, "filesystem_watch");
    assert.equal(fc.op, "modify");
    assert.equal(fc.partial_diff, false);
    assert.match(fc.patch_text ?? "", /-two/);
    assert.match(fc.patch_text ?? "", /\+TWO!/);
    const notes = fc.normalizer_notes as Record<string, unknown>;
    assert.equal(notes.attributed_by, "hook");
  } finally {
    ctx.cleanup();
  }
});

test("capture: pre folds ambient edits into the baseline (no rows)", async () => {
  const ctx = await setup({ files: { "notes.md": "draft\n" } });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts); // primes
    // Ambient edit BETWEEN steps (user in their editor, or an Edit tool
    // that has exact capture already).
    writeFileSync(join(ctx.root, "notes.md"), "draft v2\n");
    const pre2 = await capturePre(ctx.store, ctx.payload, ctx.opts);
    assert.equal(pre2.primed, false);
    assert.equal(pre2.refreshed, 1);

    // The Bash step then changes nothing → nothing observed.
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 0);
    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("capture: transcript lag — stash stays pending, drains once the step lands", async () => {
  const ctx = await setup({
    files: { "a.txt": "x\n" },
    withStep: false, // step not ingested yet at post time
  });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 1);
    assert.equal(post.drained.inserted.length, 0);
    assert.equal(post.drained.pending, 1);

    // Ingest catches up: the Bash step appears.
    insertStep(
      ctx.store,
      makeStep(ctx.runId, {
        step_id: ctx.stepId,
        action: {
          kind: "tool_call",
          tool_name: "Bash",
          tool_use_id: ctx.toolUseId,
          tool_input: { command: "make build" },
        },
      }),
    );
    const drained = await drainStash(ctx.store, ctx.opts);
    assert.equal(drained.inserted.length, 1);
    assert.equal(drained.pending, 0);
    assert.equal(drained.inserted[0]!.step_id, ctx.stepId);
  } finally {
    ctx.cleanup();
  }
});

test("capture: unattributable record expires after the TTL", async () => {
  const ctx = await setup({ files: { "a.txt": "x\n" }, withStep: false });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    await capturePost(ctx.store, ctx.payload, ctx.opts);

    await new Promise((r) => setTimeout(r, 15));
    const drained = await drainStash(ctx.store, {
      ...ctx.opts,
      stashTtlMs: 10,
    });
    assert.equal(drained.expired, 1);
    assert.equal(drained.pending, 0);
    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("capture: full tool_call row for the path wins (dedup)", async () => {
  const ctx = await setup({ files: { "src/x.ts": "a\n" } });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
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
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 1);
    assert.equal(post.drained.inserted.length, 0); // deduped

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.derived_from, "tool_call");
  } finally {
    ctx.cleanup();
  }
});

test("capture: command-only match when step input has extra fields", async () => {
  const ctx = await setup({
    files: { "a.txt": "x\n" },
    stepToolInput: {
      command: "make build",
      description: "Build the project",
    },
  });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.drained.inserted.length, 1);
    assert.equal(post.drained.inserted[0]!.step_id, ctx.stepId);
  } finally {
    ctx.cleanup();
  }
});

test("capture: delete between pre and post yields a full delete row", async () => {
  const ctx = await setup({ files: { "gone.txt": "bye\nbye\n" } });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    unlinkSync(join(ctx.root, "gone.txt"));
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.drained.inserted.length, 1);
    const fc = post.drained.inserted[0]!;
    assert.equal(fc.op, "delete");
    assert.ok(fc.before_blob_ref);
    assert.equal(fc.after_blob_ref, undefined);
    assert.equal(fc.lines_removed, 2);
  } finally {
    ctx.cleanup();
  }
});

test("capture: oversize files degrade to partial stubs", async () => {
  const ctx = await setup();
  try {
    await capturePre(ctx.store, ctx.payload, { ...ctx.opts, maxFileBytes: 8 });
    writeFileSync(join(ctx.root, "big.bin"), "0123456789ABCDEF");
    const post = await capturePost(ctx.store, ctx.payload, {
      ...ctx.opts,
      maxFileBytes: 8,
    });
    assert.equal(post.drained.inserted.length, 1);
    const fc = post.drained.inserted[0]!;
    assert.equal(fc.partial_diff, true);
    assert.equal(fc.before_blob_ref, undefined);
    assert.equal(fc.after_blob_ref, undefined);
    assert.equal(fc.size_after, 16);
  } finally {
    ctx.cleanup();
  }
});

test("capture: ignored paths are invisible to the scan", async () => {
  const ctx = await setup();
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    mkdirSync(join(ctx.root, "node_modules/dep"), { recursive: true });
    writeFileSync(join(ctx.root, "node_modules/dep/i.js"), "x");
    writeFileSync(join(ctx.root, ".env"), "SECRET=1");
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 0);
  } finally {
    ctx.cleanup();
  }
});

// ─── Tier 1: cross-path interaction + real-ingest drain ──────────────

test("cross-path: sentinel row first → hook drain dedups (one row)", async () => {
  const ctx = await setup({ files: { "src/x.ts": "a\n" } });
  try {
    const sentinel = new FileSentinel(ctx.store, { root: ctx.root });
    await sentinel.prime();
    await capturePre(ctx.store, ctx.payload, ctx.opts);

    writeFileSync(join(ctx.root, "src/x.ts"), "b\n");

    // Sentinel wins the race (its debounce fired first).
    sentinel.enqueue("src/x.ts");
    await sentinel.flushNow();
    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 1);

    // Hook post observes the same change; drain must recognize the
    // sentinel's row (same op + content-addressed refs) and not double.
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 1);
    assert.equal(post.drained.inserted.length, 0);

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.derived_from, "filesystem_watch");
    sentinel.stop();
  } finally {
    ctx.cleanup();
  }
});

test("cross-path: hook drain first → sentinel dedups (one row)", async () => {
  const ctx = await setup({ files: { "src/x.ts": "a\n" } });
  try {
    const sentinel = new FileSentinel(ctx.store, { root: ctx.root });
    await sentinel.prime();
    await capturePre(ctx.store, ctx.payload, ctx.opts);

    writeFileSync(join(ctx.root, "src/x.ts"), "b\n");

    // Hook wins the race this time.
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.drained.inserted.length, 1);

    sentinel.enqueue("src/x.ts");
    await sentinel.flushNow();

    const rows = listFileChanges(ctx.store, { runId: ctx.runId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tool_call_id, ctx.toolUseId); // the exact row won
  } finally {
    ctx.cleanup();
  }
});

test("drain: real ingestSession bridges the transcript (no injected ingest)", async () => {
  const home = mkdtempSync(join(tmpdir(), "meter-hc-real-"));
  process.env.METERBILITY_HOME = home;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "meter-hc-real-root-")));
  writeFileSync(join(root, "out.txt"), "one\n");
  const store = Store.open({ path: join(home, "meterbility.db") });
  const sessionId = `sess-real-${randomUUID()}`;
  const now = Date.now();

  // A minimal-but-real Claude Code session JSONL: user asks, assistant
  // fires the Bash tool_use, tool_result comes back. This is what the
  // hook's transcript_path points at in production.
  const transcript = join(home, "session.jsonl");
  const records = [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      timestamp: new Date(now - 3000).toISOString(),
      cwd: root,
      gitBranch: "main",
      message: { role: "user", content: "append please" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      timestamp: new Date(now - 2000).toISOString(),
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: "tu-real-1",
            name: "Bash",
            input: { command: "echo two >> out.txt" },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId,
      timestamp: new Date(now - 1000).toISOString(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-real-1", content: "" }],
      },
    },
  ];
  writeFileSync(
    transcript,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const opts: CaptureOptions = { stateDir: join(home, "capture-state") }; // default (real) ingest
  const payload: HookPayload = {
    session_id: sessionId,
    transcript_path: transcript,
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "echo two >> out.txt" },
  };

  try {
    await capturePre(store, payload, opts);
    writeFileSync(join(root, "out.txt"), "one\ntwo\n");
    const post = await capturePost(store, payload, opts);

    // Drain ran the real Claude Code adapter over the transcript, found
    // the Bash step by tool_input, and attached the row exactly.
    assert.equal(post.observed, 1);
    assert.equal(post.drained.inserted.length, 1);
    assert.equal(post.drained.pending, 0);
    const fc = post.drained.inserted[0]!;
    assert.equal(fc.tool_call_id, "tu-real-1");
    assert.equal(fc.op, "modify");
    assert.match(fc.patch_text ?? "", /\+two/);

    // The real adapter ALSO emitted its partial `(shell)` stub for the
    // Bash step — the capture row supplements it, exactly as designed.
    const stepRows = listFileChanges(store, { stepId: fc.step_id });
    assert.equal(stepRows.length, 2);
    const stub = stepRows.find((r) => r.derived_from === "tool_call")!;
    assert.equal(stub.path, "(shell)");
    assert.equal(stub.partial_diff, true);
    const exact = stepRows.find((r) => r.derived_from === "filesystem_watch")!;
    assert.equal(exact.file_change_id, fc.file_change_id);
    // And the sequence chain is intact (stub at 0, capture row after).
    assert.equal(exact.sequence, stub.sequence + 1);
  } finally {
    try {
      store.close();
    } catch {
      /* closed */
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture: parallel sibling call attributes via temporal tier (collapsed step)", async () => {
  // Claude Code emits parallel tool calls in ONE assistant message;
  // the step builder collapses them into a single step carrying only
  // the FIRST call's tool_input. The sibling's observation matches no
  // step input and previously expired unattributed (found live in
  // checklist §1.7). The temporal tier must land it on that step,
  // with the match quality recorded.
  const ctx = await setup({
    files: { "a.txt": "x\n" },
    command: "echo first > parallel-a.txt", // the step's recorded input
  });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    writeFileSync(join(ctx.root, "parallel-b.txt"), "second\n");
    // The post payload carries the SIBLING's command — no step has it.
    const post = await capturePost(
      ctx.store,
      {
        ...ctx.payload,
        tool_input: { command: "echo second > parallel-b.txt" },
      },
      ctx.opts,
    );
    assert.equal(post.observed, 1);
    assert.equal(post.drained.inserted.length, 1, "temporal tier attributed");
    const fc = post.drained.inserted[0]!;
    assert.equal(fc.step_id, ctx.stepId);
    assert.equal(fc.path, "parallel-b.txt");
    const notes = fc.normalizer_notes as Record<string, unknown>;
    assert.equal(notes.match, "temporal");
  } finally {
    ctx.cleanup();
  }
});

test("capture: exact match still wins over temporal when both exist", async () => {
  const ctx = await setup({ files: { "a.txt": "x\n" } }); // step input: make build
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    const notes = post.drained.inserted[0]!.normalizer_notes as Record<
      string,
      unknown
    >;
    assert.equal(notes.match, "exact");
  } finally {
    ctx.cleanup();
  }
});

test("capture: post with no manifest primes and honestly observes nothing", async () => {
  // Post-only hook install (or first-ever run): there's no baseline to
  // diff against, so the changes this step made are indistinguishable
  // from priors — prime, capture nothing, never guess.
  const ctx = await setup({ files: { "a.txt": "x\n" } });
  try {
    const post = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post.observed, 0);
    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
    // The prime is real: the NEXT post sees deltas.
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    const post2 = await capturePost(ctx.store, ctx.payload, ctx.opts);
    assert.equal(post2.observed, 1);
  } finally {
    ctx.cleanup();
  }
});

test("capture: payload without session_id observes but never stashes", async () => {
  // A manual/misconfigured invocation with no session identity can't
  // ever be attributed — the manifest still advances (so later capture
  // stays correct) but no stash record is created.
  const ctx = await setup({ files: { "a.txt": "x\n" } });
  try {
    await capturePre(ctx.store, ctx.payload, ctx.opts);
    writeFileSync(join(ctx.root, "a.txt"), "y\n");
    const post = await capturePost(
      ctx.store,
      { ...ctx.payload, session_id: undefined },
      ctx.opts,
    );
    assert.equal(post.observed, 1, "delta observed");
    assert.equal(post.drained.pending, 0, "but nothing stashed");
    assert.equal(listFileChanges(ctx.store, { runId: ctx.runId }).length, 0);
  } finally {
    ctx.cleanup();
  }
});
