import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, listFileChanges, listSteps } from "@meterbility/collector";
import { ingestSession } from "./ingest.ts";
import { readSession } from "./parser.ts";
import { probeRecords } from "./shape_probe.ts";

/**
 * Real-capture corpus test.
 *
 * Every drift this adapter has suffered (the file-history-snapshot
 * rewrite, then file-history-delta) went unnoticed because the fixtures
 * were written from the code's idea of Claude Code's format, so tests
 * and code agreed with each other and not with reality. This test runs
 * the adapter over REAL transcripts under `fixtures/corpus/` (redacted
 * with `scripts/redact-claude-code-transcript.ts`) and pins two things
 * per capture in `<capture>.expect.json`:
 *
 *   1. what the shape probe reports — the set of unknown record types
 *      and the set of known types with field drift. A new record type
 *      or a new key fails the build instead of scrolling past in a log;
 *   2. what ingest derives — step count and one line per file_change
 *      row (step, path, op, partial, +/-, tool, before_source). A
 *      regression to 0/0 partial rows fails here.
 *
 * Adding a capture: redact it into `fixtures/corpus/<name>.jsonl`, put
 * any `~/.claude/file-history/<session>/` backups it needs under
 * `fixtures/corpus/<name>.file-history/`, then run
 *
 *   UPDATE_CORPUS=1 node --import tsx/esm --test adapters/claude-code/src/corpus.test.ts
 *
 * and review the generated `.expect.json` before committing it. The
 * same env var is how an INTENTIONAL change (a new supported record
 * type, a fidelity improvement) gets re-pinned.
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
  /** `unknown-type:<type>` warnings, type names only, sorted. */
  unknown_record_types: string[];
  /** Known record types the probe flagged for missing/unexpected keys, sorted. */
  known_types_with_drift: string[];
  steps: number;
  file_changes: FileChangeLine[];
}

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "meter-cc-corpus-"));
  process.env.METERBILITY_HOME = dir;
  return Store.open({ path: join(dir, "meterbility.db") });
}

/** Backups for a capture live beside it: `<name>.file-history/<backupFileName>`. */
function corpusBackupReader(captureName: string) {
  const dir = join(CORPUS_DIR, `${captureName}.file-history`);
  return async (_sessionId: string, backupFileName: string) => {
    const p = join(dir, backupFileName);
    return existsSync(p) ? readFileSync(p) : undefined;
  };
}

async function observe(capturePath: string, captureName: string): Promise<Expectation> {
  const parsed = await readSession(capturePath);
  const warnings = probeRecords(parsed.map((p) => p.record));
  const unknown = new Set<string>();
  const drifted = new Set<string>();
  for (const w of warnings) {
    if (w.recordType.startsWith("unknown-type:")) {
      unknown.add(w.recordType.slice("unknown-type:".length));
    } else {
      drifted.add(w.recordType);
    }
  }

  const store = freshStore();
  try {
    const result = await ingestSession(store, capturePath, {
      captureBaseline: false,
      readBackup: corpusBackupReader(captureName),
    });
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
    const observed: Expectation = {
      unknown_record_types: [...unknown].sort(),
      known_types_with_drift: [...drifted].sort(),
      steps: steps.length,
      file_changes,
    };
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
    const observed = await observe(capturePath, name);
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
      observed.unknown_record_types,
      expected.unknown_record_types,
      "unknown record types changed — Claude Code added or we started handling a record type; re-pin with UPDATE_CORPUS=1 once types.ts / shape_probe.ts cover it",
    );
    assert.deepEqual(
      observed.known_types_with_drift,
      expected.known_types_with_drift,
      "field drift on a known record type changed — check the probe output, then re-pin",
    );
    assert.equal(observed.steps, expected.steps, "step count changed");
    assert.deepEqual(
      observed.file_changes,
      expected.file_changes,
      "derived file_change rows changed — a fidelity regression unless intentional",
    );
  });
}
