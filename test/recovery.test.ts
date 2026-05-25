import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_OVERFLOW_SIGNATURE,
  countersForFailureSignature,
  createErrorRecoveryCounters,
  failureSignature,
  isContextOverflowError,
  isErrorAssistantMessage,
  isSuccessfulAssistantTurn,
  transientErrorBackoffMs,
} from "../src/recovery.js";
import {
  createGoalRecoveryMachine,
  onRecoverySessionCompact,
  planRecoveryForAssistantError,
} from "../src/recovery-machine.js";

test("detects context overflow error messages", () => {
  assert.equal(isContextOverflowError("context_length_exceeded: prompt too large"), true);
  assert.equal(isContextOverflowError("Exceeded max context length"), true);
  assert.equal(isContextOverflowError("rate limit exceeded"), false);
});

test("failure signatures canonicalize context overflow regardless of volatile token counts", () => {
  assert.equal(
    failureSignature("context window exceeded: 100000 tokens used of 128000"),
    CONTEXT_OVERFLOW_SIGNATURE,
  );
  assert.equal(
    failureSignature("context window exceeded: 200000 tokens used of 256000"),
    CONTEXT_OVERFLOW_SIGNATURE,
  );
  assert.equal(failureSignature("first line\nsecond line"), "first line");
  assert.equal(failureSignature(undefined), "unknown_error");
});

test("changing context overflow messages share one recovery signature and reach the cap", () => {
  const state = createGoalRecoveryMachine();
  const messages = [
    "context window exceeded: 100000 tokens",
    "context window exceeded: 200000 tokens",
    "model_context_window_exceeded: prompt too long",
    "context_length_exceeded: 300000 tokens",
  ];

  for (const errorMessage of messages.slice(0, 3)) {
    const action = planRecoveryForAssistantError(
      state,
      { role: "assistant", stopReason: "error", errorMessage },
    );
    assert.equal(action.type, "noop");
  }

  const finalAction = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: messages[3]! },
  );
  assert.equal(finalAction.type, "pause");
  assert.equal(state.counters.compactionAttempts, 4);
  assert.equal(state.counters.signature, CONTEXT_OVERFLOW_SIGNATURE);
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

test("recovery session compact preserves overflow attempt counts after host compaction", () => {
  const state = createGoalRecoveryMachine();
  state.counters = {
    signature: CONTEXT_OVERFLOW_SIGNATURE,
    transientAttempts: 2,
    compactionAttempts: 2,
  };

  onRecoverySessionCompact(state);

  assert.equal(state.counters.compactionAttempts, 2);
  assert.equal(state.counters.transientAttempts, 0);
  assert.equal(state.counters.signature, CONTEXT_OVERFLOW_SIGNATURE);
});

test("recovery plans pause after compaction cap even when compaction attempts are already exhausted", () => {
  const state = createGoalRecoveryMachine();
  state.counters = {
    signature: CONTEXT_OVERFLOW_SIGNATURE,
    transientAttempts: 0,
    compactionAttempts: 3,
  };
  const action = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
  );
  assert.equal(action.type, "pause");
});

test("recovery plans noop while under host-owned overflow and transient caps", () => {
  const overflow = planRecoveryForAssistantError(
    createGoalRecoveryMachine(),
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
  );
  assert.equal(overflow.type, "noop");

  const transient = planRecoveryForAssistantError(
    createGoalRecoveryMachine(),
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
  );
  assert.equal(transient.type, "noop");
});
