import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, listFileChanges, listSteps } from "@meterbility/collector";
import { ingestCodexSession } from "./ingest.ts";
import { readCodexSession } from "./parser.ts";
import { probeCodexRecords } from "./shape_probe.ts";

/**
 * Real-capture corpus test (same shape as the Claude Code adapter's).
 *
 * The adapter's first file-change fixture was hand-built around an
 * envelope (`patch_apply_end`) that no real rollout contains, so the
 * tests and the code agreed with each other and not with Codex. This
 * test runs the adapter over REAL rollouts under `fixtures/corpus/`
 * (redacted with `scripts/redact-codex-rollout.ts`) and pins, per
 * capture, in `<capture>.expect.json`:
 *
 *   1. what the shape probe reports — the set of unknown record /
 *      response_item / event_msg / item kinds. A new kind fails the
 *      build instead of scrolling past in a log;
 *   2. what ingest derives — step count and one line per file_change
 *      row (step, path, op, partial, +/-, tool, before_source). A
 *      regression to zero rows or to partial rows fails here.
 *
 * Adding a capture: redact it into `fixtures/corpus/<name>.jsonl`, then
 *
 *   UPDATE_CORPUS=1 node --import tsx/esm --test adapters/codex-cli/src/corpus.test.ts
 *
 * and review the generated `.expect.json` before committing it. The
 * same env var re-pins an INTENTIONAL change (a newly handled kind, a
 * fidelity improvement).
 */

const CORPUS_DIR = fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));
const UPDATE = process.env.UPDATE_CORPUS === "1";

interface FileChangeLine {
  step: number;
  sequence: number;
  path: string;
  op: string;
  partial_diff: boolean;
  lines_added: number;
  lines_removed: number;
  tool: string | undefined;
  before_source: string | undefined;
}

interface Expectation {
  /** Probe drift keys (`<kind>:<type>`), sorted. */
  unknown_types: string[];
  steps: number;
  file_changes: FileChangeLine[];
}

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "meter-codex-corpus-"));
  process.env.METERBILITY_HOME = dir;
  return Store.open({ path: join(dir, "meterbility.db") });
}

async function observe(capturePath: string): Promise<Expectation> {
  const parsed = await readCodexSession(capturePath);
  const unknown_types = probeCodexRecords(parsed.map((p) => p.record))
    .map((w) => w.driftKey)
    .sort();

  const store = freshStore();
  try {
    const result = await ingestCodexSession(store, capturePath);
    const steps = listSteps(store, result.run_id);
    const seqByStepId = new Map(steps.map((s) => [s.step_id, s.sequence]));
    const rows = listFileChanges(store, { runId: result.run_id });
    const file_changes: FileChangeLine[] = rows
      .map((fc) => ({
        step: seqByStepId.get(fc.step_id) ?? -1,
        sequence: fc.sequence,
        path: fc.path,
        op: fc.op,
        partial_diff: fc.partial_diff,
        lines_added: fc.lines_added,
        lines_removed: fc.lines_removed,
        tool: fc.source_tool_name,
        before_source: (fc.normalizer_notes as { before_source?: string } | undefined)
          ?.before_source,
      }))
      .sort((a, b) => a.step - b.step || a.sequence - b.sequence);
    const observed: Expectation = { unknown_types, steps: steps.length, file_changes };
    // Round-trip through JSON so `undefined` fields compare equal to
    // keys absent from the pinned file.
    return JSON.parse(JSON.stringify(observed)) as Expectation;
  } finally {
    store.close();
  }
}

const captures = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".jsonl")).sort()
  : [];

test("corpus directory has at least one capture", () => {
  assert.ok(captures.length > 0, `no *.jsonl under ${CORPUS_DIR}`);
});

for (const file of captures) {
  const name = basename(file, ".jsonl");
  const capturePath = join(CORPUS_DIR, file);
  const expectPath = join(CORPUS_DIR, `${name}.expect.json`);

  test(`corpus: ${name} — probe findings and derived file changes match the pinned expectation`, async () => {
    const observed = await observe(capturePath);
    if (UPDATE) {
      writeFileSync(expectPath, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    assert.ok(
      existsSync(expectPath),
      `${expectPath} missing — run with UPDATE_CORPUS=1 and review the output`,
    );
    const expected = JSON.parse(readFileSync(expectPath, "utf-8")) as Expectation;
    assert.deepEqual(
      observed.unknown_types,
      expected.unknown_types,
      "unknown kinds changed — Codex added or we started handling a record/payload/item type; re-pin with UPDATE_CORPUS=1 once types.ts / shape_probe.ts cover it",
    );
    assert.equal(observed.steps, expected.steps, "step count changed");
    assert.deepEqual(
      observed.file_changes,
      expected.file_changes,
      "derived file_change rows changed — a fidelity regression unless intentional",
    );
  });
}
