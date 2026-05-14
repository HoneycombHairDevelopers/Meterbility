import { Command } from "commander";
import pc from "picocolors";
import {
  getRun,
  getStep,
  getStepBySequence,
  listAnnotations,
  listForks,
  listSteps,
  resolveSnapshotBlobRef,
} from "@spool/collector";
import type { ContextSnapshot, ConversationMessage, RetrievedDocument, Step } from "@spool/shared";
import {
  actionLabel,
  fmtCents,
  fmtTokens,
  openStore,
  statusColor,
} from "../util.ts";

export function registerInspectCommand(program: Command): void {
  program
    .command("inspect <run-id>")
    .description("Terminal-rendered timeline + step inspector")
    .option("--at <seq-or-step-id>", "Open a specific step")
    .option(
      "--show <tab>",
      "Tab to print (context|decision|action|outcome|cost|all)",
      "all",
    )
    .action(async (
      runId: string,
      opts: { at?: string; show: string },
    ) => {
      const store = openStore();
      try {
        const run = getRun(store, runId);
        if (!run) throw new Error(`run not found: ${runId}`);
        printRunHeader(run);
        const steps = listSteps(store, run.run_id);
        printTimeline(steps);

        const annotations = listAnnotations(store, "run", run.run_id);
        if (annotations.length) {
          console.log(pc.bold("\nRun annotations"));
          for (const a of annotations) {
            console.log(
              `  ${pc.cyan(a.author)}  ${pc.dim(a.verdict ?? "note")}  ${a.note ?? ""}`,
            );
          }
        }

        const forks = listForks(store, run.run_id);
        if (forks.length) {
          console.log(pc.bold("\nForks of this run"));
          for (const f of forks) {
            console.log(
              `  ${pc.magenta(f.edit_type)}  from step ${pc.dim(f.origin_step_id.slice(0, 12))}  →  ${pc.cyan(f.fork_run_id.slice(0, 12))}`,
            );
          }
        }

        if (opts.at !== undefined) {
          const seq = Number(opts.at);
          const step = Number.isFinite(seq)
            ? getStepBySequence(store, run.run_id, seq)
            : getStep(store, opts.at);
          if (!step) throw new Error(`step not found: ${opts.at}`);
          await printStep(store, step, opts.show);
        } else {
          console.log("");
          for (const s of steps) await printStepSummary(s);
          console.log(
            pc.dim(
              `\nopen one with:  spool inspect ${run.run_id.slice(0, 12)} --at 0`,
            ),
          );
        }
      } finally {
        store.close();
      }
    });
}

function printRunHeader(run: ReturnType<typeof getRun>): void {
  if (!run) return;
  const status = statusColor(run.status)(run.status);
  console.log(pc.bold(run.title ?? run.run_id));
  console.log(
    `  ${pc.dim("run")}    ${run.run_id}\n` +
      `  ${pc.dim("status")} ${status}\n` +
      `  ${pc.dim("branch")} ${run.git_branch ?? "—"}\n` +
      `  ${pc.dim("cwd")}    ${run.cwd ?? "—"}\n` +
      `  ${pc.dim("steps")}  ${run.step_count}\n` +
      `  ${pc.dim("cost")}   ${fmtCents(run.cost_cents)}  ${pc.dim(`(input ${fmtTokens(run.tokens_total_input)} · output ${fmtTokens(run.tokens_total_output)} · cached ${fmtTokens(run.tokens_total_cached)})`)}\n` +
      `  ${pc.dim("started")} ${run.started_at}`,
  );
}

function printTimeline(steps: Step[]): void {
  if (steps.length === 0) return;
  console.log(pc.bold("\nTimeline"));
  const cells: string[] = [];
  for (const s of steps) {
    const color =
      s.status === "error"
        ? pc.red
        : s.status === "ok"
          ? pc.green
          : s.status === "in_progress"
            ? pc.yellow
            : pc.dim;
    const label = `${s.sequence}.${actionLabel(s).slice(0, 6)}`;
    cells.push(color(label));
  }
  // wrap at ~120 chars
  let line = "  ";
  for (const cell of cells) {
    if (line.length + cell.length > 130) {
      console.log(line);
      line = "  ";
    }
    line += cell + " ";
  }
  if (line.trim().length) console.log(line);
}

