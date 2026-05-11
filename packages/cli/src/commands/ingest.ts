import { existsSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import {
  discoverSessions,
  ingestSession,
} from "@spool/claude-code-adapter";
import { openStore } from "../util.ts";

export function registerIngestCommand(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Capture agent runs into the local store");

  ingest
    .command("claude-code [path]")
    .description(
      "Import Claude Code sessions. With no path, ingests every session under ~/.claude/projects (only new bytes per file).",
    )
    .option("--cwd <dir>", "Restrict to a project by working directory")
    .option("--limit <n>", "Cap number of sessions ingested", (v) => parseInt(v, 10))
    .action(async (
      path: string | undefined,
      opts: { cwd?: string; limit?: number },
    ) => {
      const store = openStore();
      try {
        let paths: string[] = [];
        if (path) {
          if (!existsSync(path)) throw new Error(`not found: ${path}`);
          paths = [path];
        } else {
          const sessions = await discoverSessions({ cwd: opts.cwd });
          paths = sessions.map((s) => s.path);
          if (opts.limit) paths = paths.slice(0, opts.limit);
        }
        if (paths.length === 0) {
          console.log(pc.dim("no sessions to ingest"));
          return;
        }
        let totalSteps = 0;
        let totalBytes = 0;
        let runs = 0;
        for (const p of paths) {
          const r = await ingestSession(store, p);
          if (r.status === "empty") {
            console.log(`${pc.dim("skip")}  ${p} ${pc.dim("(no new bytes)")}`);
            continue;
          }
          runs += 1;
          totalSteps += r.steps_added;
          totalBytes += r.bytes_read;
          console.log(
            `${pc.green("ingested")}  ${p}  ${pc.dim(
              `run=${r.run_id.slice(0, 12)} steps=${r.steps_added} bytes=${r.bytes_read}`,
            )}`,
          );
        }
        console.log(
          pc.bold(
            `\n${runs} run(s) updated · ${totalSteps} step(s) · ${(totalBytes / 1024).toFixed(1)}KB read`,
          ),
        );
      } finally {
        store.close();
      }
    });

  ingest
    .command("discover")
    .description("List Claude Code sessions visible to Spool, newest first")
    .option("--cwd <dir>", "Restrict to one project")
    .action(async (opts: { cwd?: string }) => {
      const sessions = await discoverSessions({ cwd: opts.cwd });
      if (sessions.length === 0) {
        console.log(pc.dim("no sessions found"));
        return;
      }
      console.log(pc.bold("Sessions:"));
      for (const s of sessions.slice(0, 50)) {
        console.log(
          `  ${pc.cyan(s.session_id.slice(0, 8))}  ${s.mtime.toISOString()}  ${(s.size_bytes / 1024).toFixed(1).padStart(8)}KB  ${pc.dim(s.project_dir)}`,
        );
      }
      if (sessions.length > 50) {
        console.log(pc.dim(`  … ${sessions.length - 50} more`));
      }
    });
}
