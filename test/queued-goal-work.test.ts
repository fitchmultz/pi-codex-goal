import assert from "node:assert/strict";
import { test } from "node:test";

import { toQueuedGoalContextCarrier, toQueuedGoalWorkSource } from "../src/queued-goal-messages.ts";

test("toQueuedGoalWorkSource ignores unrelated custom messages", () => {
  const unrelated = toQueuedGoalContextCarrier({
    role: "custom",
    customType: "other-extension",
    content: "ignored",
    timestamp: 1,
  });
  assert.ok(unrelated);
  assert.equal(toQueuedGoalWorkSource(unrelated), null);
});
