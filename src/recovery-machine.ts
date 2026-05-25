import {
  CONTEXT_OVERFLOW_SIGNATURE,
  countersForFailureSignature,
  createErrorRecoveryCounters,
  failureSignature,
  isContextOverflowError,
  isSuccessfulAssistantTurn,
  MAX_CONTEXT_COMPACTION_RETRIES,
  MAX_TRANSIENT_ERROR_RETRIES,
  recoveryAttentionMessage,
  type AssistantErrorMessage,
  type ErrorRecoveryCounters,
} from "./recovery.js";

export type RecoveryAction = { type: "noop" } | { type: "pause"; reason: string };

export interface GoalRecoveryMachineState {
  counters: ErrorRecoveryCounters;
  generation: number;
  attention: string | null;
}

export function createGoalRecoveryMachine(): GoalRecoveryMachineState {
  return {
    counters: createErrorRecoveryCounters(),
    generation: 0,
    attention: null,
  };
}

export function bumpRecoveryGeneration(state: GoalRecoveryMachineState): void {
  state.generation += 1;
}

export function resetRecoveryMachine(state: GoalRecoveryMachineState): void {
  state.counters = createErrorRecoveryCounters();
  state.attention = null;
}

export function resetRecoveryCounters(state: GoalRecoveryMachineState): void {
  state.counters = createErrorRecoveryCounters();
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

export function setRecoveryAttention(state: GoalRecoveryMachineState, reason: string): string {
  const message = recoveryAttentionMessage(reason);
  state.attention = message;
  return message;
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
  const signature = failureSignature(message.errorMessage);
  state.counters = countersForFailureSignature(state.counters, signature);

  if (isContextOverflowError(message.errorMessage)) {
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

  state.counters = {
    ...state.counters,
    transientAttempts: state.counters.transientAttempts + 1,
  };
  if (state.counters.transientAttempts > MAX_TRANSIENT_ERROR_RETRIES) {
    return {
      type: "pause",
      reason: `provider error persisted (${signature})`,
    };
  }
  return { type: "noop" };
}
