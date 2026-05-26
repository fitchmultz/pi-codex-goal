import assert from "node:assert/strict";

import { formatFooterStatus } from "../../src/format.js";
import {
  HOST_OVERFLOW_RECOVERY_REASON,
  recoveryAttentionMessage,
} from "../../src/recovery.js";
import { createThreadGoal, setEntry } from "../../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/types.js";
import {
  createRuntimeHarness,
  emitPersistentAssistantError,
  emitQueuedTurnThroughContext,
  queuedCustomMessage,
  type RuntimeHarness,
} from "./runtime-harness.js";

export function replaceHarnessBranchWithGoal(
  harness: RuntimeHarness,
  objective: string,
): ReturnType<typeof createThreadGoal> {
  const branchGoal = createThreadGoal(objective);
  harness.entries.length = 0;
  harness.entries.push({
    type: "custom",
    id: `entry-branch-${objective.replace(/\s+/g, "-")}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(branchGoal, "command"),
  });
  return branchGoal;
}

export async function givenOverflowPausedGoal(
  objective = "ship it",
): Promise<{
  harness: RuntimeHarness;
  goal: NonNullable<ReturnType<RuntimeHarness["snapshot"]>["goal"]>;
}> {
  const harness = createRuntimeHarness();
  await harness.runCommand(objective);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }

  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
  return { harness, goal };
}

export async function givenPendingTransientRecovery(
  objective = "ship it",
): Promise<RuntimeHarness> {
  const harness = createRuntimeHarness();
  await harness.runCommand(objective);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  return harness;
}

export async function givenPendingOverflowRecovery(
  objective = "ship it",
): Promise<RuntimeHarness> {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand(objective);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  return harness;
}

export async function emitPendingRecoveryShutdown(
  harness: RuntimeHarness,
  kind: "overflow" | "transient",
): Promise<ReturnType<RuntimeHarness["snapshot"]>["goal"]> {
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  const pausedGoal = harness.snapshot().goal;
  assert.equal(pausedGoal?.status, "paused");
  assert.match(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
  if (kind === "overflow") {
    assert.equal(
      harness.footerStatuses.at(-1),
      formatFooterStatus(pausedGoal, recoveryAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
    );
  } else {
    assert.equal(
      harness.footerStatuses.at(-1),
      formatFooterStatus(
        pausedGoal,
        recoveryAttentionMessage("provider error (websocket closed)"),
      ),
    );
  }
  return pausedGoal;
}

export async function givenPendingRecoveryWithStaleQueuedAbort(
  kind: "overflow" | "transient",
): Promise<{ harness: RuntimeHarness }> {
  const harness =
    kind === "overflow"
      ? createRuntimeHarness({ compactBehavior: "unavailable" })
      : createRuntimeHarness();

  await harness.runCommand("old goal");
  const oldQueued = harness.sentMessages[0];
  assert.ok(oldQueued);
  const oldMessage = queuedCustomMessage(oldQueued);

  await harness.runCommand("ship it");
  const activeGoal = harness.snapshot().goal;
  assert.ok(activeGoal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  const errorMessage = kind === "overflow" ? "context_length_exceeded" : "websocket closed";
  await emitPersistentAssistantError(harness, 0, errorMessage);
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await emitQueuedTurnThroughContext(harness, [oldMessage]);
  assert.equal(harness.abortCount, 1);

  const pausedGoal = await emitPendingRecoveryShutdown(harness, kind);
  assert.ok(pausedGoal);
  assert.equal(pausedGoal.goalId, activeGoal.goalId);

  return { harness };
}

export async function replaceGoalAfterOverflowPause(
  harness: RuntimeHarness,
  replacementObjective: string,
): Promise<{
  previousGoalId: string;
  goal: NonNullable<ReturnType<RuntimeHarness["snapshot"]>["goal"]>;
}> {
  const previousGoal = harness.snapshot().goal;
  assert.ok(previousGoal);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand(replacementObjective);
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, replacementObjective);
  assert.notEqual(goal.goalId, previousGoal.goalId);

  return { previousGoalId: previousGoal.goalId, goal };
}
