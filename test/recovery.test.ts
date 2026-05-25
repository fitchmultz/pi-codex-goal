import assert from "node:assert/strict";
import test from "node:test";

import {
  countersForFailureSignature,
  createErrorRecoveryCounters,
  failureSignature,
  isContextOverflowError,
  isErrorAssistantMessage,
  isSuccessfulAssistantTurn,
  transientErrorBackoffMs,
} from "../src/recovery.js";
import {
  bumpRecoveryGeneration,
  createGoalRecoveryMachine,
  isRecoveryCompactionScopeActive,
  onRecoverySessionCompact,
  planRecoveryForAssistantError,
  shouldSkipDuplicateRecoveryErrorHandling,
} from "../src/recovery-machine.js";

test("detects context overflow error messages", () => {
  assert.equal(isContextOverflowError("context_length_exceeded: prompt too large"), true);
  assert.equal(isContextOverflowError("Exceeded max context length"), true);
  assert.equal(isContextOverflowError("rate limit exceeded"), false);
});

test("failure signatures normalize to the first line", () => {
  assert.equal(failureSignature("first line\nsecond line"), "first line");
  assert.equal(failureSignature(undefined), "unknown_error");
});

test("counters reset when the failure signature changes", () => {
  const counters = countersForFailureSignature(
    {
      signature: "old",
      transientAttempts: 3,
      compactionAttempts: 2,
    },
    "new",
  );
  assert.equal(counters.signature, "new");
  assert.equal(counters.transientAttempts, 0);
  assert.equal(counters.compactionAttempts, 0);
});

test("successful assistant turns exclude errors and aborts", () => {
  assert.equal(isSuccessfulAssistantTurn({ role: "assistant", stopReason: "stop" }), true);
  assert.equal(isSuccessfulAssistantTurn({ role: "assistant", stopReason: "error" }), false);
  assert.equal(isSuccessfulAssistantTurn({ role: "assistant", stopReason: "aborted" }), false);
  assert.equal(isErrorAssistantMessage({ role: "assistant", stopReason: "error" }), true);
});

test("transient backoff grows with bounded exponential delay", () => {
  assert.equal(transientErrorBackoffMs(1), 1_000);
  assert.equal(transientErrorBackoffMs(2), 2_000);
  assert.equal(transientErrorBackoffMs(6), 30_000);
});

test("createErrorRecoveryCounters starts empty", () => {
  assert.deepEqual(createErrorRecoveryCounters(), {
    signature: null,
    transientAttempts: 0,
    compactionAttempts: 0,
  });
});

test("recovery session compact preserves compaction attempts during recovery", () => {
  const state = createGoalRecoveryMachine();
  state.recoveryCompactionPending = true;
  state.counters = {
    signature: "context_length_exceeded",
    transientAttempts: 2,
    compactionAttempts: 2,
  };

  onRecoverySessionCompact(state);

  assert.equal(state.counters.compactionAttempts, 2);
  assert.equal(state.counters.transientAttempts, 0);
  assert.equal(state.recoveryCompactionPending, false);
});

test("recovery compaction scope ignores stale generations", () => {
  const state = createGoalRecoveryMachine();
  const scope = { goalId: "goal-a", generation: state.generation };
  bumpRecoveryGeneration(state);
  assert.equal(isRecoveryCompactionScopeActive(state, scope, "goal-a"), false);
});

test("recovery plans pause after compaction cap even when compaction attempts are already exhausted", () => {
  const state = createGoalRecoveryMachine();
  state.counters = {
    signature: "context_length_exceeded",
    transientAttempts: 0,
    compactionAttempts: 3,
  };
  const action = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    "goal-a",
  );
  assert.equal(action.type, "pause");
});

test("duplicate agent_end error handling is skipped for the same turn", () => {
  const state = createGoalRecoveryMachine();
  state.lastHandledErrorTurnIndex = 4;
  assert.equal(shouldSkipDuplicateRecoveryErrorHandling(state, 4), true);
  assert.equal(shouldSkipDuplicateRecoveryErrorHandling(state, 5), false);
});
