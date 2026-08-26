import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, insertFileChange } from "@meterbility/collector";
import { buildApp } from "./web.ts";
import { ensureRun, appendStep } from "../../proxy/src/store-bridge.ts";

/**
 * Web-surface twin of the CLI proof test in
 * packages/cli/src/commands/live.test.ts: an out-of-band proxy run
 * (direct store writes via the proxy's own store-bridge — no
 * transcript, no x-meterbility-cwd header) must reach the BROWSER live
 * view: SSE `run:created` with provider identity through arrival
 * detection, SSE `files:changed` when capture rows land out-of-band
 * (hook-drain style), and the provider badge on the run page HTML.
 *
 * In-process via `app.fetch` (probe-web.test.ts pattern): real Hono
 * routes, real LiveController/LiveInspector, no ports, no subprocess.
 */

test("web live: an out-of-band proxy run reaches the SSE stream with provider identity and the run page renders the badge", async () => {
  // Isolate every scan root the inspector touches: projectsRoot is
  // passed via live options; the Codex root comes from env.
  const home = mkdtempSync(join(tmpdir(), "meter-web-live-"));
  const emptyProjects = mkdtempSync(join(tmpdir(), "meter-web-live-projects-"));
  const emptyCodex = mkdtempSync(join(tmpdir(), "meter-web-live-codex-"));
  const emptyCopilot = mkdtempSync(join(tmpdir(), "meter-web-live-copilot-"));
  const emptyClaude = mkdtempSync(join(tmpdir(), "meter-web-live-claude-"));
  const prevHome = process.env.METERBILITY_HOME;
  const prevCodex = process.env.CODEX_HOME;
  const prevCopilot = process.env.COPILOT_HOME;
  const prevClaude = process.env.CLAUDE_HOME;
  process.env.METERBILITY_HOME = home;
  process.env.CODEX_HOME = emptyCodex;
  // Copilot live-poll isolation (v8 adapter): without this, real
  // ~/.copilot sessions on the dev machine get ingested every tick
  // and starve the assertions (machine-state-dependent failure).
  process.env.COPILOT_HOME = emptyCopilot;
  // NOTE: LiveOptions.projectsRoot is currently ignored by the tick's
  // bare discoverSessions() call (latent dead option, flagged in
  // TODOS) — CLAUDE_HOME env is the isolation that actually works.
  process.env.CLAUDE_HOME = emptyClaude;

  const store = Store.open({ path: join(home, "meterbility.db") });
  const app = buildApp(store);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Flip live mode exactly as the UI's Live button does.
    const started = await app.fetch(
      new Request("http://local/api/live/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectsRoot: emptyProjects, scanIntervalMs: 100 }),
      }),
    );
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { live: true });

    // Open the SSE stream the browser's EventSource would open.
    const sse = await app.fetch(new Request("http://local/api/live"));
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    reader = sse.body!.getReader();
    const r = reader;
    const decoder = new TextDecoder();
    let feed = "";
    // Fire-and-forget pump; teardown is reader.cancel() in finally (an
    // AbortController on app.fetch does NOT propagate to this stream —
    // awaiting the pump on that signal hangs the runner).
    void (async () => {
      for (;;) {
        const { done, value } = await r.read().catch(() => ({ done: true as const, value: undefined }));
        if (done) return;
        feed += decoder.decode(value, { stream: true });
      }
    })();
    const waitForFrame = async (pattern: RegExp, timeoutMs = 20_000): Promise<void> => {
      const t0 = Date.now();
      for (;;) {
        if (pattern.test(feed)) return;
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`timeout waiting for ${pattern}\nfeed:\n${feed.slice(-4000)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    // Connect frame: one fleet:snapshot arrives immediately.
    await waitForFrame(/event: fleet:snapshot/);

    // The silent boot tick seeds arrival cursors WITHOUT emitting; a
    // post-boot snapshot proves subsequent writes must produce events.
    // Snapshots arrive every tick (100ms here), so waiting for a run
    // written AFTER the first snapshot is race-free in practice with
    // the generous frame timeout below.

    // Exactly what `meter proxy` does per captured request, from the
    // test process (a different writer than the inspector).
    const runId = `run_${randomUUID()}`;
    ensureRun(store, { project: emptyProjects, agent: "proxy" }, runId, {
      cwd: emptyProjects,
      provider: "nvidia",
      upstream_host: "integrate.api.nvidia.com",
    });
    const step = await appendStep(store, {
      run_id: runId,
      sequence: 0,
      provider: "nvidia",
      model: "meta/llama-3.1-405b",
      history: [{ role: "user", content: "make a file" }],
      decisionJson: "{}",
      action: {
        kind: "tool_call",
        tool_name: "Bash",
        tool_input: { command: "touch side-effect.txt" },
      },
      tokens: { input: 10, output: 5, cached_read: 0, cache_creation: 0 },
      latency_ms: 120,
      outcome: { status: "ok" },
    });

    // Arrival detection → SSE run:created carrying provider identity.
    await waitForFrame(new RegExp(`event: run:created\\ndata: [^\\n]*${runId}`));
    assert.match(
      feed,
      new RegExp(`event: run:created\\ndata: [^\\n]*"provider":"nvidia"[^\\n]*`),
      "provider identity travels in the SSE payload",
    );
    assert.match(feed, /"upstream_host":"integrate\.api\.nvidia\.com"/);

    // A capture row landing out-of-band (hook-drain style) → SSE
    // files:changed, which is what drives the run page's live
    // refreshStepCard swap.
    insertFileChange(store, {
      run_id: runId,
      step_id: step.step_id,
      sequence: 1000,
      derived_from: "filesystem_watch",
      path: "side-effect.txt",
      op: "create",
      partial_diff: true,
      gitignored: false,
      bom: false,
      lines_added: 0,
      lines_removed: 0,
      redacted: false,
    });
    await waitForFrame(new RegExp(`event: files:changed\\ndata: [^\\n]*${runId}`));

    // And the run page itself renders the v0.6 provider badge.
    const page = await app.fetch(new Request(`http://local/runs/${runId}`));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /provider-badge/);
    assert.match(html, /nvidia/);
    assert.match(html, /integrate\.api\.nvidia\.com/);
  } finally {
    await reader?.cancel().catch(() => {});
    await app.fetch(new Request("http://local/api/live/stop", { method: "POST" })).catch(() => {});
    store.close();
    process.env.METERBILITY_HOME = prevHome;
    process.env.CODEX_HOME = prevCodex;
    if (prevCopilot === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevCopilot;
    process.env.CLAUDE_HOME = prevClaude;
  }
});
