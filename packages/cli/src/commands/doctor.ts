import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import { claudeHome, claudeProjectsRoot, dbPath, meterHome } from "@meterbility/shared";
import { discoverSessions } from "@meterbility/claude-code-adapter";

type CheckStatus = "ok" | "warn" | "fail";
interface CheckResult {
  status: CheckStatus;
  label: string;
  detail: string;
}

/**
 * The kickoff gate, productized. Verifies the environment, the Claude
 * Code session surface, and the Meterbility data plane — the same checklist
 * SPEC §18 calls out as the must-pass before week one.
 *
 * --json emits a machine-readable summary so CI workflows / setup scripts
 * can gate on `meter doctor --json | jq -e '.summary.fail == 0'` without
 * scraping ANSI output.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Verify Meterbility can capture and store agent runs (Gate 2 check)")
    .option("--json", "Emit results as a single JSON object instead of pretty output")
    .action(async (opts: { json?: boolean }) => {
      const checks: CheckResult[] = [];
      const record = (status: CheckStatus, label: string, detail = ""): void => {
        checks.push({ status, label, detail });
      };

      // Node version — Meterbility uses `node --import tsx/esm` which requires
      // Node 20.6+. Older runtimes are accepted but flagged as warn since
      // the test runner and launcher will not work cleanly.
      const node = process.versions.node;
      const [major, minor] = node.split(".").map(Number) as [number, number];
      if (major > 20 || (major === 20 && minor >= 6) || major >= 22) {
        record("ok", "Node", `v${node}`);
      } else if (major >= 20) {
        record(
          "warn",
          "Node",
          `v${node} — upgrade to 20.6+ for full --import support`,
        );
      } else {
        record("fail", "Node version >= 20.6", `found v${node}`);
      }

      // Meterbility home
      record("ok", "METERBILITY_HOME", meterHome());

      // Claude home
      if (existsSync(claudeHome())) {
        record("ok", "CLAUDE_HOME", claudeHome());
      } else {
        record(
          "fail",
          "CLAUDE_HOME",
          `not found at ${claudeHome()} — set CLAUDE_HOME or install Claude Code`,
        );
      }

      // Projects dir
      if (existsSync(claudeProjectsRoot())) {
        record("ok", "Claude projects dir", claudeProjectsRoot());
      } else {
        record(
          "warn",
          "Claude projects dir",
          `no ${claudeProjectsRoot()} — nothing to ingest yet`,
        );
      }

      // Sessions discoverable
      try {
        const sessions = await discoverSessions();
        if (sessions.length === 0) {
          record("warn", "Session discovery", "no .jsonl session files found");
        } else {
          const newest = sessions[0]!;
          record(
            "ok",
            "Session discovery",
            `${sessions.length} session(s) — newest ${newest.session_id.slice(0, 8)} (${(newest.size_bytes / 1024).toFixed(0)}KB)`,
          );
        }
      } catch (err) {
        record("fail", "Session discovery", (err as Error).message);
      }

      // DB writable
      try {
        const { Store } = await import("@meterbility/collector");
        const store = Store.open();
        store.close();
        const s = await stat(dbPath());
        record("ok", "SQLite store", `${dbPath()} (${s.size} bytes)`);
      } catch (err) {
        record("fail", "SQLite store", (err as Error).message);
      }

      const summary = checks.reduce(
        (acc, c) => {
          acc[c.status] += 1;
          return acc;
        },
        { ok: 0, warn: 0, fail: 0 },
      );

      if (opts.json) {
        const payload = {
          meter_home: meterHome(),
          claude_home: claudeHome(),
          claude_projects_root: claudeProjectsRoot(),
          db_path: dbPath(),
          node: process.versions.node,
          checks,
          summary,
          ok: summary.fail === 0,
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        if (summary.fail > 0) process.exit(1);
        return;
      }

      for (const c of checks) {
        const icon =
          c.status === "ok"
            ? pc.green("✔")
            : c.status === "warn"
              ? pc.yellow("⚠")
              : pc.red("✖");
        const tag =
          c.status === "ok"
            ? pc.green("PASS")
            : c.status === "warn"
              ? pc.yellow("WARN")
              : pc.red("FAIL");
        console.log(`${icon} [${tag}] ${pc.bold(c.label)} ${pc.dim(c.detail)}`);
      }
      console.log("");
      console.log(
        pc.bold(
          `${pc.green(String(summary.ok))} pass · ${pc.yellow(String(summary.warn))} warn · ${pc.red(String(summary.fail))} fail`,
        ),
      );
      if (summary.fail > 0) process.exit(1);
    });
}
