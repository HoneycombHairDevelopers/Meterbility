import { existsSync } from "node:fs";
import pc from "picocolors";
import { Store, getSetting } from "@meterbility/collector";
import { dbPath } from "@meterbility/shared";

/**
 * The "capture active — `meter live` to attach" nudge
 * (docs/designs/meter-live-front-door.md §6).
 *
 * Fires when watch/hook-derived FileChange rows landed in the last 10
 * minutes (capture is happening) AND the `live.heartbeat` setting is
 * absent or staler than 2 minutes (no live viewer attached). One dim
 * line; forgetting to attach recovers itself at the next command.
 *
 * Safety contract (eng review 4A) — this is decoration on the hot path
 * of EVERY human command, so it must never cost anything when things
 * are off:
 *   - runs only when the store file already exists (`existsSync`) —
 *     checking must never create `~/.meter` as a side effect;
 *   - the entire check swallows all errors (locked DB, mid-upgrade
 *     schema — the command the user actually ran is unaffected);
 *   - excluded commands: hook hot paths (`capture`, `cursor-hook`),
 *     child-stdio wrappers (`run` prints its own attach hint after its
 *     proxy starts), the attach targets themselves (`live`, `watch`),
 *     and any `--json` invocation (scripts parse stdout).
 */

const RECENT_CAPTURE_WINDOW_MS = 10 * 60_000;
const HEARTBEAT_FRESH_MS = 2 * 60_000;
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
): void {
  try {
    if (EXCLUDED_COMMANDS.has(commandName)) return;
    if (opts["json"]) return;
    if (!existsSync(dbPath())) return;

    const t0 = Date.now();
    const store = Store.open();
    try {
      // Time budget (4A): if just opening the store blew ~50ms (cold
      // disk, contention), this is the wrong moment for decoration.
      if (Date.now() - t0 > 50) return;
      const hb = getSetting(store, "live.heartbeat");
      if (hb !== undefined) {
        const age = Date.now() - Date.parse(hb);
        if (Number.isFinite(age) && age < HEARTBEAT_FRESH_MS) return;
      }
      const cutoff = new Date(Date.now() - RECENT_CAPTURE_WINDOW_MS).toISOString();
      const row = store.db
        .prepare(
          `SELECT fc.run_id FROM file_change fc
           WHERE fc.derived_from = 'filesystem_watch' AND fc.created_at > ?
           LIMIT 1`,
        )
        .get(cutoff) as { run_id: string } | undefined;
      if (!row) return;
      console.error(
        pc.dim(
          `capture active on ${row.run_id.slice(0, 12)} — \`meter live\` to attach`,
        ),
      );
    } finally {
      store.close();
    }
  } catch {
    // Decoration never fails the command the user ran (4A).
  }
}
