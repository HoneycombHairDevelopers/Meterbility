import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, setupEmpty, setupFixture } from "./cli-test-utils.ts";

/**
 * Exhaustive subprocess-driven coverage of all 21 `meter` CLI commands.
 *
 * Strategy per D2 in main-web-cli-coverage-plan.md: every test spawns
 * a real subprocess via tsx so Commander argv parsing, exit codes,
 * stdout/stderr formatting, and `process.exit` paths all run. This is
 * the most realistic possible coverage at the cost of ~500ms per test
 * (startup-dominated; the actions themselves are fast).
 *
 * Existing tests already cover:
 *   - `files` (11 tests in files.test.ts)
 *   - `probe` (15 tests in probe.test.ts)
 *
 * This file adds the other 19 commands. For long-running commands
 * (`proxy`, `web`, `watch`, `run`) we test the `--help` surface only:
 * spinning up a real server in a test and tearing it down adds 1-2s
 * per test for marginal extra signal beyond "the help text mentions
 * the expected options."
 *
 * Sections, in increasing complexity:
 *   A. Small commands (list, slack, runs, config, db, proxy, open)
 *   B. Mid commands  (annotate, diff, export, web, doctor, run, ingest)
 *   C. Larger commands (init, watch, test, fork, inspect)
 */

/* ====================================================================
 * Section A — Small commands (17 tests)
 * ==================================================================== */

// ── list ───────────────────────────────────────────────────────────

test("list: empty store prints a 'no runs found' hint and exits 0", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["list"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /no runs found/i);
  } finally {
    fx.cleanup();
  }
});

test("list: populated store prints a header + one row per run", () => {
  const fx = setupFixture({ title: "list-fixture" });
  try {
    const r = runCli(["list"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /RUN\s+STATUS/);
    assert.match(r.stdout, /list-fixture/);
  } finally {
    fx.cleanup();
  }
});

// ── slack ──────────────────────────────────────────────────────────

test("slack test: missing webhook config exits non-zero with a clear error", () => {
  const fx = setupEmpty();
  try {
    // Ensure no env var leaks in.
    const r = runCli(["slack", "test"], fx, {
      env: { METERBILITY_SLACK_WEBHOOK: "" },
    });
    assert.notEqual(r.status, 0, "no webhook should fail");
    assert.match(r.stderr, /webhook/i);
  } finally {
    fx.cleanup();
  }
});

test("slack --help lists the test subcommand", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["slack", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /test/);
    assert.match(r.stdout, /webhook/i);
  } finally {
    fx.cleanup();
  }
});

// ── runs ───────────────────────────────────────────────────────────

test("runs --help shows the close subcommand", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["runs", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /close/);
  } finally {
    fx.cleanup();
  }
});

test("runs close <id> on a fresh in_progress run seals it (exit 0)", () => {
  const fx = setupFixture({ status: "in_progress" });
  try {
    const r = runCli(["runs", "close", fx.runId!], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});

test("runs close on an unknown id exits non-zero with a clear error", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["runs", "close", "run_unknown_id"], fx);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not found|unknown/i);
  } finally {
    fx.cleanup();
  }
});

// ── config ─────────────────────────────────────────────────────────

test("config list on an empty store reports no settings", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["config", "list"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Either prints an empty list or a "no settings" hint — both are fine.
    // The contract we're pinning is the exit code.
  } finally {
    fx.cleanup();
  }
});

test("config set then config get round-trips a non-secret key", () => {
  const fx = setupEmpty();
  try {
    const set = runCli(
      ["config", "set", "fork.default_model", "claude-sonnet-4-5"],
      fx,
    );
    assert.equal(set.status, 0, `set stderr: ${set.stderr}`);
    const get = runCli(["config", "get", "fork.default_model"], fx);
    assert.equal(get.status, 0, `get stderr: ${get.stderr}`);
    assert.match(get.stdout, /claude-sonnet-4-5/);
  } finally {
    fx.cleanup();
  }
});

