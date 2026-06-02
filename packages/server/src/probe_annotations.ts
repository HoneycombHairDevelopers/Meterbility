import type { AnnotationKind } from "@spool/shared";
import { insertAnnotation, type Store } from "@spool/collector";

/**
 * Probe-intervention annotation emission. Single helper called by
 * every probe HTTP route handler that mutates state — the pause
 * handler emits `probe_pause`, the resume handler emits one
 * `probe_edit` per staged inject.
 *
 * Per SPEC-V0_3 §4.4: the annotation timeline must reflect human
 * interventions on a run so post-hoc review surfaces "operator paused
 * here / injected that" alongside the model's natural trace. v0.3
 * doesn't emit on `inject` (staging) or `clear` (cleanup); only on
 * the moments that change observable behaviour.
 *
 * Failure-mode contract (per eng-plan T8): if the SQLite insert fails
 * AFTER the FSM mutation succeeded, the FSM state is the source of
 * truth — we log + increment the counter and continue. Rolling back
 * the FSM mutation on annotation failure would be worse: the pause
 * is already persisted in `~/.spool/probe/<id>.json`, the SDK is
 * already blocked, and unwinding would leave the on-disk state and
 * in-memory state divergent. Annotation loss is recoverable; probe
 * desync is not.
 */
let probeAnnotationFailedCount = 0;

export function probeAnnotationFailures(): number {
  return probeAnnotationFailedCount;
}

/** Test-only — resets the failure counter between cases. */
export function resetProbeAnnotationFailures(): void {
  probeAnnotationFailedCount = 0;
}

export function recordProbeIntervention(
  store: Store,
  runId: string,
  kind: Extract<AnnotationKind, "probe_pause" | "probe_edit">,
  payload: Record<string, unknown>,
): void {
  // Both kinds attach at run level. Per T1 design decision:
  // `probe_pause` always attaches to the run because no new step has
  // started yet. `probe_edit` also attaches to the run at resume time
  // because the next step id isn't known until the SDK polls — UI
  // consumers walk run-level annotations and surface them on the
  // next step's card when one exists.
  try {
    insertAnnotation(store, {
      targetKind: "run",
      targetId: runId,
      author: "system:probe",
      kind,
      note: buildProbeNote(kind, payload),
    });
  } catch (err) {
    // Don't let an annotation failure unwind a successful FSM mutation.
    // Surface via the counter that `spool doctor` can read.
    probeAnnotationFailedCount += 1;
    // eslint-disable-next-line no-console
    console.error(
      `[probe_annotation] failed to record ${kind} for ${runId}: ${
        (err as Error).message
      } (total failures: ${probeAnnotationFailedCount})`,
    );
  }
}

/**
 * Render a one-line `note` field summarising what changed. Keeps the
 * payload byte size in the note rather than the raw inject text so
 * secrets in injects don't leak into the annotation row.
 */
function buildProbeNote(
  kind: "probe_pause" | "probe_edit",
  payload: Record<string, unknown>,
): string {
  if (kind === "probe_pause") {
    const ts = String(payload.paused_at ?? new Date().toISOString());
    return `paused at ${ts}`;
  }
  // probe_edit
  const bytes = Number(payload.inject_bytes ?? 0);
  const ts = String(payload.resumed_at ?? new Date().toISOString());
  return `inject staged (${bytes} bytes) — resumed at ${ts}`;
}
