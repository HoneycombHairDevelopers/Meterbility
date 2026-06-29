import { Command } from "commander";
import { readFileSync } from "node:fs";
import pc from "picocolors";
import {
  clearProbe,
  type ProbeRecord,
  readState,
  requestPause,
  requestResume,
  setInject,
} from "@meterbility/shared";
import { getRun } from "@meterbility/collector";
import { openStore } from "../util.ts";

/**
 * `meter probe` — Live Probe operator surface. Track B / Turn 8 chunk 4.
 *
 * Talks to the file-based probe protocol (`@meterbility/shared`/probe.ts).
 * The SDK side runs inside the agent's process when
 * `tracer.probeEnabled` is on; this CLI is what the human types to
 * pause, inject a nudge, and resume.
 *
 * Subcommands:
 *
 *   meter probe status <run-id> [--json]
 *     Print the current ProbeRecord. Human-readable by default,
 *     machine-shaped with --json. Errors if the run id doesn't resolve.
 *
 *   meter probe pause <run-id> [--json]
 *     Operator side: requestPause. Graceful — the SDK finishes the
 *     in-flight model call before acknowledging.
 *
 *   meter probe inject <run-id> -m <msg> | --stdin [--force] [--json]
 *     Operator side: setInject. The message gets appended as a new
 *     user turn to the NEXT model call (whether or not the run is
 *     paused). `--stdin` reads from stdin so multi-line messages don't
 *     need shell-escape gymnastics. Warns + errors if an inject is
 *     already queued unless `--force` is passed.
 *
 *   meter probe resume <run-id> [--json]
 *     Operator side: requestResume. Preserves any pending inject —
 *     "resume with this message" is a legal pattern.
 *
 *   meter probe clear <run-id>
 *     Remove the probe file. Used to recover from a stale `paused`
 *     state on a run that's no longer being polled (e.g. SDK crashed
 *     before `tracer.end()` could clean up). Does NOT require the run
 *     to exist in the store — pure file cleanup.
 *
 * Run-id resolution mirrors `meter inspect`: full id or unique 6+-char
 * prefix. Inherited from `getRun()` in @meterbility/collector.
 */