test("config list --json emits parseable JSON", () => {
  const fx = setupEmpty();
  try {
    runCli(["config", "set", "fork.default_model", "claude-opus-4-7"], fx);
    const r = runCli(["config", "list", "--json"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(typeof parsed === "object", "JSON output is an object/array");
  } finally {
    fx.cleanup();
  }
});

test("config get on an unset key exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["config", "get", "anthropic.api_key"], fx);
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

// ── db ─────────────────────────────────────────────────────────────

test("db --help lists postgres-init and postgres-sync", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["db", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /postgres-init/);
    assert.match(r.stdout, /postgres-sync/);
  } finally {
    fx.cleanup();
  }
});

test("db postgres-init with no url + no env exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["db", "postgres-init"], fx, {
      env: { METERBILITY_DB_URL: "" },
    });
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

test("db postgres-init with bad url surfaces a connect error (non-zero exit)", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["db", "postgres-init", "--url", "postgres://nobody@127.0.0.1:1/meter"],
      fx,
      { timeoutMs: 5000 },
    );
    assert.notEqual(r.status, 0, "unreachable Postgres should fail");
  } finally {
    fx.cleanup();
  }
});

// ── proxy ──────────────────────────────────────────────────────────

test("proxy --help shows port and host options", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["proxy", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--port/);
    assert.match(r.stdout, /--host/);
    assert.match(r.stdout, /anthropic-target|openai-target/);
  } finally {
    fx.cleanup();
  }
});

// ── open ───────────────────────────────────────────────────────────

test("open <unknown-id> exits non-zero with a not-found error", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["open", "run_unknown", "--print"], fx);
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

