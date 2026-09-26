import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantMessage,
  createRuntimeHarness,
  emitProviderContext,
  emitQueuedTurnThroughContext,
  goalUserContextMessage,
  providerContextMessageAt,
  queuedCustomMessage,
  requireProviderContextResult,
  sessionShutdownEvent,
} from "./support/runtime-harness.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

test("late stale turn_end after the next current follow-up starts is ignored", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);

    now = 4_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("late stale turn_end with stop before next current context event is ignored", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 4 });
    await harness.emit("message_start", { type: "message_start", message: currentMessage });
    await harness.emit("message_end", { type: "message_end", message: currentMessage });

    now = 4_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    await emitProviderContext(harness, [currentMessage]);

    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("late stale turn_end before next current context event is ignored", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 4 });
    await harness.emit("message_start", { type: "message_start", message: currentMessage });
    await harness.emit("message_end", { type: "message_end", message: currentMessage });

    now = 4_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    await emitProviderContext(harness, [currentMessage]);

    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("late stale agent_end with stop before next current context event is ignored", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);
    const oldGoalId = harness.snapshot().goal?.goalId;
    assert.ok(oldGoalId);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 4 });
    await harness.emit("message_start", { type: "message_start", message: currentMessage });
    await harness.emit("message_end", { type: "message_end", message: currentMessage });

    now = 4_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: CUSTOM_ENTRY_TYPE,
          details: { kind: "continuation", goalId: oldGoalId },
        },
        assistantMessage("stop", { input: 20, output: 5 }),
      ],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    await emitProviderContext(harness, [currentMessage]);

    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

for (const stopReason of ["aborted", "stop", "error"] as const) {
  test(`late id-less stale agent_end with ${stopReason} after abort release is ignored`, async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const harness = createRuntimeHarness();
      await harness.runCommand("old goal");
      const oldQueued = harness.sentMessages[0];
      assert.ok(oldQueued);
      const oldMessage = queuedCustomMessage(oldQueued, 1);

      await harness.runCommand("new goal");
      const currentQueued = harness.sentMessages.at(-1);
      assert.ok(currentQueued);
      const currentMessage = queuedCustomMessage(currentQueued, 2);
      const replacement = harness.snapshot().goal;
      assert.equal(replacement?.objective, "new goal");
      harness.sentMessages.length = 0;

      await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
      assert.equal(harness.abortCount, 1);

      now = 3_000;
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 4 });
      await harness.emit("message_start", { type: "message_start", message: currentMessage });
      await harness.emit("message_end", { type: "message_end", message: currentMessage });

      now = 4_000;
      await harness.emit("turn_end", {
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage(stopReason, { input: 20, output: 5 }),
        toolResults: [],
      });
      assert.equal(harness.snapshot().goal?.status, "active");
      assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
      assert.equal(harness.sentMessages.length, 0);

      now = 4_500;
      await harness.emit("agent_end", {
        type: "agent_end",
        messages: [assistantMessage(stopReason, { input: 20, output: 5 })],
      });
      assert.equal(harness.snapshot().goal?.status, "active");
      assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
      assert.equal(harness.sentMessages.length, 0);

      await emitProviderContext(harness, [currentMessage]);

      now = 5_000;
      await harness.emit("turn_end", {
        type: "turn_end",
        turnIndex: 1,
        message: assistantMessage("stop", { input: 30, output: 12 }),
        toolResults: [],
      });

      const goal = harness.snapshot().goal;
      assert.equal(goal?.goalId, replacement?.goalId);
      assert.equal(goal?.status, "active");
      assert.equal(goal?.usage.tokensUsed, 42);
      assert.equal(goal?.usage.activeSeconds, 2);
      assert.equal(harness.sentMessages.length, 1);
      assert.deepEqual(harness.sentMessages[0]?.message.details, {
        kind: "continuation",
        goalId: replacement?.goalId,
      });
    } finally {
      Date.now = originalNow;
    }
  });
}

test("late stale agent_end before next current context event is ignored", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);
    const oldGoalId = harness.snapshot().goal?.goalId;
    assert.ok(oldGoalId);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 4 });
    await harness.emit("message_start", { type: "message_start", message: currentMessage });
    await harness.emit("message_end", { type: "message_end", message: currentMessage });

    now = 4_000;
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: CUSTOM_ENTRY_TYPE,
          details: { kind: "continuation", goalId: oldGoalId },
        },
        assistantMessage("aborted", { input: 20, output: 5 }),
      ],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    await emitProviderContext(harness, [currentMessage]);

    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("current id-less agent_end error after stale abort release and current context is not swallowed", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;
    harness.footerStatuses.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);

    now = 5_000;
    const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "websocket closed");
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 5 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: errorMessage,
      toolResults: [],
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [errorMessage],
    });

    assert.equal(harness.snapshot().goal?.goalId, replacement?.goalId);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    now = 6_000;
    await harness.emit("session_shutdown", sessionShutdownEvent());

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "paused");
    assert.match(harness.footerStatuses.at(-1) ?? "", /websocket closed/);
  } finally {
    Date.now = originalNow;
  }
});

test("current follow-up abort is not swallowed by a pending late stale turn_end", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);
    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("aborted", { input: 30, output: 12 }),
      toolResults: [],
    });

    let goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "paused");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 0);

    now = 6_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });

    goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "paused");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
  } finally {
    Date.now = originalNow;
  }
});
