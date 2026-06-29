import { existsSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import {
  discoverSessions,
  ingestSession,
} from "@meterbility/claude-code-adapter";
import {
  discoverCodexSessions,
  ingestCodexSession,
} from "@meterbility/codex-cli-adapter";
import {
  defaultGlobalDbPath,
  discoverCursorWorkspaces,
  ingestCursorGlobal,
} from "@meterbility/cursor-adapter";
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
    .command("codex-cli [path]")
    .description(
      "Import Codex / Codex Desktop sessions. With no path, ingests every rollout under ~/.codex/sessions.",
    )
    .option("--limit <n>", "Cap number of sessions ingested", (v) => parseInt(v, 10))
    .action(async (path: string | undefined, opts: { limit?: number }) => {
      const store = openStore();
      try {
        let paths: string[] = [];
        if (path) {
          if (!existsSync(path)) throw new Error(`not found: ${path}`);
          paths = [path];
        } else {
          const sessions = await discoverCodexSessions();
          paths = sessions.map((s) => s.path);
          if (opts.limit) paths = paths.slice(0, opts.limit);
        }
        if (paths.length === 0) {
          console.log(pc.dim("no Codex sessions to ingest"));
          return;
        }
        let runs = 0;
        let totalSteps = 0;
        let totalBytes = 0;
        for (const p of paths) {
          const r = await ingestCodexSession(store, p);
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
    .command("cursor")
    .description(
      "Import Cursor composer (Agents/Composer window) conversations from the global state.vscdb.",
    )
    .option("--db <path>", "Override path to Cursor's state.vscdb")
    .option("--composer <id>", "Restrict to one composer id")
    .option(
      "--limit <n>",
      "Cap composers ingested (newest-first)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--since <iso>",
      "Skip composers older than this ISO timestamp",
    )
    .option(
      "--cwd <dir>",
      "Project cwd to attribute the runs to (defaults to '(cursor)')",
    )
    .option(
      "--list-workspaces",
      "Just print discovered Cursor workspaces and exit",
    )
    .action(async (opts: {
      db?: string;
      composer?: string;
      limit?: number;
      since?: string;
      cwd?: string;
      listWorkspaces?: boolean;
    }) => {
      if (opts.listWorkspaces) {
        const ws = await discoverCursorWorkspaces();
        if (ws.length === 0) {
          console.log(pc.dim("no Cursor workspace storage found"));
          return;
        }
        console.log(pc.bold("Cursor workspaces (newest first):"));
        for (const w of ws.slice(0, 20)) {
          console.log(
            `  ${pc.cyan(w.workspace_id.slice(0, 12))}  ${w.mtime.toISOString()}  ${pc.dim(w.path)}`,
          );
        }
        return;
      }
      const store = openStore();
      try {
        const sinceMs = opts.since ? Date.parse(opts.since) : undefined;
        const dbPath = opts.db ?? defaultGlobalDbPath();
        const r = await ingestCursorGlobal(store, {
          dbPath,
          composerId: opts.composer,
          limit: opts.limit,
          sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
          cwd: opts.cwd,
        });
        if (r.status !== "ok") {
          console.log(`${pc.yellow(r.status)}  ${r.reason ?? ""}`);
          return;
        }
        console.log(
          pc.bold(
            `${r.composers_ingested}/${r.composers_seen} composer(s) · ${r.steps_added} step(s)`,
          ),
        );
      } finally {
        store.close();
      }
    });

  ingest
    .command("discover")
    .description("List Claude Code sessions visible to Meterbility, newest first")
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
