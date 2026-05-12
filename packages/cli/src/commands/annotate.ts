import { Command } from "commander";
import pc from "picocolors";
import { getRun, getStep, insertAnnotation } from "@spool/collector";
import type { AnnotationVerdict } from "@spool/shared";
import { openStore } from "../util.ts";

const VERDICTS: AnnotationVerdict[] = [
  "correct",
  "incorrect",
  "unclear",
  "good_decision",
  "bad_decision",
];

export function registerAnnotateCommand(program: Command): void {
  program
    .command("annotate <target>")
    .description("Attach a verdict + note to a step or run")
    .option("--verdict <v>", `One of: ${VERDICTS.join(", ")}`)
    .option("--note <text>", "Free-form note")
    .option("--author <name>", "Author name", process.env.USER ?? "anonymous")
    .action(async (
      target: string,
      opts: { verdict?: string; note?: string; author: string },
    ) => {
      const store = openStore();
      try {
        // Resolve user-supplied prefix ids to their full canonical form
        // before persisting. Otherwise an annotation made with the short
        // form gets stored under the prefix and is invisible to any
        // subsequent read that uses the full id (which is what every
        // other surface uses).
        let kind: "step" | "run";
        let resolvedId: string;
        if (target.startsWith("stp_")) {
          const step = getStep(store, target);
          if (!step) throw new Error(`step not found: ${target}`);
          kind = "step";
          resolvedId = step.step_id;
        } else if (target.startsWith("run_")) {
          const run = getRun(store, target);
          if (!run) throw new Error(`run not found: ${target}`);
          kind = "run";
          resolvedId = run.run_id;
        } else {
          throw new Error(
            "target must be a step id (stp_…) or run id (run_…)",
          );
        }
        if (opts.verdict && !VERDICTS.includes(opts.verdict as AnnotationVerdict)) {
          throw new Error(
            `invalid verdict: ${opts.verdict}\nallowed: ${VERDICTS.join(", ")}`,
          );
        }
        const ann = insertAnnotation(store, {
          targetKind: kind,
          targetId: resolvedId,
          author: opts.author,
          verdict: opts.verdict as AnnotationVerdict | undefined,
          note: opts.note,
        });
        console.log(
          `${pc.green("annotated")}  ${kind}=${target.slice(0, 12)}  ${pc.dim(ann.annotation_id)}`,
        );
      } finally {
        store.close();
      }
    });
}
