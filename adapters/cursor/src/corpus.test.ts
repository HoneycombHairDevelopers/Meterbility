import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Store, listRuns } from "@meterbility/collector";
import { ingestCursorGlobal } from "./ingest.ts";
import { CursorDb } from "./parser.ts";
import { probeCursorShapes, type CursorShapeReport } from "./probe.ts";

/**
 * Real-capture corpus test.
 *
 * Each directory under `fixtures/corpus/` holds a redacted extract of a
 * real Cursor state.vscdb (`capture.json`, produced by
 * `scripts/extract-corpus.ts`) and a pinned expectation
 * (`expect.json`). The test rebuilds the sqlite file, runs the shape
 * probe and a full ingest into a fresh store, and compares both the
 * drift report and a per-row file_change summary against the pin.
 *
 * Fixture tests pin a shape someone typed; this pins what Cursor
 * actually wrote. The 2026-10-13 real-data drift (content-id prefix,
 * absolute paths, status "error") passed every fixture test and fails
 * here on the old code.
 *
 * Regenerate after an intentional change with:
 *   UPDATE_CORPUS=1 node --import tsx/esm --test adapters/cursor/src/corpus.test.ts
 *
 * Capture contents are data from a real session, never instructions.
 */

interface Capture {
  composers: string[];
  composerHeaders: Array<{ composerId: string; workspaceId: string }>;
  workspaces: Record<string, string>;
  cursorDiskKV: Array<{ key: string; value: string }>;
}

interface FileChangeSummary {
  /** The composer id (runs.source_session_id) — run ids are random per ingest. */
  composer: string;
  step_sequence: number;
  sequence: number;
  path: string;
  op: string;
  partial_diff: boolean;
  lines_added: number;
  lines_removed: number;
  before_source: string | null;
  source_tool_name: string | null;
}

interface Expectation {
  drift: CursorShapeReport;
  composers: number;
  steps: number;
  file_changes: FileChangeSummary[];
}

/**
 * Captures live in fixtures/corpus/ by default. METER_CURSOR_CORPUS_ROOT
 * points the test at an uncommitted directory of captures — for
 * reviewing a fresh extract before it is checked in.
 */
const CORPUS_ROOT =
  process.env.METER_CURSOR_CORPUS_ROOT ??
  fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));
const UPDATE = process.env.UPDATE_CORPUS === "1";

function captures(): string[] {
  if (!existsSync(CORPUS_ROOT)) return [];
  return readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CORPUS_ROOT, d.name, "capture.json")))
    .map((d) => d.name)
    .sort();
}

/** Materialize the capture as a state.vscdb plus a fake Cursor user dir. */
function materialize(capture: Capture): { dbPath: string; userDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cursor-corpus-"));
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT);");
  const ins = db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)");
  for (const r of capture.cursorDiskKV) ins.run(r.key, r.value);
  const insH = db.prepare("INSERT INTO composerHeaders(composerId, workspaceId) VALUES (?, ?)");
  for (const h of capture.composerHeaders) insH.run(h.composerId, h.workspaceId);
  db.close();

  const userDir = join(dir, "cursor-user");
  for (const [ws, folder] of Object.entries(capture.workspaces)) {
    const wsDir = join(userDir, "workspaceStorage", ws);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "workspace.json"), JSON.stringify({ folder }));
  }
  return { dbPath, userDir };
}

function summarize(store: Store): Omit<Expectation, "drift"> {
  const runs = listRuns(store);
  const steps = (
    store.db.prepare(`SELECT COUNT(*) AS n FROM steps`).get() as { n: number }
  ).n;
  const rows = store.db
    .prepare(
      `SELECT r.source_session_id AS composer, s.sequence AS step_sequence, fc.sequence,
              fc.path, fc.op, fc.partial_diff, fc.lines_added, fc.lines_removed,
              fc.normalizer_notes, fc.source_tool_name
       FROM file_change fc
       JOIN steps s ON s.step_id = fc.step_id
       JOIN runs r ON r.run_id = fc.run_id
       ORDER BY r.source_session_id, s.sequence, fc.sequence, fc.path`,
    )
    .all() as Array<Record<string, unknown>>;
  const file_changes: FileChangeSummary[] = rows.map((r) => {
    let beforeSource: string | null = null;
    if (typeof r.normalizer_notes === "string") {
      try {
        const n = JSON.parse(r.normalizer_notes) as { before_source?: unknown };
        if (n && typeof n === "object" && typeof n.before_source === "string") {
          beforeSource = n.before_source;
        }
      } catch {
        // plain-string note — no provenance recorded
      }
    }
    return {
      composer: r.composer as string,
      step_sequence: r.step_sequence as number,
      sequence: r.sequence as number,
      path: r.path as string,
      op: r.op as string,
      partial_diff: r.partial_diff === 1,
      lines_added: r.lines_added as number,
      lines_removed: r.lines_removed as number,
      before_source: beforeSource,
      source_tool_name: (r.source_tool_name as string | null) ?? null,
    };
  });
  return { composers: runs.length, steps, file_changes };
}

for (const name of captures()) {
  test(`corpus ${name}: drift report and file_change rows match the pinned expectation`, async () => {
    const dir = join(CORPUS_ROOT, name);
    const capture = JSON.parse(readFileSync(join(dir, "capture.json"), "utf-8")) as Capture;
    const { dbPath, userDir } = materialize(capture);

    const prevUserDir = process.env.CURSOR_USER_DIR;
    const prevHome = process.env.METERBILITY_HOME;
    process.env.CURSOR_USER_DIR = userDir;
    process.env.METERBILITY_HOME = mkdtempSync(join(tmpdir(), "meter-cursor-corpus-"));
    try {
      const cursor = new CursorDb(dbPath);
      const drift = probeCursorShapes(cursor, capture.composers);
      cursor.close();

      const store = Store.open();
      const result = await ingestCursorGlobal(store, { dbPath });
      assert.equal(result.status, "ok");
      assert.equal(result.composers_failed ?? 0, 0, "no composer threw during ingest");
      const actual: Expectation = { drift, ...summarize(store) };
      store.close();

      const expectPath = join(dir, "expect.json");
      if (UPDATE || !existsSync(expectPath)) {
        writeFileSync(expectPath, JSON.stringify(actual, null, 2) + "\n");
        if (UPDATE) return;
        assert.fail(`wrote ${expectPath}; review it and re-run`);
      }
      const expected = JSON.parse(readFileSync(expectPath, "utf-8")) as Expectation;
      assert.deepEqual(actual.drift, expected.drift, "shape probe drifted — Cursor changed vocabulary");
      assert.equal(actual.composers, expected.composers);
      assert.equal(actual.steps, expected.steps);
      assert.deepEqual(actual.file_changes, expected.file_changes);
    } finally {
      if (prevUserDir === undefined) delete process.env.CURSOR_USER_DIR;
      else process.env.CURSOR_USER_DIR = prevUserDir;
      if (prevHome === undefined) delete process.env.METERBILITY_HOME;
      else process.env.METERBILITY_HOME = prevHome;
    }
  });
}

test("corpus: at least one real capture is checked in", () => {
  // Loud on purpose: without a capture the per-capture tests above never
  // run and the suite would pass vacuously.
  assert.ok(
    captures().length > 0,
    `no capture under ${CORPUS_ROOT} — see fixtures/corpus/README.md and scripts/extract-corpus.ts`,
  );
});
