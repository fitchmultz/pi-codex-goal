import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_OVERFLOW_SIGNATURE,
  countersForFailureSignature,
  createErrorRecoveryCounters,
  failureSignature,
  HOST_OVERFLOW_RECOVERY_REASON,
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  createRecoveryPendingAttention,
  isProviderLimitError,
  isRetryableTransientError,
  isRecoveryPendingAttention,
  isSuccessfulAssistantTurn,
  reasonFromRecoveryPendingAttention,
  recoveryAttentionMessage,
  recoveryPendingAttentionMessage,
} from "../src/recovery.ts";
import {
  applyHostOverflowUserResetPersistence,
  beginHostOverflowRecovery,
  createGoalRecoveryMachine,
  requireHostOverflowUserReset,
  goalStartTurnStrategy,
  isRepeatOverflowCompactionDue,
  onRecoverySessionCompact,
  planRecoveryForAssistantError,
  planRecoveryForSilentContextOverflow,
  recoveryPhaseBlocksContinuation,
  recoveryPhaseNeedsUserStartTurn,
  resetRecoveryMachine,
  setRecoveryPendingAttention,
} from "../src/recovery-machine.ts";

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

test("isAssistantContextOverflow detects silent stop and zero-output length overflows", () => {
  const contextWindow = 128_000;

  assert.equal(
    isAssistantContextOverflow(
      {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 130_000, output: 0, cacheRead: 0 },
      },
      contextWindow,
    ),
    true,
  );
  assert.equal(
    isAssistantContextOverflow(
      {
        role: "assistant",
        stopReason: "length",
        usage: { input: 127_000, output: 0, cacheRead: 1_000 },
      },
      contextWindow,
    ),
    true,
  );
  assert.equal(
    isAssistantContextOverflow(
      {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1_000, output: 500 },
      },
      contextWindow,
    ),
    false,
  );
});

test("isRetryableTransientError mirrors host retry classification", () => {
  assert.equal(isRetryableTransientError("HTTP 429 too many requests"), true);
  assert.equal(isRetryableTransientError("HTTP 500 internal server error"), true);
  assert.equal(isRetryableTransientError("HTTP 502 bad gateway"), true);
  assert.equal(isRetryableTransientError("HTTP 503 service unavailable"), true);
  assert.equal(isRetryableTransientError("websocket closed"), true);
  assert.equal(
    isRetryableTransientError("exceeded request buffer limit while retrying upstream"),
    true,
  );
  assert.equal(isRetryableTransientError("context_length_exceeded"), false);
  assert.equal(isRetryableTransientError("invalid api key"), false);
});

const terminalProviderLimitErrors = [
  "insufficient_quota 429",
  "available balance",
  "quota exceeded",
  "billing",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "usage limit has been reached",
  "out of budget",
] as const;

test("terminal provider-limit errors are not retryable transient errors", () => {
  for (const errorMessage of terminalProviderLimitErrors) {
    assert.equal(isRetryableTransientError(errorMessage), false, errorMessage);
  }
});

test("provider-limit classifier recognizes only quota and usage-limit errors", () => {
  for (const errorMessage of terminalProviderLimitErrors) {
    assert.equal(isProviderLimitError(errorMessage), true, errorMessage);
  }
  assert.equal(isProviderLimitError("usage limit has been reached for this account"), true);
  assert.equal(isProviderLimitError("invalid tool call state: malformed function arguments"), false);
  assert.equal(isProviderLimitError("invalid api key"), false);
  assert.equal(isProviderLimitError(undefined), false);
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
  assert.equal(
    failureSignature("exceeded request buffer limit while retrying upstream"),
    "exceeded request buffer limit while retrying upstream",
  );
  assert.equal(failureSignature("HTTP 500 req_abc123 failed"), "HTTP 500 req_<id> failed");
  assert.equal(failureSignature(undefined), "unknown_error");
});

