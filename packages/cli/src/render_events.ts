import pc from "picocolors";
import type {
  LiveEvent,
  FileSentinelEvent,
  FleetEntry,
} from "@meterbility/server";

/**
 * Shared terminal renderers for live-event streams. Extracted from
 * `meter watch` (eng review 2A) so `meter watch` and `meter live`
 * print identical lines for identical events — one place for every
 * future format change, and neither command imports the other.
 */

/**
 * Strip C0/C1 control characters and ESC from untrusted strings before
 * they reach the terminal (file paths from filesystem events, run
 * titles from ingested transcripts, sentinel error messages). A watched
 * repo or a prompt-injected agent can otherwise smuggle ANSI/OSC
 * sequences into filenames — spoofed lines, title/clipboard writes.
 */
export function sanitizeTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f\u009b]/g, "");
}

/** Single-letter op badge shared by watch's file events and live's
 *  step-file rows — one place, no drift. */
export function opBadge(op: string): string {
  return op === "create" ? "A" : op === "delete" ? "D" : "M";
}

/** `+N −M` line accounting, shared for the same reason. */
export function lineStat(c: { lines_added: number; lines_removed: number }): string {
  return `+${c.lines_added} −${c.lines_removed}`;
}

export function printFileEvent(e: FileSentinelEvent): void {
  const head = timeHead();
  switch (e.type) {
    case "sentinel:ready":
      console.log(
        head +
          pc.dim(
            `watching files under ${e.root} (${e.primed_files} files primed)`,
          ),
      );
      return;
    case "file:captured": {
      const c = e.change;
      const stat = c.partial_diff
        ? pc.dim("(partial)")
        : pc.dim(lineStat(c));
      console.log(
        head +
          pc.green("file:captured") +
          "  " +
          pc.cyan(e.run_id.slice(0, 12)) +
          `  ${opBadge(c.op)} ${sanitizeTerminal(c.path)}  ` +
          stat,
      );
      return;
    }
    case "file:unattributed":
      console.log(
        head + pc.dim(`file:unattributed  ${e.op} ${sanitizeTerminal(e.path)} (${e.reason})`),
      );
      return;
    case "file:skipped":
      if (e.reason === "unchanged") return; // pure noise
      console.log(
        head + pc.dim(`file:skipped  ${sanitizeTerminal(e.path)} (${e.reason})`),
      );
      return;
    case "sentinel:error":
      console.log(head + pc.red("sentinel:error") + "  " + sanitizeTerminal(e.message));
      return;
  }
}

export function printPretty(e: LiveEvent): void {
  const head = timeHead();
  switch (e.type) {
    case "run:created":
      console.log(
        head +
          pc.blue("run:created  ") +
          pc.cyan(e.run.run_id.slice(0, 12)) +
          (e.run.title ? "  " + sanitizeTerminal(e.run.title) : ""),
      );
      return;
    case "run:updated":
      console.log(
        head +
          pc.dim("run:updated  ") +
          pc.cyan(e.run.run_id.slice(0, 12)) +
          pc.dim(`  +${e.new_steps.length} step${e.new_steps.length === 1 ? "" : "s"}`),
      );
      return;
    case "run:completed":
      console.log(
        head +
          pc.green("run:completed") +
          "  " +
          pc.cyan(e.run.run_id.slice(0, 12)) +
          pc.dim(`  status=${e.run.status}`),
      );
      return;
    case "alert":
      console.log(
        head +
          pc.yellow(`alert[${e.kind}] `) +
          pc.cyan(e.run_id.slice(0, 12)) +
          "  " +
          e.message,
      );
      return;
    case "fleet:snapshot": {
      const counts = e.entries.reduce<Record<string, number>>((acc, x: FleetEntry) => {
        acc[x.status] = (acc[x.status] ?? 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log(
        head + pc.dim(`fleet:snapshot ${e.entries.length} runs · ${summary}`),
      );
      return;
    }
  }
}

export function timeHead(): string {
  return pc.dim(new Date().toISOString().slice(11, 19)) + "  ";
}
