import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_METERBILITYIGNORE } from "@meterbility/shared";

/**
 * `meter init` — scaffolds the per-project opt-in for v0.3 file capture
 * (SPEC §7.1 + §10.3).
 *
 * Writes two files at the chosen root (defaults to cwd):
 *
 *   1. `.meterbility/config.toml` — the repo-level opt-in toggle. v0.3 file
 *      capture is OFF by default until the user runs this command;
 *      that's the local-first stance the spec calls out (§10.3, mirrors
 *      v0.2 §17). Without this file, FileChange rows still emit but
 *      with no blob refs, so the *fact* of an edit is recorded but the
 *      contents aren't.
 *
 *   2. `.meterbilityignore` — a user-editable copy of `DEFAULT_METERBILITYIGNORE`,
 *      pre-populated so the user can see and tweak what gets filtered.
 *
 * Idempotent: existing files are left alone unless `--force` is passed.
 * The exit code distinguishes the three outcomes so CI can gate on it
 * (0 = scaffold created or already present, 2 = bad arg).
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init [path]")
    .description(
      "Scaffold .meterbility/config.toml and .meterbilityignore for v0.3 file capture",
    )
    .option(
      "--force",
      "Overwrite existing files (default: leave existing files untouched)",
    )
    .option(
      "--quiet",
      "Suppress per-file output (still prints the final summary)",
    )
    .option(
      "--hooks",
      "Also install Claude Code PreToolUse/PostToolUse hooks for exact Bash file capture (meter capture)",
    )
    .action(async (
      pathArg: string | undefined,
      opts: { force?: boolean; quiet?: boolean; hooks?: boolean },
    ) => {
      const root = resolve(pathArg ?? process.cwd());
      if (!existsSync(root)) {
        console.error(pc.red(`meter init: target path does not exist: ${root}`));
        process.exit(2);
      }

      // Determine what to write. Each entry has a path + the contents
      // we'd produce on a fresh write. Existing-file logic lives at
      // the writeIfNeeded boundary below.
      const ignorePath = join(root, ".meterbilityignore");
      const configDir = join(root, ".meter");
      const configPath = join(configDir, "config.toml");

      mkdirSync(configDir, { recursive: true });

      const ignoreResult = await writeIfNeeded(
        ignorePath,
        renderMeterbilityignore(),
        opts.force === true,
      );
      const configResult = await writeIfNeeded(
        configPath,
        renderConfigToml(),
        opts.force === true,
      );

      let hooksResult: HooksInstallResult | undefined;
      if (opts.hooks) {
        hooksResult = await installClaudeHooks(root);
      }

      if (!opts.quiet) {
        printFileResult(".meterbilityignore", ignorePath, ignoreResult);
        printFileResult(".meterbility/config.toml", configPath, configResult);
        if (hooksResult) {
          const tag =
            hooksResult === "installed"
              ? pc.green("installed")
              : pc.dim("already present");
          console.log(
            `  ${tag}  ${pc.cyan("meter capture hooks")} ${pc.dim(
              `(${join(root, ".claude", "settings.json")})`,
            )}`,
          );
        }
      }

      // Summary footer. Tells the user what to do next; the call-to-
      // action is the part that actually drives adoption.
      const allCreated =
        ignoreResult === "created" && configResult === "created";
      if (allCreated) {
        console.log(
          pc.bold(pc.green("\nmeter init: scaffolded")) +
            pc.dim(" — v0.3 file capture is now on for this project."),
        );
      } else {
        console.log(
          pc.dim(
            "\nmeter init: complete. Re-run with --force to regenerate existing files.",
          ),
        );
      }
      console.log(
        pc.dim(
          "  edit .meterbilityignore to tune what gets captured\n" +
            "  see `meter files <run-id>` after your next Claude Code session",
        ),
      );
    });
}

type WriteResult = "created" | "skipped" | "overwritten";

type HooksInstallResult = "installed" | "already-present";

/**
 * Merge the `meter capture` hook pair into the project's
 * `.claude/settings.json` (v0.4 exact Bash capture):
 *
 *   PreToolUse(Bash)  → meter capture pre
 *   PostToolUse(Bash) → meter capture post
 *
 * Non-destructive: existing settings and hook entries are preserved;
 * we only append our matcher groups if no hook command containing
 * "meter capture" is already registered for that event. Idempotent by
 * the same check.
 */
