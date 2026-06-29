// Worker for the BlobStore concurrent stress test in
// blobs.exhaustive.test.ts (Section 7). Each worker opens its own Store
// pointed at the SAME METERBILITY_HOME and calls putBuffer with shared bytes
// in a tight loop. The parent verifies every worker returns the same
// content-addressed hash and that exactly one file ends up on disk.
//
// Written as .mjs (not .ts) for the same reason as probe-stress-worker:
// node loads the worker entry via plain ESM resolution before any tsx
// hook can fire. The .mjs registers tsx itself, then dynamic-imports
// the .ts sources.

import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();

process.env.METERBILITY_HOME = workerData.home;

const { Store } = await import("./store.ts");

const store = Store.open({ path: `${workerData.home}/meterbility.db` });
try {
  const buf = Buffer.from(workerData.payload, "utf-8");
  let lastHash = "";
  for (let i = 0; i < workerData.iterations; i++) {
    lastHash = await store.blobs.putBuffer(buf);
  }
  parentPort.postMessage({ id: workerData.id, hash: lastHash });
} finally {
  store.close();
}
