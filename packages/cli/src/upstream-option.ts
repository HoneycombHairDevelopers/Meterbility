import pc from "picocolors";
import { parseUpstreamFlag, type ProviderInput } from "@meterbility/proxy";

/**
 * Shared commander collector for the repeatable `--upstream` flag
 * (`meter proxy` and `meter run`). Grammar + validation live in
 * @meterbility/proxy's parseUpstreamFlag so the CLI stays a thin
 * passthrough and library callers get identical errors; this wrapper
 * only turns a parse failure into a hard, user-facing exit.
 */
export function makeUpstreamCollector(
  commandName: string,
): (value: string, acc: ProviderInput[]) => ProviderInput[] {
  return (value, acc) => {
    try {
      return [...acc, parseUpstreamFlag(value)];
    } catch (err) {
      console.error(pc.red(`${commandName}: ${(err as Error).message}`));
      process.exit(2);
    }
  };
}
