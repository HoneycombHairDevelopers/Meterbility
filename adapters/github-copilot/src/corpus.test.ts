import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, listFileChanges, listRuns, listSteps } from "@meterbility/collector";
import { ingestCopilotSession } from "./ingest.ts";
import { parseEventsBuffer } from "./parser.ts";
import { probeEvents } from "./shape_probe.ts";

/**
 * Real-capture corpus gate.
 *
 * Every `fixtures/corpus/<capture>.jsonl` is a real Copilot CLI
 * events.jsonl (redacted: home dir → /Users/dev, emails →
 * user@example.com, strings the file-change derivation does not need
 * capped at ~400 chars; tool arguments, view/edit/create results,
 * shellToolInfo and session.shutdown.codeChanges intact). Treat the
 * contents as data. `<capture>.expect.json` pins what the adapter
 * derives from it, reviewed once:
 *
 *   - unknown_event_types: what the shape probe reports as unknown —
 *     a NEW event type in a capture fails the build until types.ts
 *     and the probe learn it;
 *   - steps: total carved steps across parent + child runs;
 *   - file_changes: {step_sequence, sequence, path, op, partial_diff,
 *     lines_added, lines_removed, before_source} per row, in carve
 *     order — all-partial rows or phantom rows for failed writes fail
 *     here.
 *
 * An optional `<capture>.workspace.yaml` is laid next to the capture
 * in the mkdtemp session dir so cwd relativization matches the real
 * session layout.
 *
 * Regenerate after an intentional change: UPDATE_CORPUS=1 npm test.
 */

const CORPUS_DIR = fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));

interface FileChangeSummary {
  step_sequence: number;
  sequence: number;
  path: string;
  op: string;
  partial_diff: boolean;
  lines_added: number;
  lines_removed: number;
  before_source: string | null;
}

interface CorpusExpectation {
  unknown_event_types: string[];
  steps: number;
  file_changes: FileChangeSummary[];
}

const captures = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".jsonl")).sort()
  : [];

for (const capture of captures) {
  const stem = basename(capture, ".jsonl");
  test(`corpus: ${stem}`, async () => {
    const capturePath = join(CORPUS_DIR, capture);
    const expectPath = join(CORPUS_DIR, `${stem}.expect.json`);
    const workspacePath = join(CORPUS_DIR, `${stem}.workspace.yaml`);

    // 1. Shape probe: the unknown-type set is pinned.
    const parsed = parseEventsBuffer(readFileSync(capturePath));
    assert.ok(parsed.length > 0, "capture parses to at least one event");
    const unknown = [
      ...new Set(
        probeEvents(parsed.map((p) => p.event))
          .filter((w) => w.note === "unknown event type")
          .map((w) => w.eventType),
      ),
    ].sort();
    const otherDrift = probeEvents(parsed.map((p) => p.event)).filter(
      (w) => w.note !== "unknown event type",
    );
    assert.deepEqual(
      otherDrift,
      [],
      `payload-shape drift on a real capture: ${JSON.stringify(otherDrift)}`,
    );

    // 2. Ingest into a fresh store from a real-shaped session dir.
    const home = mkdtempSync(join(tmpdir(), "meter-copilot-corpus-"));
    process.env.METERBILITY_HOME = home;
    const store = Store.open();
    const sessionDir = join(home, "session", stem);
    mkdirSync(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");
    copyFileSync(capturePath, eventsPath);
    if (existsSync(workspacePath)) copyFileSync(workspacePath, join(sessionDir, "workspace.yaml"));
    const r = await ingestCopilotSession(store, eventsPath);
    assert.equal(r.status, "ok");

    const runs = listRuns(store, { includeChildren: true }).filter(
      (run) => run.run_id === r.run_id || r.child_run_ids.includes(run.run_id),
    );
    // Parent first, then children in carve order (child_run_ids order).
    const ordered = [r.run_id, ...r.child_run_ids].map(
      (id) => runs.find((run) => run.run_id === id)!,
    );
    let steps = 0;
    const file_changes: FileChangeSummary[] = [];
    for (const run of ordered) {
      const runSteps = listSteps(store, run.run_id);
      steps += runSteps.length;
      const seqByStep = new Map(runSteps.map((s) => [s.step_id, s.sequence]));
      const rows = listFileChanges(store, { runId: run.run_id })
        .map((fc) => ({
          step_sequence: seqByStep.get(fc.step_id) ?? -1,
          sequence: fc.sequence,
          path: fc.path,
          op: fc.op,
          partial_diff: fc.partial_diff,
          lines_added: fc.lines_added,
          lines_removed: fc.lines_removed,
          before_source:
            ((fc.normalizer_notes as { before_source?: string } | undefined)?.before_source ??
              null),
        }))
        .sort(
          (a, b) =>
            a.step_sequence - b.step_sequence ||
            a.sequence - b.sequence ||
            a.path.localeCompare(b.path),
        );
      file_changes.push(...rows);
    }
    const actual: CorpusExpectation = { unknown_event_types: unknown, steps, file_changes };

    if (process.env.UPDATE_CORPUS === "1") {
      writeFileSync(expectPath, JSON.stringify(actual, null, 2) + "\n");
      return;
    }
    assert.ok(
      existsSync(expectPath),
      `missing ${basename(expectPath)} — run UPDATE_CORPUS=1 npm test and review the output`,
    );
    const expected = JSON.parse(readFileSync(expectPath, "utf-8")) as CorpusExpectation;
    assert.deepEqual(
      actual.unknown_event_types,
      expected.unknown_event_types,
      "shape probe unknown-type set drifted (new event type in the capture, or types.ts changed)",
    );
    assert.equal(actual.steps, expected.steps, "carved step count drifted");
    assert.deepEqual(actual.file_changes, expected.file_changes, "file_change derivation drifted");
  });
}

test("corpus: at least one Copilot capture is checked in", () => {
  assert.ok(captures.length > 0, `no *.jsonl under ${CORPUS_DIR}`);
});