async function installClaudeHooks(root: string): Promise<HooksInstallResult> {
  const dir = join(root, ".claude");
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(await readFile(path, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // Malformed settings.json — refuse to clobber the user's file.
      console.error(
        pc.yellow(
          `meter init: ${path} is not valid JSON — skipped hook install. Fix the file and re-run with --hooks.`,
        ),
      );
      return "already-present";
    }
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  let changed = false;
  for (const [event, phase] of [
    ["PreToolUse", "pre"],
    ["PostToolUse", "post"],
  ] as const) {
    const groups = (hooks[event] ??= []) as Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
    // Present if ANY variant of the capture hook is registered —
    // `meter capture pre`, `meter-dev capture pre`, or an absolute
    // path to either. Keying on the subcommand keeps re-runs of
    // `meter init --hooks` idempotent after a user points the command
    // at a dev build.
    const present = groups.some((g) =>
      (g.hooks ?? []).some(
        (h) =>
          typeof h.command === "string" &&
          /\bcapture (pre|post)\b/.test(h.command),
      ),
    );
    if (present) continue;
    groups.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: `meter capture ${phase}` }],
    });
    changed = true;
  }

  if (!changed) return "already-present";
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return "installed";
}

async function writeIfNeeded(
  path: string,
  contents: string,
  force: boolean,
): Promise<WriteResult> {
  const present = existsSync(path);
  if (present && !force) return "skipped";
  await writeFile(path, contents, "utf-8");
  return present ? "overwritten" : "created";
}

function printFileResult(label: string, path: string, result: WriteResult): void {
  const tag =
    result === "created"
      ? pc.green("created")
      : result === "overwritten"
        ? pc.yellow("overwrote")
        : pc.dim("kept existing");
  console.log(`  ${tag}  ${pc.cyan(label)} ${pc.dim(`(${path})`)}`);
}

/**
 * Render the default `.meterbilityignore`. We ship one line per pattern,
 * grouped by the same sections used in `DEFAULT_METERBILITYIGNORE`, so the
 * file is editable by humans. Comments explain each section so users
 * understand what they're inheriting.
 */
function renderMeterbilityignore(): string {
  return `# .meterbilityignore — paths Meterbility excludes from file capture (v0.3+).
# Same syntax subset as .gitignore. First match wins; no negation in v0.3.
# Generated by \`meter init\`. Edit freely.

# Build artifacts
node_modules/
dist/
build/
.next/
target/
.cache/

# Language-specific
.venv/
__pycache__/
*.pyc

# Version control internals
.git/objects/
.git/logs/

# Editor / OS
.DS_Store
.idea/
.vscode/

# Coverage / tooling
coverage/
.nyc_output/

# Sensitive by default — paired with redaction rules in the collector
.env
.env.*
*.pem
*.key
id_rsa*
id_ed25519*
credentials.json
.aws/
.kube/config
`;
}

/**
 * The opt-in `.meterbility/config.toml`. v0.3 reads `[capture.files].enabled`
 * to gate FileChange blob capture; the other keys are wired through
 * in v0.4 (the spec leaves them defined for forward-compat).
 */
function renderConfigToml(): string {
  return `# .meterbility/config.toml — per-project Meterbility configuration.
# v0.3 reads [capture.files] only; later milestones add more sections.

[capture.files]
# When false, FileChange rows still record the *fact* of an edit but
# leave before/after blob refs unset (partial_diff = true). Set true to
# capture the bytes Claude Code / Codex / the SDK / the proxy actually
# wrote. Off-by-default because capturing code from a random \`cd\`
# deserves deliberation.
enabled = true

# Glob patterns. Empty include = "everything not ignored."
include = []
exclude = []

# Files larger than this are excluded from the baseline manifest and
# from full-snapshot FileChange capture. Defaults to 5 MB; the
# patch_text on the row still records the edit when applicable. Raise
# this for repos with large generated assets you actually want
# captured.
max_file_size_bytes = 5_242_880

# Binary detection strategy. "null-byte-heuristic" matches PR 1's
# isProbablyText (NUL in first 8 KB ⇒ binary). "magic-bytes" is
# scheduled for v0.4 — it parses file magic for higher precision.
binary_detection = "null-byte-heuristic"
`;
}

// Re-export for the index registration.
export { DEFAULT_METERBILITYIGNORE };
