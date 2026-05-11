import { Command } from "commander";
import pc from "picocolors";
import { serveApp } from "@spool/server";
import { openStore } from "../util.ts";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Serve the Spool web UI on a local port")
    .option("-p, --port <n>", "Port", (v) => parseInt(v, 10), 4317)
    .option("-h, --host <addr>", "Host", "127.0.0.1")
    .option("--no-open", "Do not auto-open the browser")
    .action(async (opts: { port: number; host: string; open: boolean }) => {
      const store = openStore();
      const { url } = serveApp(store, { port: opts.port, host: opts.host });
      console.log(pc.green("Spool running at ") + pc.cyan(url));
      console.log(pc.dim("press ctrl-c to stop"));
      if (opts.open !== false) {
        await openBrowser(url);
      }
    });
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
