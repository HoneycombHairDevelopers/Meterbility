import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import { claudeHome, claudeProjectsRoot, dbPath, spoolHome } from "@spool/shared";
import { discoverSessions } from "@spool/claude-code-adapter";

/**
 * The kickoff gate, productized. Verifies the environment, the Claude
 * Code session surface, and the Spool data plane — the same checklist
 * SPEC §18 calls out as the must-pass before week one.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Verify Spool can capture and store agent runs (Gate 2 check)")
    .action(async () => {
      let ok = 0;
      let warn = 0;
      let fail = 0;
      const line = (
        status: "ok" | "warn" | "fail",
        label: string,
        detail = "",
      ) => {
        const icon =
          status === "ok" ? pc.green("✔") : status === "warn" ? pc.yellow("⚠") : pc.red("✖");
        const tag =
          status === "ok"
            ? pc.green("PASS")
            : status === "warn"
              ? pc.yellow("WARN")
              : pc.red("FAIL");
        if (status === "ok") ok += 1;
        else if (status === "warn") warn += 1;
        else fail += 1;
        console.log(`${icon} [${tag}] ${pc.bold(label)} ${pc.dim(detail)}`);
      };

      // Node version — Spool uses `node --import tsx/esm` which requires
      // Node 20.6+. Older runtimes are accepted but flagged as warn since
      // the test runner and launcher will not work cleanly.
      const node = process.versions.node;
      const [major, minor] = node.split(".").map(Number) as [number, number];
      if (major > 20 || (major === 20 && minor >= 6) || major >= 22) {
        line("ok", "Node", `v${node}`);
      } else if (major >= 20) {
        line(
          "warn",
          "Node",
          `v${node} — upgrade to 20.6+ for full --import support`,
        );
      } else {
        line("fail", "Node version >= 20.6", `found v${node}`);
      }

      // Spool home
      line("ok", "SPOOL_HOME", spoolHome());

      // Claude home
      if (existsSync(claudeHome())) {
        line("ok", "CLAUDE_HOME", claudeHome());
      } else {
        line(
          "fail",
          "CLAUDE_HOME",
          `not found at ${claudeHome()} — set CLAUDE_HOME or install Claude Code`,
        );
      }

      // Projects dir
      if (existsSync(claudeProjectsRoot())) {
        line("ok", "Claude projects dir", claudeProjectsRoot());
      } else {
        line(
          "warn",
          "Claude projects dir",
          `no ${claudeProjectsRoot()} — nothing to ingest yet`,
        );
      }

      // Sessions discoverable
      try {
        const sessions = await discoverSessions();
        if (sessions.length === 0) {
          line("warn", "Session discovery", "no .jsonl session files found");
        } else {
          const newest = sessions[0]!;
          line(
            "ok",
            "Session discovery",
            `${sessions.length} session(s) — newest ${newest.session_id.slice(0, 8)} (${(newest.size_bytes / 1024).toFixed(0)}KB)`,
          );
        }
      } catch (err) {
        line("fail", "Session discovery", (err as Error).message);
      }

      // DB writable
      try {
        const { Store } = await import("@spool/collector");
        const store = Store.open();
        store.close();
        const s = await stat(dbPath());
        line("ok", "SQLite store", `${dbPath()} (${s.size} bytes)`);
      } catch (err) {
        line("fail", "SQLite store", (err as Error).message);
      }

      console.log("");
      console.log(
        pc.bold(
          `${pc.green(String(ok))} pass · ${pc.yellow(String(warn))} warn · ${pc.red(String(fail))} fail`,
        ),
      );
      if (fail > 0) process.exit(1);
    });
}
