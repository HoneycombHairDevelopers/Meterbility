import { writeFile, readFile } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import { getRun, listSteps, listRuns } from "@meterbility/collector";
import {
  addAssertion,
  createTest,
  deleteTest,
  deriveAssertionsFromRun,
  getTestByName,
  listResults,
  listTests,
  runTest,
  type Assertion,
  type AssertionKind,
} from "@meterbility/server";
import { openStore } from "../util.ts";

const KINDS: AssertionKind[] = [
  "includes_tool_call",
  "excludes_tool_call",
  "tool_call_count",
  "output_contains",
  "output_does_not_contain",
  "min_steps",
  "max_steps",
  "final_status",
  "max_cost_cents",
  "no_error_step",
  "step_status_at",
];

export function registerTestCommand(program: Command): void {
  const test = program
    .command("test")
    .description("Regression tests — assertions over captured runs");

  test
    .command("list")
    .description("List defined regression tests")
    .action(() => {
      const store = openStore();
      try {
        const tests = listTests(store);
        if (tests.length === 0) {
          console.log(pc.dim("no tests defined. Try: meter test create <name> --from <run-id>"));
          return;
        }
        for (const t of tests) {
          console.log(
            `  ${pc.cyan(t.name.padEnd(28))}  ${pc.dim(t.assertions.length + " assertions")}  ${pc.dim(t.canonical_run_id?.slice(0, 12) ?? "")}  ${t.description ?? ""}`,
          );
        }
      } finally {
        store.close();
      }
    });

  test
    .command("create <name>")
    .description("Create a regression test, optionally derived from a canonical run")
    .option("--from <run-id>", "Derive assertions from this run")
    .option("--description <text>", "Free-form description")
    .option("--from-file <path>", "Load assertions from a JSON file")
    .action(async (
      name: string,
      opts: { from?: string; description?: string; fromFile?: string },
    ) => {
      const store = openStore();
      try {
        let assertions: Assertion[] = [];
        let canonicalRunId: string | undefined;
        if (opts.from) {
          const run = getRun(store, opts.from);
          if (!run) throw new Error(`run not found: ${opts.from}`);
          const steps = listSteps(store, run.run_id);
          assertions = deriveAssertionsFromRun(run, steps);
          canonicalRunId = run.run_id;
        }
        if (opts.fromFile) {
          const buf = await readFile(opts.fromFile, "utf-8");
          assertions = JSON.parse(buf) as Assertion[];
        }
        const t = createTest(store, {
          name,
          description: opts.description,
          assertions,
          canonical_run_id: canonicalRunId,
        });
        console.log(
          `${pc.green("created")}  ${t.name}  ${pc.dim(t.assertions.length + " assertions")}`,
        );
        for (const a of t.assertions) {
          console.log(
            `    ${pc.dim("·")} ${a.kind} ${pc.cyan(String(a.value))}${a.label ? pc.dim(`  (${a.label})`) : ""}`,
          );
        }
      } finally {
        store.close();
      }
    });

  test
    .command("add-assertion <test-name> <kind> <value>")
    .description(
      `Append an assertion to a test. Kinds: ${KINDS.join(", ")}.`,
    )
    .option("--at <seq>", "Step sequence (for step_status_at)", (v) => parseInt(v, 10))
    .option("--label <text>", "Friendly label")
    .action((name: string, kind: string, value: string, opts: { at?: number; label?: string }) => {
      if (!KINDS.includes(kind as AssertionKind)) {
        throw new Error(`unknown kind: ${kind}\nallowed: ${KINDS.join(", ")}`);
      }
      const store = openStore();
      try {
        const numericValue =
          /^[\d.]+$/.test(value) && !["final_status"].includes(kind)
            ? Number(value)
            : value;
        const t = addAssertion(store, name, {
          kind: kind as AssertionKind,
          value: numericValue,
          at: opts.at,
          label: opts.label,
        });
        console.log(
          `${pc.green("added")}  ${t.assertions.length} assertions on ${t.name}`,
        );
      } finally {
        store.close();
      }
    });

  test
    .command("rm <name>")
    .description("Delete a regression test")
    .action((name: string) => {
      const store = openStore();
      try {
        if (!deleteTest(store, name)) throw new Error(`test not found: ${name}`);
        console.log(`${pc.yellow("deleted")}  ${name}`);
      } finally {
        store.close();
      }
    });

  test
    .command("run <test-name> [run-id]")
    .description(
      "Run a test against a specific run, or against every captured run if no id is given",
    )
    .option("--limit <n>", "Cap runs scanned", (v) => parseInt(v, 10), 100)
    .option("--json", "Emit machine-readable JSON")
    .action((
      testName: string,
      runId: string | undefined,
      opts: { limit: number; json?: boolean },
    ) => {
      const store = openStore();
      try {
        const t = getTestByName(store, testName);
        if (!t) throw new Error(`test not found: ${testName}`);
        let runs;
        if (runId) {
          const r = getRun(store, runId);
          if (!r) throw new Error(`run not found: ${runId}`);
          runs = [r];
        } else {
          runs = listRuns(store, { limit: opts.limit });
        }
        const results = runs.map((r) => runTest(store, t, r.run_id));
        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        let pass = 0;
        let fail = 0;
        for (const r of results) {
          const tag = r.passed ? pc.green("PASS") : pc.red("FAIL");
          console.log(
            `${tag}  ${r.run_id.slice(0, 12)}  ${pc.dim(`${r.assertions.filter((a) => a.passed).length}/${r.assertions.length} assertions`)}`,
          );
          if (!r.passed) {
            for (const a of r.assertions.filter((x) => !x.passed)) {
              console.log(
                `      ${pc.red("✖")} ${pc.dim(a.assertion.kind)} ${a.reason}`,
              );
            }
          }
          if (r.passed) pass += 1;
          else fail += 1;
        }
        console.log(
          pc.bold(
            `\n${results.length} run(s) checked · ${pc.green(`${pass} pass`)} · ${pc.red(`${fail} fail`)}`,
          ),
        );
        if (fail > 0) process.exit(1);
      } finally {
        store.close();
      }
    });

  test
    .command("show <name>")
    .description("Show a test's assertions")
    .action((name: string) => {
      const store = openStore();
      try {
        const t = getTestByName(store, name);
        if (!t) throw new Error(`test not found: ${name}`);
        console.log(pc.bold(t.name));
        if (t.description) console.log(`  ${pc.dim(t.description)}`);
        if (t.canonical_run_id)
          console.log(`  ${pc.dim("canonical run:")} ${t.canonical_run_id}`);
        console.log(`  ${pc.dim("created:")} ${t.created_at}`);
        for (const a of t.assertions) {
          console.log(
            `  · ${pc.cyan(a.kind)} ${pc.bold(String(a.value))}${a.at !== undefined ? pc.dim(`  at=${a.at}`) : ""}${a.label ? pc.dim(`  (${a.label})`) : ""}`,
          );
        }
      } finally {
        store.close();
      }
    });

  test
    .command("results [test-name]")
    .description("Show recent regression results")
    .option("-n, --limit <n>", "max rows", (v) => parseInt(v, 10), 25)
    .action((name: string | undefined, opts: { limit: number }) => {
      const store = openStore();
      try {
        const testId = name ? getTestByName(store, name)?.test_id : undefined;
        if (name && !testId) throw new Error(`test not found: ${name}`);
        const results = listResults(store, testId, opts.limit);
        if (results.length === 0) {
          console.log(pc.dim("no results yet"));
          return;
        }
        for (const r of results) {
          console.log(
            `  ${r.passed ? pc.green("PASS") : pc.red("FAIL")}  ${pc.dim(r.created_at)}  ${pc.cyan(r.test_name.padEnd(20))}  ${r.run_id.slice(0, 12)}`,
          );
        }
      } finally {
        store.close();
      }
    });

  test
    .command("export <name>")
    .description("Export a test as a JSON file (round-trip via --from-file)")
    .option("-o, --output <path>", "Output file (default: stdout)")
    .action(async (name: string, opts: { output?: string }) => {
      const store = openStore();
      try {
        const t = getTestByName(store, name);
        if (!t) throw new Error(`test not found: ${name}`);
        const json = JSON.stringify(t.assertions, null, 2);
        if (opts.output) {
          await writeFile(opts.output, json);
          console.log(`${pc.green("exported")}  ${name} → ${opts.output}`);
        } else {
          process.stdout.write(json + "\n");
        }
      } finally {
        store.close();
      }
    });
}
