import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DETERMINISTIC_STEP_ID_RE,
  deterministicStepId,
  hashJson,
} from "./hash.ts";

test("deterministicStepId matches the legacy inline format byte-for-byte", () => {
  // Existing databases store ids minted as
  //   `stp_${hashJson([runId, key]).slice(0, 32)}`
  // (previously duplicated inline in the cursor and claude-code
  // adapters). The helper must reproduce that exact format forever.
  const cases: Array<[string, string]> = [
    ["run_abc123", "bubble-42"],
    ["run_abc123", "req_00f3"],
    ["run_other", "bubble-42"],
    ["", ""],
  ];
  for (const [runId, key] of cases) {
    const expected = `stp_${hashJson([runId, key]).slice(0, 32)}`;
    assert.equal(deterministicStepId(runId, key), expected);
  }
});

test("deterministicStepId is stable and input-sensitive", () => {
  assert.equal(
    deterministicStepId("run_a", "key_1"),
    deterministicStepId("run_a", "key_1"),
  );
  assert.notEqual(
    deterministicStepId("run_a", "key_1"),
    deterministicStepId("run_a", "key_2"),
  );
  assert.notEqual(
    deterministicStepId("run_a", "key_1"),
    deterministicStepId("run_b", "key_1"),
  );
});

test("DETERMINISTIC_STEP_ID_RE matches minted ids, not legacy UUID ids", () => {
  assert.match(deterministicStepId("run_a", "key_1"), DETERMINISTIC_STEP_ID_RE);
  // Legacy ids were `stp_${randomUUID()}` — hyphenated, so they never
  // match the deterministic format.
  assert.doesNotMatch(
    "stp_6c9d0f3a-2b1e-4d5f-8a7b-9c0d1e2f3a4b",
    DETERMINISTIC_STEP_ID_RE,
  );
});