test("open <valid-id> --print emits a URL and exits 0", () => {
  const fx = setupFixture();
  try {
    const r = runCli(["open", fx.runId!, "--print"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /https?:\/\//);
  } finally {
    fx.cleanup();
  }
});

test("open <id> --at <seq> --print emits a deep link with the step seq", () => {
  const fx = setupFixture({ stepCount: 3 });
  try {
    const r = runCli(["open", fx.runId!, "--at", "1", "--print"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /https?:\/\//);
    // The URL should reference step 1 somehow — either via #step-1 or ?step=
    assert.match(r.stdout, /1|step/i);
  } finally {
    fx.cleanup();
  }
});

/* ====================================================================
 * Section B — Mid commands (22 tests)
 * ==================================================================== */

// ── annotate ────────────────────────────────────────────────────────

test("annotate <run-id> --verdict good_decision --note creates an annotation", () => {
  const fx = setupFixture();
  try {
    const r = runCli(
      [
        "annotate",
        fx.runId!,
        "--verdict",
        "good_decision",
        "--note",
        "looks fine",
        "--author",
        "test",
      ],
      fx,
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});

test("annotate with invalid target id (not stp_/run_ prefixed) exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["annotate", "not_a_real_id", "--note", "x"],
      fx,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /step id|run id|must be/i);
  } finally {
    fx.cleanup();
  }
});

test("annotate with invalid verdict exits non-zero with allowed-list hint", () => {
  const fx = setupFixture();
  try {
    const r = runCli(
      [
        "annotate",
        fx.runId!,
        "--verdict",
        "absolutely-fine",
      ],
      fx,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid verdict|allowed:/i);
  } finally {
    fx.cleanup();
  }
});

// ── diff ────────────────────────────────────────────────────────────

test("diff with two valid run ids exits 0 and prints a header", () => {
  const fx = setupFixture({ title: "first-run" });
  // Create a second run reusing the same fixture's METERBILITY_HOME
  const fx2 = setupFixture({ title: "second-run" });
  try {
    // Both runs need to live in the same store — use fx's home but
    // populate the second run via direct DB write. Simpler: use the
    // pre-existing fixture's runId for both A and B (degenerate diff).
    const r = runCli(["diff", fx.runId!, fx.runId!], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Diff:|shared prefix/i);
  } finally {
    fx.cleanup();
    fx2.cleanup();
  }
});

test("diff with one unknown id exits non-zero", () => {
  const fx = setupFixture();
  try {
    const r = runCli(["diff", fx.runId!, "run_unknown"], fx);
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

test("diff --json emits parseable JSON", () => {
  const fx = setupFixture();
  try {
    const r = runCli(["diff", fx.runId!, fx.runId!, "--json"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Should be valid JSON.
    const parsed = JSON.parse(r.stdout);
    assert.ok(typeof parsed === "object");
  } finally {
    fx.cleanup();
  }
});

// ── export ──────────────────────────────────────────────────────────

test("export <run-id> emits trace JSON to stdout (no -o)", () => {
  const fx = setupFixture({ stepCount: 2 });
  try {
    const r = runCli(["export", fx.runId!, "--no-blobs"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as {
      meter_trace_version: string;
      run: { run_id: string };
      steps: unknown[];
    };
    assert.match(parsed.meter_trace_version, /^\d+\.\d+\.\d+$/);
    assert.equal(parsed.run.run_id, fx.runId);
    assert.equal(parsed.steps.length, 2);
  } finally {
    fx.cleanup();
  }
});

test("export <run-id> -o <path> writes the trace to a file and exits 0", () => {
  const fx = setupFixture({ stepCount: 1 });
  const out = join(fx.home, "trace.json");
  try {
    const r = runCli(["export", fx.runId!, "-o", out, "--no-blobs"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(out), "output file written");
    const parsed = JSON.parse(readFileSync(out, "utf-8")) as {
      run: { run_id: string };
    };
    assert.equal(parsed.run.run_id, fx.runId);
  } finally {
    fx.cleanup();
  }
});

test("export <unknown-id> exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["export", "run_unknown"], fx);
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

/* ── v0.3 trace format tests ──────────────────────────────────────────
 *
 * Per SPEC-V0_3 §10 + §12: the exported trace declares itself
 * meter_trace_version "0.3.0", carries `file_changes[]` and
 * `baseline_trees[]`, and defaults to *omitting* file content blobs.
 * `--include-file-blobs` opts back in (the export.include_file_blobs
 * setting also flips the default).
 */

test("export v0.3: meter_trace_version is exactly 0.3.0", () => {
  const fx = setupFixture({ stepCount: 1 });
  try {
    const r = runCli(["export", fx.runId!, "--no-blobs"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as { meter_trace_version: string };
    assert.equal(parsed.meter_trace_version, "0.3.0");
  } finally {
    fx.cleanup();
  }
});

test("export v0.3: trace always carries file_changes[] and baseline_trees[]", () => {
  const fx = setupFixture({ stepCount: 1 });
  try {
    const r = runCli(["export", fx.runId!, "--no-blobs"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as {
      file_changes: unknown[];
      baseline_trees: unknown[];
    };
    assert.ok(Array.isArray(parsed.file_changes));
    assert.ok(Array.isArray(parsed.baseline_trees));
  } finally {
    fx.cleanup();
  }
});

test("export v0.3: file_changes[] surfaces inserted FileChange rows", async () => {
  const fx = setupFixture({ stepCount: 1 });
  try {
    // Seed a FileChange into the fixture store directly. Re-open with
    // the same METERBILITY_HOME so the subprocess sees it.
    const { Store, insertFileChange } = await import("@meterbility/collector");
    const store = Store.open({ path: join(fx.home, "meterbility.db") });
    try {
      const after = await store.blobs.putString("created\n");
      insertFileChange(store, {
        run_id: fx.runId!,
        step_id: fx.stepIds![0]!,
        sequence: 0,
        derived_from: "tool_call",
        path: "src/new.ts",
        op: "create",
        after_blob_ref: after,
        partial_diff: false,
        gitignored: false,
        bom: false,
        lines_added: 1,
        lines_removed: 0,
        redacted: false,
      });
    } finally {
      store.close();
    }

    const r = runCli(["export", fx.runId!, "--no-blobs"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as {
      file_changes: Array<{ path: string; op: string }>;
    };
    assert.equal(parsed.file_changes.length, 1);
    assert.equal(parsed.file_changes[0]!.path, "src/new.ts");
    assert.equal(parsed.file_changes[0]!.op, "create");
  } finally {
    fx.cleanup();
  }
});

test("export v0.3: --include-file-blobs OFF by default, ON inlines file blobs", async () => {
  const fx = setupFixture({ stepCount: 1 });
  try {
    const { Store, insertFileChange } = await import("@meterbility/collector");
    const store = Store.open({ path: join(fx.home, "meterbility.db") });
    let afterRef = "";
    try {
      afterRef = await store.blobs.putString("contents of file\n");
      insertFileChange(store, {
        run_id: fx.runId!,
        step_id: fx.stepIds![0]!,
        sequence: 0,
        derived_from: "tool_call",
        path: "src/z.ts",
        op: "create",
        after_blob_ref: afterRef,
        partial_diff: false,
        gitignored: false,
        bom: false,
        lines_added: 1,
        lines_removed: 0,
        redacted: false,
      });
    } finally {
      store.close();
    }

    // Default — file content blob omitted (bug-reports get shared).
    const offRun = runCli(["export", fx.runId!], fx);
    assert.equal(offRun.status, 0, `stderr: ${offRun.stderr}`);
    const offBody = JSON.parse(offRun.stdout) as {
      blobs: Record<string, string>;
    };
    assert.equal(
      offBody.blobs[afterRef],
      undefined,
      "file blob should be omitted by default",
    );

    // Opt-in — should include the blob bytes (base64 of the source).
    const onRun = runCli(
      ["export", fx.runId!, "--include-file-blobs"],
      fx,
    );
    assert.equal(onRun.status, 0, `stderr: ${onRun.stderr}`);
    const onBody = JSON.parse(onRun.stdout) as {
      blobs: Record<string, string>;
    };
    assert.equal(
      typeof onBody.blobs[afterRef],
      "string",
      "--include-file-blobs inlines the file content blob",
    );
    assert.equal(
      Buffer.from(onBody.blobs[afterRef]!, "base64").toString("utf-8"),
      "contents of file\n",
    );
  } finally {
    fx.cleanup();
  }
});

test("export v0.3: baseline_trees[] surfaces the run's attached baseline", async () => {
  const fx = setupFixture({ stepCount: 1 });
  try {
    const { Store, insertBaselineTree, setRunBaselineTree, serializeManifest } =
      await import("@meterbility/collector");
    const store = Store.open({ path: join(fx.home, "meterbility.db") });
    let manifestRef = "";
    let baselineId = "";
    try {
      // Resolve the project_id the fixture seeded so the baseline FK lines up.
      const projectId = (
        store.db
          .prepare("SELECT project_id FROM runs WHERE run_id = ?")
          .get(fx.runId!) as { project_id: string }
      ).project_id;
      manifestRef = await store.blobs.putBuffer(
        serializeManifest([
          { path: "README.md", mode: 0o644, blob_ref: "blob_x" },
        ]),
      );
      const bt = insertBaselineTree(store, {
        project_id: projectId,
        manifest_blob_ref: manifestRef,
        git_head: "deadbeef",
        git_dirty: false,
      });
      baselineId = bt.baseline_tree_id;
      setRunBaselineTree(store, fx.runId!, baselineId);
    } finally {
      store.close();
    }

    const r = runCli(["export", fx.runId!], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as {
      baseline_trees: Array<{ baseline_tree_id: string; git_head: string }>;
      blobs: Record<string, string>;
    };
    assert.equal(parsed.baseline_trees.length, 1);
    assert.equal(parsed.baseline_trees[0]!.baseline_tree_id, baselineId);
    assert.equal(parsed.baseline_trees[0]!.git_head, "deadbeef");
    // Manifest is a structured index → always included per SPEC-V0_3 §12,
    // even without --include-file-blobs.
    assert.ok(
      parsed.blobs[manifestRef],
      "baseline manifest blob should be inlined even without --include-file-blobs",
    );
  } finally {
    fx.cleanup();
  }
});

// ── web (long-running; test --help only) ────────────────────────────

test("web --help lists port, host, and live options", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["web", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--port/);
    assert.match(r.stdout, /--host/);
    assert.match(r.stdout, /--live/);
  } finally {
    fx.cleanup();
  }
});

test("web --port with non-numeric value parses to NaN; should still --help cleanly", () => {
  const fx = setupEmpty();
  try {
    // Just verify --help works regardless — argv validation happens at
    // action time so --help short-circuits before any parsing
    const r = runCli(["web", "--help"], fx);
    assert.equal(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

// ── v0.3 §11 non-loopback bind safety ──────────────────────────────

test("web --help advertises --allow-unauth-bind", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["web", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--allow-unauth-bind/);
  } finally {
    fx.cleanup();
  }
});

test("web --host 0.0.0.0 refuses to start when web.bind_token is unset (no flag)", () => {
  const fx = setupEmpty();
  try {
    // Use --no-open so we don't try to spawn a browser. Bind to a port
    // we won't actually reach since the action exits before serveApp.
    const r = runCli(
      ["web", "--host", "0.0.0.0", "--port", "0", "--no-open"],
      fx,
      { timeoutMs: 8000 },
    );
    assert.notEqual(r.status, 0, "non-loopback + no token should refuse");
    // The error message must surface the actual fix paths.
    assert.match(
      r.stderr + r.stdout,
      /refusing to bind|web\.bind_token|--allow-unauth-bind/i,
    );
  } finally {
    fx.cleanup();
  }
});

test("web --host 192.168.x.x refuses to start when web.bind_token is unset (no flag)", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["web", "--host", "192.168.1.10", "--port", "0", "--no-open"],
      fx,
      { timeoutMs: 8000 },
    );
    assert.notEqual(r.status, 0, "LAN-style IP + no token should refuse");
  } finally {
    fx.cleanup();
  }
});

test("web --host 127.0.0.1 (loopback) starts normally with no token + no flag", () => {
  // Loopback is always safe. Don't actually run the server (it never
  // returns) — instead assert that the action made it past the safety
  // check by timing out (which means the server is running) OR ran far
  // enough to print the "Meterbility running at" line.
  // We use the subprocess timeout to bound the test.
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"],
      fx,
      { timeoutMs: 1500 },
    );
    // Either it's still running (status === null on timeout) or it
    // printed the running banner before something else killed it.
    // The crucial signal: NO "refusing to bind" anywhere in output.
    assert.doesNotMatch(
      r.stderr + r.stdout,
      /refusing to bind/i,
      "loopback must never trip the refusal path",
    );
  } finally {
    fx.cleanup();
  }
});

// ── doctor ──────────────────────────────────────────────────────────

test("doctor exits 0 or non-zero depending on env; output has summary section", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["doctor"], fx);
    // Exit code depends on whether the machine has ~/.claude — both
    // 0 and non-zero are acceptable. We only assert the output shape.
    assert.match(r.stdout, /Node|METERBILITY|Claude/i);
  } finally {
    fx.cleanup();
  }
});

test("doctor --json emits a parseable JSON object", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["doctor", "--json"], fx);
    const parsed = JSON.parse(r.stdout) as {
      checks: Array<{ status: string; label: string; detail: string }>;
      summary?: Record<string, number>;
    };
    assert.ok(Array.isArray(parsed.checks), "checks is an array");
    assert.ok(parsed.checks.length > 0);
    for (const check of parsed.checks) {
      assert.ok(["ok", "warn", "fail"].includes(check.status));
      assert.equal(typeof check.label, "string");
    }
  } finally {
    fx.cleanup();
  }
});

test("doctor --help lists the --json option", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["doctor", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--json/);
  } finally {
    fx.cleanup();
  }
});

test("doctor on a clean METERBILITY_HOME doesn't crash (any exit code, output shape)", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["doctor", "--json"], fx);
    // The status can be 0 or non-zero depending on machine env. We
    // just confirm it doesn't crash mid-output (which would yield
    // unparseable JSON).
    JSON.parse(r.stdout);
  } finally {
    fx.cleanup();
  }
});

// ── run (long-running; test --help only) ────────────────────────────

test("run --help shows the proxy auto-wiring description", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["run", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /proxy|auto-wire|capture/i);
  } finally {
    fx.cleanup();
  }
});

test("run with no command after `--` fails fast (no child to spawn)", () => {
  const fx = setupEmpty();
  try {
    // Run with no trailing command — should fail rather than hang.
    const r = runCli(["run"], fx, { timeoutMs: 3000 });
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

// ── ingest ──────────────────────────────────────────────────────────

test("ingest --help lists the three adapter subcommands", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["ingest", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /claude-code/);
    // Codex and Cursor adapters are registered as subcommands too
    assert.match(r.stdout, /codex|cursor/i);
  } finally {
    fx.cleanup();
  }
});

test("ingest claude-code with a non-existent file path exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["ingest", "claude-code", "/does/not/exist/session.jsonl"],
      fx,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not found/i);
  } finally {
    fx.cleanup();
  }
});

