import { test } from "node:test";
import assert from "node:assert/strict";
import { redactString } from "./redact.ts";

test("redacts anthropic keys", () => {
  const r = redactString("token=sk-ant-api03-abcdefghijklmnop12345 done");
  assert.match(r.text, /«meter:redacted:anthropic-key»/);
  assert.equal(r.redactions[0]?.rule, "anthropic-key");
});

test("leaves non-secret text untouched", () => {
  const r = redactString("hello world, no secrets here");
  assert.equal(r.text, "hello world, no secrets here");
  assert.equal(r.redactions.length, 0);
});

test("respects METERBILITY_REDACT=off", () => {
  process.env.METERBILITY_REDACT = "off";
  try {
    const raw = "sk-ant-api03-abcdefghijklmnop12345";
    const r = redactString(raw);
    assert.equal(r.text, raw);
  } finally {
    delete process.env.METERBILITY_REDACT;
  }
});