export function registerProbeCommand(program: Command): void {
  const probe = program
    .command("probe")
    .description(
      "Pause, inject a message, or resume a running agent (Live Probe)",
    );

  probe
    .command("status <run-id>")
    .description("Show current probe state for a run")
    .option("--json", "Emit the full ProbeRecord as one JSON line")
    .action(async (runIdArg: string, opts: { json?: boolean }) => {
      const runId = await resolveRunId(runIdArg);
      const state = readState(runId);
      if (opts.json) {
        process.stdout.write(JSON.stringify(state) + "\n");
        return;
      }
      printStatus(runId, state);
    });

  probe
    .command("pause <run-id>")
    .description(
      "Request a graceful pause — SDK finishes current call before yielding",
    )
    .option("--json", "Emit the resulting ProbeRecord as JSON")
    .action(async (runIdArg: string, opts: { json?: boolean }) => {
      const runId = await resolveRunId(runIdArg);
      const prev = readState(runId);
      const next = requestPause(runId);
      if (opts.json) {
        process.stdout.write(JSON.stringify(next) + "\n");
        return;
      }
      if (prev.state === "pause_requested" || prev.state === "paused") {
        console.log(
          pc.dim(
            `already ${prev.state} (since ${fmtAgoFromMs(prev.requested_at_ms)})`,
          ),
        );
      } else {
        console.log(
          pc.yellow("pause requested  ") +
            pc.cyan(runId.slice(0, 12)) +
            pc.dim("  (will take effect after the current model call)"),
        );
      }
    });

  probe
    .command("inject <run-id>")
    .description(
      "Queue a message to be appended to the next user turn (pause + inject + resume is the natural flow)",
    )
    .option(
      "-m, --message <text>",
      "Message text. Use --stdin for multi-line or to avoid shell-quoting",
    )
    .option("--stdin", "Read the message from stdin")
    .option(
      "--force",
      "Overwrite a pending inject without warning",
    )
    .option("--json", "Emit the resulting ProbeRecord as JSON")
    .action(
      async (
        runIdArg: string,
        opts: { message?: string; stdin?: boolean; force?: boolean; json?: boolean },
      ) => {
        const runId = await resolveRunId(runIdArg);
        const message = readInjectMessage(opts);
        const prev = readState(runId);
        if (
          prev.inject !== null &&
          prev.inject !== undefined &&
          !opts.force
        ) {
          throw new Error(
            `a pending inject is already queued for this run (use --force to overwrite). ` +
              `current: ${JSON.stringify(prev.inject)}`,
          );
        }
        const next = setInject(runId, message);
        if (opts.json) {
          process.stdout.write(JSON.stringify(next) + "\n");
          return;
        }
        console.log(
          pc.green("inject queued  ") +
            pc.cyan(runId.slice(0, 12)) +
            pc.dim(
              `  (${message.length} chars, will land on next model call)`,
            ),
        );
      },
    );

  probe
    .command("resume <run-id>")
    .description(
      "Resume a paused run. Preserves any pending inject — operator can resume-with-message",
    )
    .option("--json", "Emit the resulting ProbeRecord as JSON")
    .action(async (runIdArg: string, opts: { json?: boolean }) => {
      const runId = await resolveRunId(runIdArg);
      const prev = readState(runId);
      const next = requestResume(runId);
      if (opts.json) {
        process.stdout.write(JSON.stringify(next) + "\n");
        return;
      }
      if (prev.state === "running") {
        console.log(pc.dim("already running — nothing to do"));
      } else {
        const carried =
          next.inject !== null
            ? pc.dim(`  (carrying pending inject — will land on next call)`)
            : "";
        console.log(
          pc.green("resumed  ") + pc.cyan(runId.slice(0, 12)) + carried,
        );
      }
    });

  probe
    .command("clear <run-id>")
    .description(
      "Remove the probe file. For stale recovery when the SDK crashed before tracer.end() ran",
    )
    .action(async (runIdArg: string) => {
      // No run-id resolution here — clear is pure file cleanup, and
      // an orphaned probe file shouldn't require the run row to exist.
      clearProbe(runIdArg);
      console.log(pc.dim(`cleared probe file for ${runIdArg}`));
    });
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a CLI-supplied run id (full or unique-prefix) to its full
 * form, validating against the store so probe operations on a typo'd
 * id fail with a useful message instead of silently writing a probe
 * file for a run that doesn't exist.
 */
async function resolveRunId(input: string): Promise<string> {
  const store = openStore();
  try {
    const run = getRun(store, input);
    if (!run) {
      throw new Error(
        `run not found: ${input} (provide the full id or a unique 6+-char prefix)`,
      );
    }
    return run.run_id;
  } finally {
    store.close();
  }
}

function readInjectMessage(opts: {
  message?: string;
  stdin?: boolean;
}): string {
  if (opts.stdin) {
    const buf = readFileSync(0, "utf-8");
    if (buf.length === 0) {
      throw new Error("--stdin specified but no input received on stdin");
    }
    // Strip a single trailing newline — natural artifact of `echo "..."`
    // pipes — without touching intentional blank-line endings.
    return buf.endsWith("\n") ? buf.slice(0, -1) : buf;
  }
  if (opts.message !== undefined) {
    if (opts.message === "") {
      throw new Error("--message cannot be empty");
    }
    return opts.message;
  }
  throw new Error("provide a message via -m <text> or --stdin");
}

function printStatus(runId: string, r: ProbeRecord): void {
  const stateColor =
    r.state === "running"
      ? pc.green
      : r.state === "pause_requested"
        ? pc.yellow
        : pc.red;
  console.log(pc.bold(runId));
  console.log(`  ${pc.dim("state")}        ${stateColor(r.state)}`);
  console.log(
    `  ${pc.dim("requested at")} ${fmtIsoFromMs(r.requested_at_ms)}`,
  );
  console.log(
    `  ${pc.dim("paused at")}    ${fmtIsoFromMs(r.paused_at_ms)}`,
  );
  console.log(
    `  ${pc.dim("resumed at")}   ${fmtIsoFromMs(r.resumed_at_ms)}`,
  );
  if (r.inject !== null) {
    console.log(
      `  ${pc.dim("inject")}       ${pc.cyan("queued")} (${r.inject.length} chars)`,
    );
    // Show first line of the inject text for context — don't dump the
    // whole thing in case it's long. Operator can read full text with
    // --json if they need to.
    const firstLine = r.inject.split("\n")[0] ?? "";
    const preview =
      firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    console.log(`               ${pc.dim("›")} ${preview}`);
  } else {
    console.log(`  ${pc.dim("inject")}       ${pc.dim("none")}`);
  }
}

function fmtIsoFromMs(ms: number | null): string {
  if (ms === null) return pc.dim("—");
  return new Date(ms).toISOString();
}

function fmtAgoFromMs(ms: number | null): string {
  if (ms === null) return "earlier";
  const delta = Date.now() - ms;
  if (delta < 1000) return "just now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
