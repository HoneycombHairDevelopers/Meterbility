#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import { registerIngestCommand } from "./commands/ingest.ts";
import { registerListCommand } from "./commands/list.ts";
import { registerInspectCommand } from "./commands/inspect.ts";
import { registerForkCommand } from "./commands/fork.ts";
import { registerDiffCommand } from "./commands/diff.ts";
import { registerAnnotateCommand } from "./commands/annotate.ts";
import { registerWebCommand } from "./commands/web.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerExportCommand } from "./commands/export.ts";
import { registerTestCommand } from "./commands/test.ts";
import { registerDbCommand } from "./commands/db.ts";
import { registerSlackCommand } from "./commands/slack.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerWatchCommand } from "./commands/watch.ts";
import { registerOpenCommand } from "./commands/open.ts";
import { registerProxyCommand } from "./commands/proxy.ts";
import { registerRunCommand } from "./commands/run.ts";
import { registerRunsCommand } from "./commands/runs.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerFilesCommand } from "./commands/files.ts";
import { registerProbeCommand } from "./commands/probe.ts";
import { registerCaptureCommand } from "./commands/capture.ts";
import { registerCursorHookCommand } from "./commands/cursor-hook.ts";

// Single source of truth for the version: the package manifest. Both
// the dev entry (src/index.ts via tsx) and the built one (dist/index.js)
// sit one level below the package root, so ../package.json resolves in
// either form.
const VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ) as { version: string }
).version;

const program = new Command();
program
  .name("meter")
  .description(
    pc.bold("Meterbility ") +
      pc.dim(`v${VERSION} — the debugger for AI agents`),
  )
  .version(VERSION);

registerDoctorCommand(program);
registerIngestCommand(program);
registerListCommand(program);
registerInspectCommand(program);
registerForkCommand(program);
registerDiffCommand(program);
registerAnnotateCommand(program);
registerWebCommand(program);
registerExportCommand(program);
registerTestCommand(program);
registerDbCommand(program);
registerSlackCommand(program);
registerConfigCommand(program);
registerWatchCommand(program);
registerCaptureCommand(program);
registerCursorHookCommand(program);
registerOpenCommand(program);
registerProxyCommand(program);
registerRunCommand(program);
registerRunsCommand(program);
registerInitCommand(program);
registerFilesCommand(program);
registerProbeCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red("error: ") + (err as Error).message);
  if (process.env.METERBILITY_DEBUG) console.error(err);
  process.exit(1);
});