async function printStepSummary(s: Step): Promise<void> {
  const color = statusColor(s.status);
  console.log(
    `  ${pc.dim(String(s.sequence).padStart(3))}  ${color(s.status.padEnd(11))}  ${actionLabel(s).padEnd(18)}  ${pc.dim("tok " + fmtTokens(s.tokens.input) + "/" + fmtTokens(s.tokens.output))}  ${pc.dim(fmtCents(s.cost_cents).padStart(7))}  ${pc.dim(s.step_id.slice(0, 12))}`,
  );
}

async function printStep(
  store: import("@spool/collector").Store,
  step: Step,
  show: string,
): Promise<void> {
  console.log(pc.bold(`\nStep #${step.sequence}  ${pc.dim(step.step_id)}`));
  console.log(`  ${pc.dim("model")} ${step.model}`);
  console.log(`  ${pc.dim("status")} ${statusColor(step.status)(step.status)}`);
  console.log(`  ${pc.dim("action")} ${actionLabel(step)}`);

  const showAll = show === "all";
  if (showAll || show === "action") {
    console.log(pc.bold("\n  action"));
    console.log(indent(JSON.stringify(step.action, null, 2)));
  }
  if (showAll || show === "outcome") {
    console.log(pc.bold("\n  outcome"));
    console.log(indent(JSON.stringify(step.outcome, null, 2)));
    if (step.outcome.tool_result_ref) {
      const text = await store.blobs.tryGetString(step.outcome.tool_result_ref);
      if (text) {
        console.log(pc.bold("\n  tool result (truncated)"));
        console.log(indent(truncate(prettyJson(text), 2000)));
      }
    }
  }
  if (showAll || show === "decision") {
    const text = await store.blobs.tryGetString(step.decision_ref);
    if (text) {
      console.log(pc.bold("\n  decision"));
      console.log(indent(truncate(prettyJson(text), 4000)));
    }
  }
  if (showAll || show === "context") {
    await printResolvedContext(store, step);
  }
  if (showAll || show === "cost") {
    console.log(pc.bold("\n  cost"));
    console.log(
      indent(
        JSON.stringify(
          {
            tokens: step.tokens,
            latency_ms: step.latency_ms,
            cost_cents: step.cost_cents,
            tags: step.tags,
          },
          null,
          2,
        ),
      ),
    );
  }
}

