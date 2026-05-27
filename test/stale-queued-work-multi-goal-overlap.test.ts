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

test("back-to-back stale aborts unblock continuation when active id-less agent_end follows active turn_end without older terminal", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("goal A");
    const queuedA = harness.sentMessages[0];
    assert.ok(queuedA);
    const messageA = queuedCustomMessage(queuedA, 1);

    await harness.runCommand("goal B");
    const queuedB = harness.sentMessages.at(-1);
    assert.ok(queuedB);
    const messageB = queuedCustomMessage(queuedB, 2);

    await harness.runCommand("goal C");
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "goal C");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [messageA], 0);
    assert.equal(harness.abortCount, 1);

    await emitQueuedTurnThroughContext(harness, [messageB], 1);
    assert.equal(harness.abortCount, 2);

    now = 4_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    now = 5_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("error", { input: 12, output: 3 })],
    });
    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    harness.sentMessages.length = 0;
    await harness.emit("session_tree", { type: "session_tree" });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("same-goal stale abort unblocks continuation when active agent_end arrives after active turn_end without older terminal", async () => {
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
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "goal B");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [messageA], 0);
    assert.equal(harness.abortCount, 1);

    await emitQueuedTurnThroughContext(harness, [messageA, messageA], 1);
    assert.equal(harness.abortCount, 2);

    const staleGoalContinuation = {
      role: "custom" as const,
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation" as const, goalId: goalAId },
    };

    now = 4_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    now = 5_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [
        staleGoalContinuation,
        { ...staleGoalContinuation },
        assistantMessage("aborted", { input: 12, output: 3 }),
      ],
    });
    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    harness.sentMessages.length = 0;
    await harness.emit("session_tree", { type: "session_tree" });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });

    now = 6_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [staleGoalContinuation, assistantMessage("aborted", { input: 8, output: 2 })],
    });
    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    Date.now = originalNow;
  }
});
