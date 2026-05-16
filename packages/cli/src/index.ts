#!/usr/bin/env node
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

const program = new Command();
program
  .name("spool")
  .description(pc.bold("Spool ") + pc.dim("— the debugger for AI agents"))
  .version("0.1.0");

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
registerOpenCommand(program);
registerProxyCommand(program);
registerRunCommand(program);
registerRunsCommand(program);
registerInitCommand(program);
registerFilesCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red("error: ") + (err as Error).message);
  if (process.env.SPOOL_DEBUG) console.error(err);
  process.exit(1);
});