test("recovery pending attention helpers round-trip structured reasons", () => {
  const reason = "provider error (weird ) parens; slash /goal resume text)";
  const attention = createRecoveryPendingAttention(reason);
  assert.equal(isRecoveryPendingAttention(attention), true);
  assert.equal(reasonFromRecoveryPendingAttention(attention), reason);
  assert.equal(
    recoveryPendingAttentionMessage(attention.reason),
    `Goal recovery pending (${reason}); wait for host retry/compaction or send a new user message if it does not recover.`,
  );
  assert.equal(isRecoveryPendingAttention({ kind: "paused", reason }), false);
  assert.equal(isRecoveryPendingAttention(null), false);
  assert.equal(reasonFromRecoveryPendingAttention(null), null);
  assert.equal(recoveryAttentionMessage(reason), `Goal needs attention (${reason}). Use /goal resume to continue.`);
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

test("counters reset transient attempts on signature change but preserve overflow compaction attempts", () => {
  const counters = countersForFailureSignature(
    {
      signature: "HTTP <n>",
      transientAttempts: 3,
      compactionAttempts: 2,
    },
    "HTTP <n> service unavailable",
  );
  assert.equal(counters.signature, "HTTP <n> service unavailable");
  assert.equal(counters.transientAttempts, 0);
  assert.equal(counters.compactionAttempts, 2);
});

test("overflow compaction attempts survive intervening transient provider errors", () => {
  const state = createGoalRecoveryMachine();

  const firstOverflow = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
  );
  assert.equal(firstOverflow.type, "noop");
  assert.equal(state.counters.compactionAttempts, 1);

  onRecoverySessionCompact(state);
  assert.equal(state.counters.compactionAttempts, 1);

  const transient = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
  );
  assert.equal(transient.type, "pending");
  assert.equal(state.counters.compactionAttempts, 1);
  assert.equal(state.counters.signature, "websocket closed");

  const secondOverflow = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
  );
  assert.equal(secondOverflow.type, "pause");
  assert.equal(state.counters.compactionAttempts, 2);
});

test("varied retryable transient errors stay active without tripping signature-scoped cap", () => {
  const state = createGoalRecoveryMachine();
  const errors = [
    "HTTP 500 internal server error",
    "HTTP 502 bad gateway",
    "HTTP 503 service unavailable",
    "HTTP 504 gateway timeout",
  ];

  for (const errorMessage of errors) {
    const action = planRecoveryForAssistantError(
      state,
      { role: "assistant", stopReason: "error", errorMessage },
    );
    assert.equal(action.type, "pending", `${errorMessage} should surface pending attention`);
    assert.equal(state.counters.transientAttempts, 1, `${errorMessage} should reset per signature`);
  }
});

