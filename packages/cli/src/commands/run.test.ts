import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, setupEmpty } from "../cli-test-utils.ts";

/**
 * `meter run` env-wiring tests — subprocess-driven (real Commander
 * parsing, real proxy startup, real child spawn).
 *
 * CRITICAL REGRESSION COVERAGE: run.ts had zero tests before the
 * multi-upstream change modified its env wiring. The first test pins
 * the pre-existing bare-path behavior; the rest cover the new
 * `--upstream` precedence rules (design: docs/designs/
 * proxy-multi-upstream.md, decisions 4A/6A).
 *
 * The child is `node -p` printing its env as JSON — asserting on the
 * exact env the wrapped command receives, end-to-end.
 */

const PRINT_ENV =
  'JSON.stringify({a: process.env.ANTHROPIC_BASE_URL ?? null, o: process.env.OPENAI_BASE_URL ?? null})';

interface ChildEnv {
  a: string | null;
  o: string | null;
}

function lastJsonLine(stdout: string): ChildEnv {
  const line = stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .pop();
  assert.ok(line, `no JSON line in stdout: ${stdout}`);
  return JSON.parse(line!) as ChildEnv;
}

test("REGRESSION: bare wiring — both env vars point at the proxy (openai gets /v1)", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["run", "--quiet", "--", "node", "-p", PRINT_ENV], fx, {
      timeoutMs: 30_000,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const env = lastJsonLine(r.stdout);
    assert.match(env.a ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(env.o ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  } finally {
    fx.cleanup();
  }
});

test("named openai-dialect upstream wins OPENAI_BASE_URL with /name/v1 shape", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "run",
        "--quiet",
        "--upstream",
        "nvidia=https://integrate.api.nvidia.com",
        "--",
        "node",
        "-p",
        PRINT_ENV,
      ],
      fx,
      { timeoutMs: 30_000 },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const env = lastJsonLine(r.stdout);
    // OpenAI-dialect named upstream wins; SDK convention includes /v1.
    assert.match(env.o ?? "", /^http:\/\/127\.0\.0\.1:\d+\/nvidia\/v1$/);
    // Anthropic default is untouched by an openai-dialect upstream.
    assert.match(env.a ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    fx.cleanup();
  }
});

test("anthropic-dialect upstream exports ANTHROPIC_BASE_URL without /v1", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "run",
        "--quiet",
        "--upstream",
        "mygw:anthropic=https://claude-gw.internal",
        "--",
        "node",
        "-p",
        PRINT_ENV,
      ],
      fx,
      { timeoutMs: 30_000 },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const env = lastJsonLine(r.stdout);
    // Anthropic SDK appends /v1 itself — base stays bare.
    assert.match(env.a ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mygw$/);
    assert.match(env.o ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  } finally {
    fx.cleanup();
  }
});

test("--no-openai suppresses the bare default but never a named upstream", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "run",
        "--quiet",
        "--no-openai",
        "--upstream",
        "nvidia=https://integrate.api.nvidia.com",
        "--",
        "node",
        "-p",
        PRINT_ENV,
      ],
      fx,
      { timeoutMs: 30_000 },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const env = lastJsonLine(r.stdout);
    assert.match(
      env.o ?? "",
      /^http:\/\/127\.0\.0\.1:\d+\/nvidia\/v1$/,
      "--no-openai must not suppress the upstream the user explicitly asked for",
    );
  } finally {
    fx.cleanup();
  }
});

test("--no-openai without a named upstream leaves OPENAI_BASE_URL untouched (regression)", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(["run", "--quiet", "--no-openai", "--", "node", "-p", PRINT_ENV], fx, {
      timeoutMs: 30_000,
      env: { OPENAI_BASE_URL: "sentinel://outer" },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const env = lastJsonLine(r.stdout);
    assert.equal(env.o, "sentinel://outer", "outer env passes through unmodified");
    assert.match(env.a ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    fx.cleanup();
  }
});

test("two same-dialect upstreams fail fast with an explanatory error", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "run",
        "--upstream",
        "nvidia=https://integrate.api.nvidia.com",
        "--upstream",
        "groq=https://api.groq.com/openai",
        "--",
        "node",
        "-e",
        "process.exit(0)",
      ],
      fx,
      { timeoutMs: 15_000 },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /OPENAI_BASE_URL can only point at one/);
    assert.match(r.stderr, /meter proxy --upstream/);
  } finally {
    fx.cleanup();
  }
});

test("malformed --upstream is a hard parse error before anything starts", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["run", "--upstream", "Bad_Name=https://x.example", "--", "node", "-e", "0"],
      fx,
      { timeoutMs: 15_000 },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must match \[a-z0-9-\]\+/);
  } finally {
    fx.cleanup();
  }
});

test("two anthropic-dialect upstreams fail fast naming ANTHROPIC_BASE_URL", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      [
        "run",
        "--upstream",
        "claude-gw:anthropic=https://gw1.example",
        "--upstream",
        "claude-alt:anthropic=https://gw2.example",
        "--",
        "node",
        "-e",
        "process.exit(0)",
      ],
      fx,
      { timeoutMs: 15_000 },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ANTHROPIC_BASE_URL can only point at one/);
  } finally {
    fx.cleanup();
  }
});

test("credential-bearing --upstream url is rejected at parse time", () => {
  const fx = setupEmpty();
  try {
    const r = runCli(
      ["run", "--upstream", "gw=https://user:secret@host.example", "--", "node", "-e", "0"],
      fx,
      { timeoutMs: 15_000 },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must not embed credentials/);
  } finally {
    fx.cleanup();
  }
});
