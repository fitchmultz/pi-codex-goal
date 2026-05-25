import {
  CONTEXT_OVERFLOW_SIGNATURE,
  countersForFailureSignature,
  createErrorRecoveryCounters,
  failureSignature,
  HOST_OVERFLOW_RECOVERY_REASON,
  isContextOverflowError,
  isRetryableTransientError,
  isSuccessfulAssistantTurn,
  MAX_CONTEXT_COMPACTION_RETRIES,
  recoveryPausedAttentionMessage,
  recoveryPendingAttentionMessage,
  type AssistantErrorMessage,
  type ErrorRecoveryCounters,
} from "./recovery.js";

export type RecoveryAction =
  | { type: "noop" }
  | { type: "pending"; reason: string }
  | { type: "pause"; reason: string };

export interface GoalRecoveryMachineState {
  counters: ErrorRecoveryCounters;
  attention: string | null;
}

export function createGoalRecoveryMachine(): GoalRecoveryMachineState {
  return {
    counters: createErrorRecoveryCounters(),
    attention: null,
  };
}

export function resetRecoveryMachine(state: GoalRecoveryMachineState): void {
  state.counters = createErrorRecoveryCounters();
  state.attention = null;
}

export function resetRecoveryCounters(state: GoalRecoveryMachineState): void {
  state.counters = createErrorRecoveryCounters();
  state.attention = null;
}

export function onRecoveryUserInput(state: GoalRecoveryMachineState): void {
  resetRecoveryMachine(state);
}

export function onRecoverySuccessfulTurn(
  state: GoalRecoveryMachineState,
  message: AssistantErrorMessage,
): boolean {
  if (!isSuccessfulAssistantTurn(message)) {
    return false;
  }
  resetRecoveryCounters(state);
  return true;
}

export function onRecoverySessionCompact(state: GoalRecoveryMachineState): void {
  if (state.attention === recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)) {
    state.attention = null;
  }

  if (state.counters.signature === CONTEXT_OVERFLOW_SIGNATURE) {
    state.counters = {
      signature: state.counters.signature,
      transientAttempts: 0,
      compactionAttempts: state.counters.compactionAttempts,
    };
    return;
  }

  resetRecoveryCounters(state);
}

export function setRecoveryPendingAttention(state: GoalRecoveryMachineState, reason: string): string {
  const message = recoveryPendingAttentionMessage(reason);
  state.attention = message;
  return message;
}

export function setRecoveryPausedAttention(state: GoalRecoveryMachineState, reason: string): string {
  const message = recoveryPausedAttentionMessage(reason);
  state.attention = message;
  return message;
}

export function beginHostOverflowRecovery(state: GoalRecoveryMachineState): string {
  return setRecoveryPendingAttention(state, HOST_OVERFLOW_RECOVERY_REASON);
}

function incrementOverflowCompactionAttempts(state: GoalRecoveryMachineState): RecoveryAction {
  state.counters = countersForFailureSignature(state.counters, CONTEXT_OVERFLOW_SIGNATURE);
  state.counters = {
    ...state.counters,
    compactionAttempts: state.counters.compactionAttempts + 1,
  };
  if (state.counters.compactionAttempts > MAX_CONTEXT_COMPACTION_RETRIES) {
    return {
      type: "pause",
      reason: "context window recovery failed after repeated compaction attempts",
    };
  }
  return { type: "noop" };
}

/**
 * Plans extension recovery only after pi host post-run retry/compaction has finished.
 * Host AgentSession._handlePostAgentRun() owns retry and overflow compaction; this
 * extension tracks persistent failures and pauses with attention when caps are exceeded.
 */
export function planRecoveryForAssistantError(
  state: GoalRecoveryMachineState,
  message: AssistantErrorMessage,
): RecoveryAction {
  if (isContextOverflowError(message.errorMessage)) {
    return incrementOverflowCompactionAttempts(state);
  }

  const signature = failureSignature(message.errorMessage);
  state.counters = countersForFailureSignature(state.counters, signature);

  if (!isRetryableTransientError(message.errorMessage)) {
    return {
      type: "pause",
      reason: `non-retryable provider error (${signature})`,
    };
  }

  state.counters = {
    ...state.counters,
    transientAttempts: state.counters.transientAttempts + 1,
  };
  return {
    type: "pending",
    reason: `provider error (${signature})`,
  };
}

export function planRecoveryForSilentContextOverflow(state: GoalRecoveryMachineState): RecoveryAction {
  return incrementOverflowCompactionAttempts(state);
}
