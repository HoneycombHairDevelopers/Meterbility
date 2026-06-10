import { Store, listRuns, listSteps } from "@spool-ai/collector";
import { ingestSession } from "@spool-ai/claude-code-adapter";

const path = process.argv[2];
if (!path) {
  console.error("usage: smoke-ingest.ts <jsonl-path>");
  process.exit(1);
}

const store = Store.open();
const t0 = Date.now();
const r = await ingestSession(store, path);
const t1 = Date.now();
console.log("ingest result:", r);
console.log("time:", t1 - t0, "ms");

const runs = listRuns(store);
console.log(
  "runs:",
  runs.length,
  JSON.stringify({
    title: runs[0]?.title,
    status: runs[0]?.status,
    step_count: runs[0]?.step_count,
    cost_cents: runs[0]?.cost_cents,
    tokens_in: runs[0]?.tokens_total_input,
    tokens_out: runs[0]?.tokens_total_output,
    tokens_cached: runs[0]?.tokens_total_cached,
  }),
);

if (runs[0]) {
  const steps = listSteps(store, runs[0].run_id);
  console.log(`steps: ${steps.length} total, first 8:`);
  for (const s of steps.slice(0, 8)) {
    console.log(
      `  #${s.sequence} ${s.action.kind} ${s.action.tool_name ?? ""}`,
      `tokens=${s.tokens.input}/${s.tokens.output}`,
      `cost=$${(s.cost_cents / 100).toFixed(4)}`,
      `status=${s.status}`,
    );
  }
}
store.close();
