import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoalRecoveryMachine,
  setRecoveryPausedAttention,
} from "../src/recovery-machine.ts";
import type { StatusContext } from "../src/goal-runtime-status.ts";
import { createGoalRecoveryRuntime } from "../src/recovery-runtime.ts";
import { CONTEXT_OVERFLOW_SIGNATURE } from "../src/recovery.ts";
import type { ThreadGoal } from "../src/types.ts";

const activeGoal: ThreadGoal = {
  goalId: "goal-a",
  objective: "ship it",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  createdAt: 0,
  updatedAt: 0,
};

function createRecoveryTestRuntime(goal: ThreadGoal | null = activeGoal) {
  let recoveryState = createGoalRecoveryMachine();
  let continueCount = 0;
  let refreshCount = 0;

  const ctx = {
    ui: { setStatus() {} },
  } satisfies StatusContext;

  const runtime = createGoalRecoveryRuntime<StatusContext>({
    getGoal: () => goal,
    getRecoveryState: () => recoveryState,
    clearContinuationState: () => {},
    pauseGoalForRecovery: (_ctx, reason) => {
      setRecoveryPausedAttention(recoveryState, reason);
    },
    refreshUi: () => {
      refreshCount += 1;
    },
    maybeContinue: () => {
      continueCount += 1;
    },
    scheduleProviderLimitAutoResume: () => {},
  });

  return {
    ctx,
    runtime,
    get continueCount() {
      return continueCount;
    },
    get refreshCount() {
      return refreshCount;
    },
    get recoveryState() {
      return recoveryState;
    },
  };
}

test("persistent provider errors plan pending attention without scheduling hidden continuation", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
  );

  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.transientAttempts, 1);
  assert.deepEqual(harness.recoveryState.attention, {
    kind: "pending",
    reason: "provider error (websocket closed)",
  });
});

test("persistent overflow errors do not invoke extension compaction hooks", () => {
  const harness = createRecoveryTestRuntime();
  const ctx: StatusContext & { compact?: () => void } = harness.ctx;
  let compactCalls = 0;
  ctx.compact = () => {
    compactCalls += 1;
  };

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    harness.ctx,
  );

  assert.equal(compactCalls, 0);
  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.compactionAttempts, 1);
  assert.equal(harness.recoveryState.counters.signature, CONTEXT_OVERFLOW_SIGNATURE);
});

test("successful toolUse turns reset recovery counters without continuing the goal", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    harness.ctx,
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

test("overflow compaction attempts survive intervening transient errors before pausing", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    harness.ctx,
  );
  assert.equal(harness.recoveryState.counters.compactionAttempts, 1);

  harness.runtime.onSessionCompact();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
  );
  assert.equal(harness.recoveryState.counters.compactionAttempts, 1);
  assert.equal(harness.continueCount, 0);
  assert.deepEqual(harness.recoveryState.attention, {
    kind: "pending",
    reason: "provider error (websocket closed)",
  });

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    harness.ctx,
  );

  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.compactionAttempts, 2);
  assert.deepEqual(harness.recoveryState.attention, {
    kind: "paused",
    reason: "context window recovery failed after repeated compaction attempts",
  });
});

test("recovery pause delegates reason without clearing continuation in recovery runtime", () => {
  let continuationCleared = false;
  let pauseReason: string | null = null;
  let refreshCount = 0;
  const recoveryState = createGoalRecoveryMachine();

  const runtime = createGoalRecoveryRuntime<StatusContext>({
    getGoal: () => activeGoal,
    getRecoveryState: () => recoveryState,
    clearContinuationState: () => {
      continuationCleared = true;
    },
    pauseGoalForRecovery: (_ctx, reason) => {
      pauseReason = reason;
    },
    refreshUi: () => {
      refreshCount += 1;
    },
    maybeContinue: () => {},
    scheduleProviderLimitAutoResume: () => {},
  });

  const ctx = { ui: { setStatus() {} } } satisfies StatusContext;

  runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    ctx,
  );
  runtime.onSessionCompact();
  continuationCleared = false;
  runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    ctx,
  );

  assert.equal(continuationCleared, false);
  assert.match(pauseReason ?? "", /context window recovery failed/);
  assert.equal(refreshCount, 0);
});

test("session compact after pending transient error preserves attention without continuing", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
  );
  assert.equal(harness.continueCount, 0);

  harness.runtime.onSessionCompact();

  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.transientAttempts, 1);
  assert.deepEqual(harness.recoveryState.attention, {
    kind: "pending",
    reason: "provider error (websocket closed)",
  });
});
test("successful non-toolUse turns reset recovery counters and continue the goal", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
  );
  assert.equal(harness.recoveryState.counters.transientAttempts, 1);

  harness.runtime.finishSuccessfulAssistantTurn(
    { role: "assistant", stopReason: "stop" },
    harness.ctx,
  );

  assert.equal(harness.continueCount, 1);
  assert.equal(harness.recoveryState.counters.transientAttempts, 0);
});
