import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createRecordingDelayScheduler } from "../src/delay-scheduler.js";
import { createGoalRecoveryMachine } from "../src/recovery-machine.js";
import { createGoalRecoveryRuntime } from "../src/recovery-runtime.js";
import { transientErrorBackoffMs } from "../src/recovery.js";
import type { ThreadGoal } from "../src/types.js";

const activeGoal: ThreadGoal = {
  goalId: "goal-a",
  objective: "ship it",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  createdAt: 0,
  updatedAt: 0,
};

function createRecoveryTestRuntime(options: {
  delayScheduler?: ReturnType<typeof createRecordingDelayScheduler>["scheduler"];
  scheduledDelays?: number[];
  runPending?: () => void;
} = {}) {
  const recording = options.delayScheduler
    ? null
    : createRecordingDelayScheduler();
  const delayScheduler = options.delayScheduler ?? recording!.scheduler;
  const scheduledDelays = options.scheduledDelays ?? recording!.scheduledDelays;
  const runPending = options.runPending ?? recording!.runPending;

  let recoveryState = createGoalRecoveryMachine();
  let errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let continueCount = 0;

  const ctx = {
    ui: { setStatus() {} },
  } as unknown as ExtensionContext;

  const runtime = createGoalRecoveryRuntime({
    getGoal: () => activeGoal,
    getRecoveryState: () => recoveryState,
    clearContinuationState: () => {},
    clearErrorRecoveryTimer: () => {
      errorRecoveryTimer = null;
    },
    setErrorRecoveryTimer(timer) {
      errorRecoveryTimer = timer;
    },
    pauseGoalForRecovery: () => {},
    refreshUi: () => {},
    maybeContinue: () => {
      continueCount += 1;
    },
    delayScheduler,
  });

  return {
    ctx,
    runtime,
    scheduledDelays,
    runPending,
    get continueCount() {
      return continueCount;
    },
    get recoveryState() {
      return recoveryState;
    },
  };
}

test("transient error recovery schedules bounded backoff delays", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handleAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
    0,
  );

  assert.deepEqual(harness.scheduledDelays, [transientErrorBackoffMs(1)]);

  harness.runPending();
  assert.equal(harness.continueCount, 1);

  harness.runtime.handleAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
    1,
  );

  assert.deepEqual(harness.scheduledDelays, [
    transientErrorBackoffMs(1),
    transientErrorBackoffMs(2),
  ]);
});

test("successful toolUse turns reset recovery counters without continuing the goal", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handleAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    harness.ctx,
    0,
  );
  assert.equal(harness.recoveryState.counters.compactionAttempts, 1);

  harness.runtime.finishSuccessfulAssistantTurn(
    { role: "assistant", stopReason: "toolUse" },
    harness.ctx,
    { continueGoal: false },
  );

  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.compactionAttempts, 0);
  assert.equal(harness.recoveryState.counters.transientAttempts, 0);
  assert.equal(harness.recoveryState.counters.signature, null);
});

test("successful non-toolUse turns reset recovery counters and continue the goal", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handleAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
    0,
  );
  assert.equal(harness.recoveryState.counters.transientAttempts, 1);

  harness.runtime.finishSuccessfulAssistantTurn(
    { role: "assistant", stopReason: "stop" },
    harness.ctx,
  );

  assert.equal(harness.continueCount, 1);
  assert.equal(harness.recoveryState.counters.transientAttempts, 0);
});
