import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGoalRecoveryMachine } from "../src/recovery-machine.js";
import { createGoalRecoveryRuntime } from "../src/recovery-runtime.js";
import { recoveryPhaseNeedsUserStartTurn } from "../src/recovery-phase.js";
import { CONTEXT_OVERFLOW_SIGNATURE } from "../src/recovery.js";
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

function createRecoveryTestRuntime(goal: ThreadGoal | null = activeGoal) {
  let recoveryState = createGoalRecoveryMachine();
  let continueCount = 0;
  let refreshCount = 0;

  const ctx = {
    ui: { setStatus() {} },
  } as unknown as ExtensionContext;

  const runtime = createGoalRecoveryRuntime({
    getGoal: () => goal,
    getRecoveryState: () => recoveryState,
    clearContinuationState: () => {},
    pauseGoalForRecovery: () => {},
    refreshUi: () => {
      refreshCount += 1;
    },
    maybeContinue: () => {
      continueCount += 1;
    },
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

test("beginOverflowRecovery without an active goal records user reset only", () => {
  const harness = createRecoveryTestRuntime(null);

  assert.equal(harness.runtime.beginOverflowRecovery(harness.ctx), true);
  assert.equal(harness.recoveryState.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(harness.recoveryState.attention, null);
  assert.equal(recoveryPhaseNeedsUserStartTurn(harness.recoveryState.phase), true);
  assert.equal(harness.refreshCount, 0);
  assert.equal(harness.runtime.beginOverflowRecovery(harness.ctx), false);
});

test("beginOverflowRecovery with a paused goal records user reset without pending attention", () => {
  const pausedGoal: ThreadGoal = { ...activeGoal, status: "paused" };
  const harness = createRecoveryTestRuntime(pausedGoal);

  assert.equal(harness.runtime.beginOverflowRecovery(harness.ctx), true);
  assert.equal(harness.recoveryState.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(harness.recoveryState.attention, null);
  assert.equal(harness.refreshCount, 0);
});

test("persistent provider errors plan pending attention without scheduling hidden continuation", () => {
  const harness = createRecoveryTestRuntime();

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
    harness.ctx,
  );

  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.transientAttempts, 1);
  assert.match(harness.recoveryState.attention ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.recoveryState.attention ?? "", /\/goal resume/);
});

test("persistent overflow errors do not invoke extension compaction hooks", () => {
  const harness = createRecoveryTestRuntime();
  const ctx = harness.ctx as ExtensionContext & { compact?: () => void };
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
  assert.match(harness.recoveryState.attention ?? "", /Goal recovery pending/);

  harness.runtime.handlePersistentAssistantError(
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    harness.ctx,
  );

  assert.equal(harness.continueCount, 0);
  assert.equal(harness.recoveryState.counters.compactionAttempts, 2);
  assert.match(harness.recoveryState.attention ?? "", /\/goal resume/);
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
  assert.match(harness.recoveryState.attention ?? "", /Goal recovery pending/);
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