async function printResolvedContext(
  store: import("@spool/collector").Store,
  step: Step,
): Promise<void> {
  const ref = resolveSnapshotBlobRef(store, step.context_snapshot_id);
  const raw = await store.blobs.tryGetString(ref);
  if (!raw) {
    console.log(pc.bold("\n  context"));
    console.log(indent(pc.dim("(no snapshot blob found)")));
    return;
  }
  let snapshot: ContextSnapshot;
  try {
    snapshot = JSON.parse(raw) as ContextSnapshot;
  } catch {
    console.log(pc.bold("\n  context (raw)"));
    console.log(indent(truncate(raw, 4000)));
    return;
  }

  // First pass: resolve every content_ref so we can compute totals.
  let totalChars = 0;
  const fetchText = async (r: string): Promise<string> => {
    const text = (await store.blobs.tryGetString(r)) ?? "(missing blob)";
    totalChars += text.length;
    return text;
  };

  type Resolved =
    | { type: "system_prompt"; ref: string; text: string }
    | { type: "tool_definitions"; ref: string; text: string }
    | {
        type: "conversation_history";
        messages: Array<{
          role: "user" | "assistant" | "tool";
          ref: string;
          text: string;
          step_ref?: string;
        }>;
      }
    | {
        type: "retrieved_documents";
        docs: Array<{ source: string; ref: string; text: string }>;
      }
    | {
        type: "compaction_summary";
        ref: string;
        text: string;
        replaces_steps: string[];
      };

  const resolved: Resolved[] = [];
  for (const c of snapshot.components) {
    if (c.type === "system_prompt") {
      resolved.push({
        type: "system_prompt",
        ref: c.content_ref,
        text: await fetchText(c.content_ref),
      });
    } else if (c.type === "tool_definitions") {
      resolved.push({
        type: "tool_definitions",
        ref: c.content_ref,
        text: await fetchText(c.content_ref),
      });
    } else if (c.type === "conversation_history") {
      const messages: Array<{
        role: "user" | "assistant" | "tool";
        ref: string;
        text: string;
        step_ref?: string;
      }> = [];
      for (const m of (c.messages as ConversationMessage[]) ?? []) {
        messages.push({
          role: m.role,
          ref: m.content_ref,
          text: await fetchText(m.content_ref),
          step_ref: m.step_ref,
        });
      }
      resolved.push({ type: "conversation_history", messages });
    } else if (c.type === "retrieved_documents") {
      const docs: Array<{ source: string; ref: string; text: string }> = [];
      for (const d of (c.docs as RetrievedDocument[]) ?? []) {
        docs.push({
          source: d.source,
          ref: d.content_ref,
          text: await fetchText(d.content_ref),
        });
      }
      resolved.push({ type: "retrieved_documents", docs });
    } else if (c.type === "compaction_summary") {
      resolved.push({
        type: "compaction_summary",
        ref: c.content_ref,
        text: await fetchText(c.content_ref),
        replaces_steps: c.replaces_steps,
      });
    }
  }

  console.log(
    pc.bold(
      `\n  context (snapshot · ${resolved.length} component${resolved.length === 1 ? "" : "s"} · ${totalChars.toLocaleString()} chars)`,
    ),
  );

  for (const c of resolved) {
    if (c.type === "system_prompt") {
      console.log(
        pc.bold(`\n  system_prompt`) +
          pc.dim(` · ${c.text.length.toLocaleString()} chars · ${c.ref.slice(0, 12)}`),
      );
      console.log(indent(truncate(c.text, 2000)));
    } else if (c.type === "tool_definitions") {
      console.log(
        pc.bold(`\n  tool_definitions`) +
          pc.dim(` · ${c.text.length.toLocaleString()} chars · ${c.ref.slice(0, 12)}`),
      );
      console.log(indent(truncate(prettyJson(c.text), 2000)));
    } else if (c.type === "conversation_history") {
      console.log(
        pc.bold(`\n  conversation_history`) +
          pc.dim(
            ` · ${c.messages.length} turn${c.messages.length === 1 ? "" : "s"}`,
          ),
      );
      for (const m of c.messages) {
        const roleColor =
          m.role === "user"
            ? pc.cyan
            : m.role === "assistant"
              ? pc.green
              : pc.yellow;
        const tag = roleColor(`[${m.role.toUpperCase()}]`);
        const meta = pc.dim(
          ` · ${m.text.length.toLocaleString()} chars · ${m.ref.slice(0, 12)}${m.step_ref ? ` · step ${m.step_ref.slice(0, 12)}` : ""}`,
        );
        console.log(`    ${tag}${meta}`);
        console.log(indent(truncate(m.text, 1200), "      "));
      }
    } else if (c.type === "retrieved_documents") {
      console.log(
        pc.bold(`\n  retrieved_documents`) +
          pc.dim(` · ${c.docs.length} doc${c.docs.length === 1 ? "" : "s"}`),
      );
      for (const d of c.docs) {
        console.log(
          `    ${pc.magenta(d.source)}${pc.dim(` · ${d.text.length.toLocaleString()} chars · ${d.ref.slice(0, 12)}`)}`,
        );
        console.log(indent(truncate(d.text, 1000), "      "));
      }
    } else if (c.type === "compaction_summary") {
      console.log(
        pc.bold(`\n  compaction_summary`) +
          pc.dim(
            ` · replaces ${c.replaces_steps.length} step${c.replaces_steps.length === 1 ? "" : "s"} · ${c.ref.slice(0, 12)}`,
          ),
      );
      console.log(indent(truncate(c.text, 2000)));
      if (c.replaces_steps.length) {
        console.log(
          indent(
            pc.dim(
              "replaced: " +
                c.replaces_steps.map((s) => s.slice(0, 12)).join(", "),
            ),
          ),
        );
      }
    }
  }
}

function indent(s: string, prefix = "    "): string {
  return s
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + pc.dim(`\n… (${s.length - max} more chars)`) : s;
}

function prettyJson(maybe: string): string {
  try {
    return JSON.stringify(JSON.parse(maybe), null, 2);
  } catch {
    return maybe;
  }
}