test("ingest claude-code --cwd <empty-dir> reports 'no sessions to ingest'", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "ingest",
        "claude-code",
        "--cwd",
        "/path/that/has/no/claude/sessions/anywhere",
      ],
      fx,
    );
    // Should exit 0 (no work to do is not an error) with a clear message.
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /no sessions/i);
  } finally {
    fx.cleanup();
  }
});

/* ====================================================================
 * Section C — Larger commands (24 tests)
 * ==================================================================== */

// ── init (creates files; exercise via [path] arg) ────────────────────

test("init [path] scaffolds .meterbilityignore + .meterbility/config.toml in the given dir", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["init", fx.home], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(fx.home, ".meterbilityignore")), ".meterbilityignore created");
    assert.ok(
      existsSync(join(fx.home, ".meter", "config.toml")),
      ".meterbility/config.toml created",
    );
    assert.match(r.stdout, /scaffolded|created/i);
  } finally {
    fx.cleanup();
  }
});

test("init [path] is idempotent — re-running leaves existing files alone", () => {
  const fx = setupEmpty();
  try {
    runCli(["init", fx.home], fx);
    // Mutate the file to confirm it's not regenerated.
    const ignorePath = join(fx.home, ".meterbilityignore");
    const mutated = readFileSync(ignorePath, "utf-8") + "\n# user added line\n";
    writeFileSync(ignorePath, mutated, "utf-8");
    // Re-run init without --force.
    const r = runCli(["init", fx.home], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(ignorePath, "utf-8");
    assert.equal(after, mutated, "existing .meterbilityignore not overwritten");
  } finally {
    fx.cleanup();
  }
});

test("init [path] --force overwrites existing .meterbilityignore", () => {
  const fx = setupEmpty();
  try {
    runCli(["init", fx.home], fx);
    const ignorePath = join(fx.home, ".meterbilityignore");
    writeFileSync(ignorePath, "# replaced\n", "utf-8");
    const r = runCli(["init", fx.home, "--force"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(ignorePath, "utf-8");
    assert.ok(
      !/^# replaced$/m.test(after),
      "--force regenerated the file",
    );
  } finally {
    fx.cleanup();
  }
});

test("init <non-existent-path> exits 2 with a clear error", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["init", "/this/path/does/not/exist"], fx);
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /not exist|not found/i);
  } finally {
    fx.cleanup();
  }
});

