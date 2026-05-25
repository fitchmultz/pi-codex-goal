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
} from "../src/recovery.js";
import {
  createGoalRecoveryMachine,
  onRecoverySessionCompact,
  planRecoveryForAssistantError,
} from "../src/recovery-machine.js";

test("detects context overflow error messages with host overflow classifier", () => {
  assert.equal(isContextOverflowError("context_length_exceeded: prompt too large"), true);
  assert.equal(isContextOverflowError("prompt is too long: 213462 tokens > 200000 maximum"), true);
  assert.equal(isContextOverflowError('413 {"error":{"type":"request_too_large"}}'), true);
  assert.equal(
    isContextOverflowError(
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
    ),
    true,
  );
  assert.equal(isContextOverflowError("too many tokens"), true);
  assert.equal(isContextOverflowError("token limit exceeded"), true);
  assert.equal(isContextOverflowError("rate limit exceeded"), false);
});

test("failure signatures canonicalize context overflow regardless of volatile token counts", () => {
  assert.equal(
    failureSignature("prompt is too long: 100000 tokens > 128000 maximum"),
    CONTEXT_OVERFLOW_SIGNATURE,
  );
  assert.equal(
    failureSignature("prompt is too long: 200000 tokens > 256000 maximum"),
    CONTEXT_OVERFLOW_SIGNATURE,
  );
  assert.equal(failureSignature("first line\nsecond line"), "first line");
  assert.equal(failureSignature(undefined), "unknown_error");
});

test("changing context overflow messages share one recovery signature and reach the host cap", () => {
  const state = createGoalRecoveryMachine();
  const messages = [
    "prompt is too long: 100000 tokens > 200000 maximum",
    "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
  ];

  for (const errorMessage of messages.slice(0, 1)) {
    const action = planRecoveryForAssistantError(
      state,
      { role: "assistant", stopReason: "error", errorMessage },
    );
    assert.equal(action.type, "noop");
  }

  const finalAction = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: messages[1]! },
  );
  assert.equal(finalAction.type, "pause");
  assert.equal(state.counters.compactionAttempts, 2);
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
    compactionAttempts: 1,
  };
  const action = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
  );
  assert.equal(action.type, "pause");
});

test("recovery plans pause after host default transient retry cap", () => {
  const state = createGoalRecoveryMachine();
  state.counters = {
    signature: "websocket closed",
    transientAttempts: 3,
    compactionAttempts: 0,
  };
  const action = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
  );
  assert.equal(action.type, "pause");
  assert.equal(state.counters.transientAttempts, 4);
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
