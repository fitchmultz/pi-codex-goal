import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeHarness } from "./support/runtime-harness.ts";

test("runtime harness rejects background work instead of simulating host delivery", () => {
  const harness = createRuntimeHarness();
  const { context } = harness;
  // Official hosts need not expose this fork capability; the fixture remains explicit on both.
  assert.ok("runInBackground" in context);
  const runInBackground = context.runInBackground;
  assert.ok(typeof runInBackground === "function");
  let workStarted = false;

  assert.throws(() => runInBackground("test_background", async () => {
    workStarted = true;
    return { content: [], details: {} };
  }), { message: "ctx.runInBackground is not implemented in this test harness." });

  assert.equal(workStarted, false);
  assert.deepEqual(harness.entries, []);
  assert.deepEqual(harness.sentMessages, []);
  assert.deepEqual(harness.sentUserMessages, []);
});
