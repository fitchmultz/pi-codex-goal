import assert from "node:assert/strict";
import { testUi } from "./support/sdk-fixture.ts";
import { test as nodeTest } from "node:test";

import { createGoalRecoveryMachine } from "../src/recovery-machine.ts";
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
  const recoveryState = createGoalRecoveryMachine();
  let continueCount = 0;
  let refreshCount = 0;

  const ctx = {
    mode: "print",
    ui: testUi(),
  } satisfies StatusContext;

  const runtime = createGoalRecoveryRuntime<StatusContext>({
    getGoal: () => goal,
    getRecoveryState: () => recoveryState,
    clearContinuationState: () => {
      /* This fixture has no queued continuation. */
    },
    pauseGoalForRecovery: (_ctx, reason) => {
      recoveryState.setRecoveryPausedAttention(reason);
    },
    refreshUi: () => {
      refreshCount += 1;
    },
    maybeContinue: () => {
      continueCount += 1;
    },
    scheduleProviderLimitAutoResume: () => {
      /* No provider-limit timer is owned here. */
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

nodeTest(
  "persistent provider errors plan pending attention without scheduling hidden continuation",
  () => {
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
  },
);

nodeTest("persistent overflow errors do not invoke extension compaction hooks", () => {
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

nodeTest("successful toolUse turns reset recovery counters without continuing the goal", () => {
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

nodeTest("overflow compaction attempts survive intervening transient errors before pausing", () => {
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

nodeTest(
  "recovery pause delegates reason without clearing continuation in recovery runtime",
  () => {
    let continuationCleared = false;
    const pauses: string[] = [];
    let refreshCount = 0;
    const recoveryState = createGoalRecoveryMachine();

    const runtime = createGoalRecoveryRuntime<StatusContext>({
      getGoal: () => activeGoal,
      getRecoveryState: () => recoveryState,
      clearContinuationState: () => {
        continuationCleared = true;
      },
      pauseGoalForRecovery: (_ctx, reason) => {
        pauses.push(reason);
      },
      refreshUi: () => {
        refreshCount += 1;
      },
      maybeContinue: () => {
        /* This case inspects the pause callback, not continuation. */
      },
      scheduleProviderLimitAutoResume: () => {
        /* No provider-limit timer is owned here. */
      },
    });

    const ctx = {
      mode: "print",
      ui: testUi(),
    } satisfies StatusContext;

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
    assert.match(pauses.at(-1) ?? "", /context window recovery failed/);
    assert.equal(refreshCount, 0);
  },
);

nodeTest(
  "session compact after pending transient error preserves attention without continuing",
  () => {
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
  },
);
nodeTest("successful non-toolUse turns reset recovery counters and continue the goal", () => {
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