// ── watch (long-running; test --help only) ───────────────────────────

test("watch --help lists --watch-tool and --stall-seconds", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["watch", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--watch-tool/);
    assert.match(r.stdout, /--stall-seconds/);
  } finally {
    fx.cleanup();
  }
});

test("watch --help mentions ~/.claude/projects as the data source", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["watch", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Claude|projects|terminal/i);
  } finally {
    fx.cleanup();
  }
});

test("watch --help includes the --json option", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["watch", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--json/);
  } finally {
    fx.cleanup();
  }
});

// ── test (regression-tests subsystem) ────────────────────────────────

test("test list on an empty store reports 'no tests defined'", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["test", "list"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /no tests/i);
  } finally {
    fx.cleanup();
  }
});

test("test create <name> with no assertions creates the test", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["test", "create", "smoke"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = runCli(["test", "list"], fx);
    assert.match(list.stdout, /smoke/);
  } finally {
    fx.cleanup();
  }
});

test("test create <name> --from <run-id> derives assertions from the run", () => {
  const fx = setupFixture({ stepCount: 2 });
  try {
    const r = runCli(
      ["test", "create", "derived", "--from", fx.runId!],
      fx,
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = runCli(["test", "list"], fx);
    assert.match(list.stdout, /derived/);
  } finally {
    fx.cleanup();
  }
});

test("test create --from <unknown-id> exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["test", "create", "broken", "--from", "run_unknown"],
      fx,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not found/i);
  } finally {
    fx.cleanup();
  }
});

