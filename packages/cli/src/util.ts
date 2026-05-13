import pc from "picocolors";
import { Store } from "@spool/collector";
import type { Run, Step } from "@spool/shared";

export function openStore(): Store {
  return Store.open();
}

/**
 * Format a cost (stored in cents) as dollars. 2 decimals for anything
 * ≥ half a cent, 4 decimals for sub-cent costs so they don't collapse
 * to "$0.00". Matches the web UI's formatter so terminal and browser
 * never mix units.
 */
export function fmtCents(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (Math.abs(dollars) >= 0.005) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "ok":
      return pc.green;
    case "error":
      return pc.red;
    case "in_progress":
      return pc.yellow;
    case "abandoned":
      return pc.gray;
    default:
      return (s) => s;
  }
}

export function actionLabel(step: Step): string {
  switch (step.action.kind) {
    case "tool_call":
      return `${step.action.tool_name ?? "tool"}`;
    case "message":
      return "message";
    case "thinking_only":
      return "thinking";
    case "sub_agent_dispatch":
      return `sub_agent(${step.action.sub_agent ?? "?"})`;
    case "none":
      return "—";
  }
}

export function shortId(id: string, len = 12): string {
  return id.length > len ? id.slice(0, len) : id;
}

export function runSummaryLine(r: Run): string {
  const status = statusColor(r.status)(r.status.padEnd(11));
  const cost = fmtCents(r.cost_cents).padStart(8);
  return `${pc.dim(shortId(r.run_id))}  ${status}  ${String(r.step_count).padStart(4)} steps  ${cost}  ${pc.cyan(
    shortId(r.git_branch ?? "", 16).padEnd(16),
  )}  ${r.title ?? ""}`;
}

export function bar(value: number, max: number, width = 20): string {
  if (max === 0) return " ".repeat(width);
  const fill = Math.round((value / max) * width);
  return pc.blue("█".repeat(fill)) + pc.dim("·".repeat(width - fill));
}
