import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantMessage,
  createRuntimeHarness,
  emitQueuedTurnThroughContext,
  queuedCustomMessage,
} from "./support/runtime-harness.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

test("older multi-goal stale abort with active overlap keeps replacement active through both agent_end terminals", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("goal A");
    const queuedA = harness.sentMessages[0];
    assert.ok(queuedA);
    const messageA = queuedCustomMessage(queuedA, 1);
    const goalAId = harness.snapshot().goal?.goalId;
    assert.ok(goalAId);

    await harness.runCommand("goal B");
    const queuedB = harness.sentMessages.at(-1);
    assert.ok(queuedB);
    const messageB = queuedCustomMessage(queuedB, 2);
    const goalBId = harness.snapshot().goal?.goalId;
    assert.ok(goalBId);

    await harness.runCommand("goal C");
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "goal C");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [messageA, messageB], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [messageB], 1);
    assert.equal(harness.abortCount, 2);

    now = 4_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: CUSTOM_ENTRY_TYPE,
          details: { kind: "continuation", goalId: goalAId },
        },
        {
          role: "custom",
          customType: CUSTOM_ENTRY_TYPE,
          details: { kind: "continuation", goalId: goalBId },
        },
        assistantMessage("aborted", { input: 20, output: 5 }),
      ],
    });
    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    now = 5_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: CUSTOM_ENTRY_TYPE,
          details: { kind: "continuation", goalId: goalBId },
        },
        assistantMessage("aborted", { input: 12, output: 3 }),
      ],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    Date.now = originalNow;
  }
});