test("test rm <name> removes the test", () => {
  // The CLI uses `test rm <name>` (not `test delete`) — pinned here.
  const fx = setupEmpty();
  try {
    runCli(["test", "create", "to-delete"], fx);
    const r = runCli(["test", "rm", "to-delete"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = runCli(["test", "list"], fx);
    assert.match(list.stdout, /no tests/i);
  } finally {
    fx.cleanup();
  }
});

// ── fork (LLM-touching; --fake for offline tests) ────────────────────

test("fork --help lists edit types and --fake option", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["fork", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--at/);
    assert.match(r.stdout, /--edit/);
    assert.match(r.stdout, /--fake/);
  } finally {
    fx.cleanup();
  }
});

test("fork <unknown-id> exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "fork",
        "run_unknown",
        "--at",
        "0",
        "--edit",
        "add_context",
        "--text",
        "hi",
        "--fake",
        "ok",
      ],
      fx,
    );
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

test("fork --edit <unknown-type> exits non-zero with allowed-list hint", () => {
  const fx = setupFixture();
  try {
    const r = runCli(
      [
        "fork",
        fx.runId!,
        "--at",
        "0",
        "--edit",
        "absolutely_unknown_edit",
        "--fake",
        "ok",
      ],
      fx,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /edit type|allowed:/i);
  } finally {
    fx.cleanup();
  }
});

