# Custom-agent SDK (`@meterbility/agent`)

Instrument any TypeScript agent so its runs land in Meterbility alongside Claude Code and Codex captures. Two flavors:

1. **Imperative tracer** — full control. Best when you want to capture exactly what happened at each decision point.
2. **`traceAnthropic` wrapper** — drop-in around the Anthropic SDK. Each `messages.create` becomes one Step.

## Imperative tracer

```ts
import { MeterbilityTracer, helpers } from "@meterbility/agent";

const tracer = new MeterbilityTracer({
  project: "/abs/path/to/repo",       // becomes the Project
  agent: "support-bot",                // becomes the Agent within that Project
  runTitle: "ticket-#42",              // shows in `meter list`
  cwd: process.cwd(),                  // optional
  gitBranch: "main",                   // optional
  tags: ["env:prod"],                  // optional
});

const step = tracer.startStep({
  model: "claude-opus-4-7",
  systemPrompt: "you are helpful",
  toolDefinitions: [{ name: "Read", input_schema: { /* ... */ } }],
  history: [{ role: "user", content: "fetch /etc/hosts" }],
  tags: ["entry"],
});

// Run your model, run your tool, then…

step.recordToolCall("Read", { path: "/etc/hosts" }, "tu1");
step.recordToolResult(filesContents, { isError: false });
step.recordTokens({
  tokens: { input: 120, output: 35, cached_read: 800, cache_creation: 0 },
  latency_ms: 412,
});
await step.end();

await tracer.end(); // status inferred from the last step's outcome
```

### What gets persisted

- A `Run` row for the tracer.
- One `Step` per `startStep` / `end` pair.
- A `ContextSnapshot` blob containing the system prompt, tools, history, and any extra components you supplied. SHA-deduped — repeated steps with identical context cost ~0 storage beyond the first.
- The decision blob (whatever you passed to `recordDecision`).
- The tool result blob (if you called `recordToolResult`).

## `traceAnthropic`

If you're already calling the Anthropic SDK and just want trace capture for free:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { MeterbilityTracer, traceAnthropic } from "@meterbility/agent";

const client = new Anthropic();
const tracer = new MeterbilityTracer({ project: "/repo", agent: "ops" });
const create = traceAnthropic(tracer, (req) => client.messages.create(req));

const resp = await create({
  model: "claude-opus-4-7",
  max_tokens: 4096,
  system: "be concise",
  messages: [{ role: "user", content: "what time is it?" }],
});

// `resp` is the SDK response, untouched. One Step captured.
await tracer.end();
```

Errors thrown by the SDK are caught and recorded as an error-status step before being re-thrown.

## Where data lands

By default, `~/.meterbility/meterbility.db` and `~/.meterbility/blobs/` (override with `METERBILITY_HOME`). The same store the CLI reads — `meter list` will show your SDK runs immediately.

## Multi-step agents

Each `tracer.startStep` is one model invocation. For an agent loop that calls the model repeatedly:

```ts
for (let turn = 0; turn < 10; turn++) {
  const step = tracer.startStep({ model, history: buildHistory() });
  const resp = await callModel(...);
  step.recordDecision({ decision: resp.content, action: extractAction(resp) });
  step.recordTokens({ tokens: extractTokens(resp) });
  if (toolWasCalled(resp)) {
    const result = await runTool(...);
    step.recordToolResult(result, { isError: result.failed });
  } else {
    step.recordOutcome({ outcome: { status: "ok" } });
  }
  await step.end();
  if (isDone(resp)) break;
}
await tracer.end();
```

## Caveats

- The tracer instance owns one Run. Don't share across concurrent agent invocations — open one tracer per run.
- `step.end()` writes to disk; call it before exiting the process or the step will not persist.
- Context-snapshot dedup happens at the blob layer. For maximum dedup, pass identical history bytes (canonicalize before passing in).
