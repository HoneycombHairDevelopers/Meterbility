// Worker for the atomicity stress test in probe.exhaustive.test.ts
// (Section 9, test #53b). Written as .mjs so the worker_threads
// loader can pick it up without a TypeScript loader being already
// active in the worker — we register tsx ourselves below, then
// dynamic-import probe.ts. .ts can't be the worker entry because
// node loads the worker via plain ESM resolution before any custom
// hooks fire.

import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register(); // hook .ts resolution for the subsequent dynamic import

process.env.METERBILITY_HOME = workerData.home;

const { setInject } = await import("./probe.ts");

const { id, iterations, runId } = workerData;
for (let i = 0; i < iterations; i++) {
  setInject(runId, `worker-${id}-iter-${i}`);
}

parentPort.postMessage({
  id,
  lastInject: `worker-${id}-iter-${iterations - 1}`,
});
