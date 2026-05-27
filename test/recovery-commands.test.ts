import assert from "node:assert/strict";
import { test } from "node:test";

import {
  continuationGoalIdFromPrompt,
  continuationPrompt,
} from "../src/prompts.js";
import { isGoalCustomEntry } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import {
  createRuntimeHarness,
  emitPersistentAssistantError,
} from "./support/runtime-harness.js";
import {
  givenOverflowPausedGoal,
  replaceGoalAfterOverflowPause,
} from "./support/scenarios.js";

test("/goal resume after non-retryable pause resets recovery counters", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");

  await emitPersistentAssistantError(harness, 1, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("/goal resume after overflow pause resets recovery counters", async () => {
  const { harness } = await givenOverflowPausedGoal();
  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const resumeMessage = harness.sentUserMessages[0];
  assert.ok(resumeMessage);
  assert.deepEqual(resumeMessage.options, { deliverAs: "followUp" });
  const content = resumeMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow resume to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(content), harness.snapshot().goal?.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  const contextResults = await harness.emit("context", {
    type: "context",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: 1,
      },
    ],
  });
  assert.equal(contextResults[0], undefined);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal resume after overflow pause and session shutdown sends user turn and resets host overflow cap", async () => {
  const { harness } = await givenOverflowPausedGoal();

  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const resumeMessage = harness.sentUserMessages[0];
  assert.ok(resumeMessage);
  assert.deepEqual(resumeMessage.options, { deliverAs: "followUp" });

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content: resumeMessage.content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("custom command_resume turn after host overflow exhaustion does not reset host recovery cap", async () => {
  const { harness, goal } = await givenOverflowPausedGoal();

  await harness.emit("message_start", {
    type: "message_start",
    message: {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind: "command_resume", goalId: goal.goalId },
    },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
});

test("custom command_start turn after host overflow exhaustion does not reset host recovery cap", async () => {
  const { harness, goal } = await givenOverflowPausedGoal();

  await harness.emit("message_start", {
    type: "message_start",
    message: {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind: "command_start", goalId: goal.goalId },
    },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
});

test("/goal new objective after overflow pause sends user turn and resets host overflow cap", async () => {
  const { harness } = await givenOverflowPausedGoal();
  const { goal, previousGoalId } = await replaceGoalAfterOverflowPause(harness, "ship the replacement");
  assert.notEqual(goal.goalId, previousGoalId);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  assert.deepEqual(startMessage.options, { deliverAs: "followUp" });
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow replacement start to send a user continuation prompt.");
  }
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(content), goal.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal clear then start after overflow pause sends user turn and resets host overflow cap", async () => {
  const { harness } = await givenOverflowPausedGoal();

  await harness.runCommand("clear");
  assert.equal(harness.snapshot().goal, null);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow clear-and-start to send a user continuation prompt.");
  }

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal new objective after overflow pause survives extension reload and resets host overflow cap", async () => {
  const { harness, goal: previousGoal } = await givenOverflowPausedGoal();

  await harness.reloadSession();
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, "ship the replacement");
  assert.notEqual(goal.goalId, previousGoal.goalId);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow replacement after reload to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(content), goal.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal clear then start after overflow pause survives extension reload and resets host overflow cap", async () => {
  const { harness } = await givenOverflowPausedGoal();

  await harness.reloadSession();
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.runCommand("clear");
  assert.equal(harness.snapshot().goal, null);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow clear-and-start after reload to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("context overflow before any active goal sends user /goal start and persists cap reset", async () => {
  const harness = createRuntimeHarness();
  assert.equal(harness.snapshot().goal, null);

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
  assert.equal(
    harness.entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        isGoalCustomEntry(entry.data) &&
        entry.data.kind === "host_overflow_cap_reset" &&
        entry.data.active === true,
    ),
    true,
  );

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the feature");

  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, "ship the feature");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  assert.deepEqual(startMessage.options, { deliverAs: "followUp" });
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow goal start to send a user continuation prompt.");
  }
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.equal(continuationGoalIdFromPrompt(content), goal.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);
});

test("context overflow while goal is paused sends user turn on replacement start", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runCommand("pause");
  assert.equal(harness.snapshot().goal?.status, "paused");

  await emitPersistentAssistantError(harness, 1, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  const { goal, previousGoalId } = await replaceGoalAfterOverflowPause(harness, "ship the replacement");
  assert.notEqual(goal.goalId, previousGoalId);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected paused-overflow replacement start to send a user continuation prompt.");
  }
  assert.equal(continuationGoalIdFromPrompt(content), goal.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);
});