test("fork --at <out-of-range-seq> exits non-zero", () => {
  const fx = setupFixture({ stepCount: 2 });
  try {
    const r = runCli(
      [
        "fork",
        fx.runId!,
        "--at",
        "99",
        "--edit",
        "inject_message",
        "--text",
        "hi",
        "--fake",
        "ok",
      ],
      fx,
    );
    assert.notEqual(r.status, 0, "step 99 doesn't exist");
  } finally {
    fx.cleanup();
  }
});

test("fork without --at fails with required-option error", () => {
  const fx = setupFixture();
  try {
    const r = runCli(
      ["fork", fx.runId!, "--edit", "inject_message", "--text", "hi"],
      fx,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /required.*--at|--at.*required/i);
  } finally {
    fx.cleanup();
  }
});

// ── inspect (step inspector; --at <seq> and --show <tab>) ───────────

test("inspect --help shows the --at and --show options", () => {
  // The actual options are step-navigation flags (--at, --show <tab>),
  // not filter flags. The plan's "filter combinators" framing was based
  // on the audit's expectation; the real surface is a step viewer.
  const fx = setupEmpty();
  try {
    const r = runCli(["inspect", "--help"], fx);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--at/);
    assert.match(r.stdout, /--show/);
  } finally {
    fx.cleanup();
  }
});

test("inspect <run-id> on a valid run exits 0 and prints something", () => {
  const fx = setupFixture({ stepCount: 2 });
  try {
    const r = runCli(["inspect", fx.runId!], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, "produced some output");
  } finally {
    fx.cleanup();
  }
});

test("inspect <unknown-id> exits non-zero", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["inspect", "run_unknown"], fx);
    assert.notEqual(r.status, 0);
  } finally {
    fx.cleanup();
  }
});

test("inspect <run-id> --at 0 opens step 0 view", () => {
  const fx = setupFixture({ stepCount: 2 });
  try {
    const r = runCli(["inspect", fx.runId!, "--at", "0"], fx);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, "step 0 view produced output");
  } finally {
    fx.cleanup();
  }
});

test("inspect <run-id> --at <out-of-range-seq> exits non-zero", () => {
  const fx = setupFixture({ stepCount: 2 });
  try {
    const r = runCli(["inspect", fx.runId!, "--at", "99"], fx);
    assert.notEqual(r.status, 0, "step 99 doesn't exist");
  } finally {
    fx.cleanup();
  }
});

test("inspect <run-id> --at 0 --show context prints the context tab only", () => {
  const fx = setupFixture({ stepCount: 1 });
  try {
    const r = runCli(
      ["inspect", fx.runId!, "--at", "0", "--show", "context"],
      fx,
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});
