import { spawn } from "node:child_process";
import http from "node:http";
import { Command } from "commander";
import pc from "picocolors";
import { getRun, getStep, getStepBySequence } from "@spool-ai/collector";
import { openStore } from "../util.ts";

/**
 * `spool open` — terminal-to-browser bridge. Resolves a short run id
 * (or run+step) against the local store, then launches the system browser
 * on the matching web URL. Optionally boots `spool web` first if it isn't
 * already listening on the chosen port.
 *
 * Common flow:
 *   $ spool list
 *   $ spool open run_abc123
 *
 * With --at it deep-links into the step view (and into the context tab when
 * the user passes --context):
 *   $ spool open run_abc123 --at 5 --context
 */
export function registerOpenCommand(program: Command): void {
  program
    .command("open <run-id>")
    .description("Open a run in the local Spool web UI (auto-starts the server if needed)")
    .option("--at <seq-or-step-id>", "Deep-link to a specific step")
    .option(
      "--context",
      "When --at is set, link into the resolved-context page",
    )
    .option("-p, --port <n>", "Web UI port", (v) => parseInt(v, 10), 4317)
    .option("-h, --host <addr>", "Web UI host", "127.0.0.1")
    .option("--no-launch", "Print the URL but do not open a browser or start the server")
    .option(
      "--print",
      "Print the URL and exit without opening (useful for piping to pbcopy)",
    )
    .action(
      async (
        runId: string,
        opts: {
          at?: string;
          context?: boolean;
          port: number;
          host: string;
          launch: boolean;
          print?: boolean;
        },
      ) => {
        const store = openStore();
        let url: string;
        try {
          const run = getRun(store, runId);
          if (!run) throw new Error(`run not found: ${runId}`);
          const fullRunId = run.run_id;
          let path = `/runs/${fullRunId}`;
          if (opts.at !== undefined) {
            const seq = Number(opts.at);
            const step = Number.isFinite(seq)
              ? getStepBySequence(store, fullRunId, seq)
              : getStep(store, opts.at);
            if (!step) throw new Error(`step not found: ${opts.at}`);
            if (opts.context) {
              path = `/contexts/${step.context_snapshot_id}`;
            } else {
              // The web UI uses #step-<id> anchors for in-page deep-links.
              path = `/runs/${fullRunId}#step-${step.step_id}`;
            }
          }
          url = `http://${opts.host}:${opts.port}${path}`;
        } finally {
          store.close();
        }

        if (opts.print) {
          process.stdout.write(url + "\n");
          return;
        }

        if (opts.launch === false) {
          console.log(pc.cyan(url));
          return;
        }

        const alive = await isServerUp(opts.host, opts.port);
        if (!alive) {
          console.log(
            pc.dim(
              `no server on ${opts.host}:${opts.port} — starting \`spool web\` in the background…`,
            ),
          );
          await launchDetachedWeb(opts.host, opts.port);
          // Poll briefly for it to come up — keep total under ~3s.
          const ready = await waitForServer(opts.host, opts.port, 3000);
          if (!ready) {
            console.error(
              pc.red("server didn't become reachable in time. ") +
                pc.dim(
                  `try \`spool web --port ${opts.port}\` in another terminal, then re-run.`,
                ),
            );
            process.exit(1);
          }
        }

        console.log(pc.green("opening ") + pc.cyan(url));
        await openBrowser(url);
      },
    );
}

function isServerUp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/api/runs", method: "GET", timeout: 500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForServer(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(host, port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function launchDetachedWeb(host: string, port: number): Promise<void> {
  // Re-invoke the same `spool` binary in the background. Inheriting argv[0]
  // (node) and argv[1] (the spool entry) keeps us robust to local installs,
  // global installs, and `npx spool` flows alike.
  const proc = spawn(
    process.execPath,
    [process.argv[1]!, "web", "--no-open", "--host", host, "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  proc.unref();
}

async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