test("repeated identical transient errors stay pending without host-default pause caps", () => {
  const state = createGoalRecoveryMachine();
  const errorMessage = "websocket closed";

  for (let index = 0; index < 10; index += 1) {
    const action = planRecoveryForAssistantError(
      state,
      { role: "assistant", stopReason: "error", errorMessage },
    );
    assert.equal(action.type, "pending", `attempt ${index + 1} should stay pending`);
    assert.equal(state.counters.transientAttempts, index + 1);
  }
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

test("beginHostOverflowRecovery surfaces pending attention without pausing", () => {
  const state = createGoalRecoveryMachine();
  const result = beginHostOverflowRecovery(state);
  assert.deepEqual(result.attention, {
    kind: "pending",
    reason: HOST_OVERFLOW_RECOVERY_REASON,
  });
  assert.equal(result.persistHostOverflowCapReset, true);
  assert.deepEqual(state.attention, result.attention);
  assert.equal(state.phase.kind, "hostOverflowRecoveringNeedsUserStart");
  assert.equal(recoveryPhaseBlocksContinuation(state.phase), true);
  assert.equal(recoveryPhaseNeedsUserStartTurn(state.phase), true);
  assert.equal(goalStartTurnStrategy(state.phase), "userFollowUp");
});

test("resetRecoveryMachine clears active host overflow recovery but preserves user reset", () => {
  const state = createGoalRecoveryMachine();
  beginHostOverflowRecovery(state);
  resetRecoveryMachine(state);
  assert.equal(state.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(recoveryPhaseNeedsUserStartTurn(state.phase), true);
  assert.equal(recoveryPhaseBlocksContinuation(state.phase), false);
});

test("applyHostOverflowUserResetPersistence(false) keeps active host overflow recovery without user reset", () => {
  const state = createGoalRecoveryMachine();
  beginHostOverflowRecovery(state);
  assert.equal(applyHostOverflowUserResetPersistence(state, false), true);
  assert.equal(state.phase.kind, "hostOverflowRecovering");
  assert.equal(goalStartTurnStrategy(state.phase), "hiddenFollowUp");
});

test("beginHostOverflowRecovery skips cap-reset persistence when user reset already required", () => {
  const state = createGoalRecoveryMachine();
  state.phase = { kind: "hostOverflowNeedsUserStart" };
  const result = beginHostOverflowRecovery(state);
  assert.equal(result.persistHostOverflowCapReset, false);
  assert.equal(state.phase.kind, "hostOverflowRecoveringNeedsUserStart");
});

test("requireHostOverflowUserReset records session-level user start without active recovery", () => {
  const state = createGoalRecoveryMachine();
  assert.equal(requireHostOverflowUserReset(state), true);
  assert.equal(state.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(state.attention, null);
  assert.equal(recoveryPhaseBlocksContinuation(state.phase), false);
  assert.equal(recoveryPhaseNeedsUserStartTurn(state.phase), true);
  assert.equal(goalStartTurnStrategy(state.phase), "userFollowUp");
  assert.equal(requireHostOverflowUserReset(state), false);
  assert.equal(state.phase.kind, "hostOverflowNeedsUserStart");
});

test("recovery session compact preserves overflow attempt counts after host compaction", () => {
  const state = createGoalRecoveryMachine();
  beginHostOverflowRecovery(state);
  state.counters = {
    signature: CONTEXT_OVERFLOW_SIGNATURE,
    transientAttempts: 2,
    compactionAttempts: 1,
  };

  onRecoverySessionCompact(state);

  assert.equal(state.counters.compactionAttempts, 1);
  assert.equal(state.counters.transientAttempts, 0);
  assert.equal(state.counters.signature, CONTEXT_OVERFLOW_SIGNATURE);
  assert.equal(state.attention, null);
});

test("recovery session compact preserves non-overflow pending attention and counters", () => {
  const state = createGoalRecoveryMachine();
  const action = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
  );
  assert.equal(action.type, "pending");
  setRecoveryPendingAttention(state, action.reason);

  onRecoverySessionCompact(state);

  assert.equal(state.counters.transientAttempts, 1);
  assert.equal(state.counters.signature, "websocket closed");
  assert.deepEqual(state.attention, {
    kind: "pending",
    reason: "provider error (websocket closed)",
  });
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

test("silent context overflow increments compaction attempts like error overflows", () => {
  const state = createGoalRecoveryMachine();
  const action = planRecoveryForSilentContextOverflow(state);
  assert.equal(action.type, "noop");
  assert.equal(state.counters.compactionAttempts, 1);
  assert.equal(state.counters.signature, CONTEXT_OVERFLOW_SIGNATURE);
});

test("repeat overflow compaction is due once host recovery cap is reached", () => {
  const state = createGoalRecoveryMachine();
  assert.equal(isRepeatOverflowCompactionDue(state), false);

  planRecoveryForSilentContextOverflow(state);
  assert.equal(isRepeatOverflowCompactionDue(state), true);
});

test("retryable transient errors surface pending attention instead of pausing", () => {
  const state = createGoalRecoveryMachine();
  const action = planRecoveryForAssistantError(
    state,
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "exceeded request buffer limit while retrying upstream",
    },
  );
  assert.equal(action.type, "pending");
  assert.equal(state.counters.transientAttempts, 1);
});

test("recovery plans noop for first overflow and pending for first transient error", () => {
  const overflow = planRecoveryForAssistantError(
    createGoalRecoveryMachine(),
    { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
  );
  assert.equal(overflow.type, "noop");

  const transient = planRecoveryForAssistantError(
    createGoalRecoveryMachine(),
    { role: "assistant", stopReason: "error", errorMessage: "websocket closed" },
  );
  assert.equal(transient.type, "pending");
});

test("non-retryable provider errors pause immediately", () => {
  const state = createGoalRecoveryMachine();
  const action = planRecoveryForAssistantError(
    state,
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "invalid tool call state: malformed function arguments",
    },
  );
  assert.equal(action.type, "pause");
  if (action.type === "pause") {
    assert.match(action.reason, /non-retryable provider error/);
  }
});

test("terminal provider-limit errors pause immediately instead of pending host retry", () => {
  const state = createGoalRecoveryMachine();
  const action = planRecoveryForAssistantError(
    state,
    { role: "assistant", stopReason: "error", errorMessage: "insufficient_quota 429" },
  );

  assert.equal(action.type, "pause");
  if (action.type === "pause") {
    assert.equal(action.reason, "non-retryable provider error (insufficient_quota 429)");
  }
  assert.equal(state.counters.transientAttempts, 0);
});
