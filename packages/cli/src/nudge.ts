import { existsSync } from "node:fs";
import pc from "picocolors";
import {
  Store,
  getSetting,
  latestRecentWatchCaptureRunId,
  LIVE_HEARTBEAT_FRESH_MS,
} from "@meterbility/collector";
import { dbPath } from "@meterbility/shared";

/**
 * The "capture active — `meter live` to attach" nudge
 * (docs/designs/meter-live-front-door.md §6).
 *
 * Fires when watch/hook-derived FileChange rows landed in the last 10
 * minutes (capture is happening) AND the `live.heartbeat` setting is
 * absent or staler than the shared freshness window (no live viewer
 * attached). One dim line; forgetting to attach recovers itself at the
 * next command.
 *
 * Safety contract (eng review 4A) — this is decoration on the hot path
 * of EVERY human command, so it must never cost anything when things
 * are off:
 *   - runs only when the store file already exists (`existsSync`) —
 *     checking must never create `~/.meter` as a side effect;
 *   - the entire check swallows all errors (locked DB, mid-upgrade
 *     schema — the command the user actually ran is unaffected);
 *   - a time budget aborts when just opening the store was slow (cold
 *     disk, contention — the wrong moment for decoration). Injectable
 *     so tests can pin both sides of the branch deterministically
 *     instead of racing the wall clock.
 *   - excluded commands: hook hot paths (`capture`, `cursor-hook`),
 *     child-stdio wrappers (`run` prints its own attach hint after its
 *     proxy starts), the attach targets themselves (`live`, `watch`),
 *     and any `--json` invocation (scripts parse stdout).
 */

const RECENT_CAPTURE_WINDOW_MS = 10 * 60_000;
const DEFAULT_OPEN_BUDGET_MS = 50;
const EXCLUDED_COMMANDS = new Set([
  "capture",
  "cursor-hook",
  "run",
  "live",
  "watch",
]);

export function maybePrintAttachNudge(
  commandName: string,
  opts: Record<string, unknown>,
  { openBudgetMs = DEFAULT_OPEN_BUDGET_MS }: { openBudgetMs?: number } = {},
): void {
  try {
    if (EXCLUDED_COMMANDS.has(commandName)) return;
    if (opts["json"]) return;
    if (!existsSync(dbPath())) return;

    const t0 = Date.now();
    const store = Store.open();
    try {
      if (Date.now() - t0 > openBudgetMs) return;
      const hb = getSetting(store, "live.heartbeat");
      if (hb !== undefined) {
        const age = Date.now() - Date.parse(hb);
        if (Number.isFinite(age) && age < LIVE_HEARTBEAT_FRESH_MS) return;
      }
      const cutoff = new Date(Date.now() - RECENT_CAPTURE_WINDOW_MS).toISOString();
      const runId = latestRecentWatchCaptureRunId(store, cutoff);
      if (runId === undefined) return;
      console.error(
        pc.dim(
          `capture active on ${runId.slice(0, 12)} — \`meter live\` to attach`,
        ),
      );
    } finally {
      store.close();
    }
  } catch {
    // Decoration never fails the command the user ran (4A).
  }
}
