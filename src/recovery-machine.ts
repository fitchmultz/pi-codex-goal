import {
  countersForFailureSignature,
  createErrorRecoveryCounters,
  failureSignature,
  isContextOverflowError,
  isSuccessfulAssistantTurn,
  MAX_CONTEXT_COMPACTION_RETRIES,
  MAX_TRANSIENT_ERROR_RETRIES,
  recoveryAttentionMessage,
  transientErrorBackoffMs,
  type AssistantErrorMessage,
  type ErrorRecoveryCounters,
} from "./recovery.js";

export interface RecoveryCompactionScope {
  goalId: string;
  generation: number;
}

export type RecoveryAction =
  | { type: "noop" }
  | { type: "request_compaction"; reason: string; scope: RecoveryCompactionScope }
  | { type: "schedule_retry"; delayMs: number }
  | { type: "pause"; reason: string };

export interface GoalRecoveryMachineState {
  counters: ErrorRecoveryCounters;
  generation: number;
  attention: string | null;
  compactionInFlight: boolean;
  recoveryCompactionPending: boolean;
  lastHandledErrorTurnIndex: number | null;
}

export function createGoalRecoveryMachine(): GoalRecoveryMachineState {
  return {
    counters: createErrorRecoveryCounters(),
    generation: 0,
    attention: null,
    compactionInFlight: false,
    recoveryCompactionPending: false,
    lastHandledErrorTurnIndex: null,
  };
}

export function bumpRecoveryGeneration(state: GoalRecoveryMachineState): void {
  state.generation += 1;
  state.compactionInFlight = false;
  state.recoveryCompactionPending = false;
}

export function resetRecoveryMachine(state: GoalRecoveryMachineState): void {
  state.counters = createErrorRecoveryCounters();
  state.attention = null;
  state.compactionInFlight = false;
  state.recoveryCompactionPending = false;
  state.lastHandledErrorTurnIndex = null;
}

export function resetRecoveryCounters(state: GoalRecoveryMachineState): void {
  state.counters = createErrorRecoveryCounters();
  state.compactionInFlight = false;
  state.recoveryCompactionPending = false;
  state.lastHandledErrorTurnIndex = null;
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
  if (state.recoveryCompactionPending) {
    const preserved = {
      signature: state.counters.signature,
      compactionAttempts: state.counters.compactionAttempts,
    };
    state.counters = {
      signature: preserved.signature,
      transientAttempts: 0,
      compactionAttempts: preserved.compactionAttempts,
    };
    state.compactionInFlight = false;
    state.recoveryCompactionPending = false;
    state.lastHandledErrorTurnIndex = null;
    return;
  }

  resetRecoveryCounters(state);
}

export function beginRecoveryCompactionRequest(
  state: GoalRecoveryMachineState,
  goalId: string,
): RecoveryCompactionScope {
  const scope = { goalId, generation: state.generation };
  state.compactionInFlight = true;
  state.recoveryCompactionPending = true;
  return scope;
}

export function isRecoveryCompactionScopeActive(
  state: GoalRecoveryMachineState,
  scope: RecoveryCompactionScope,
  activeGoalId: string | null,
): boolean {
  return activeGoalId === scope.goalId && state.generation === scope.generation;
}

export function completeRecoveryCompactionRequest(state: GoalRecoveryMachineState): void {
  state.compactionInFlight = false;
}

export function failRecoveryCompactionRequest(state: GoalRecoveryMachineState): void {
  state.compactionInFlight = false;
  state.recoveryCompactionPending = false;
}

export function markRecoveryErrorHandledForTurn(
  state: GoalRecoveryMachineState,
  turnIndex: number | null,
): void {
  state.lastHandledErrorTurnIndex = turnIndex;
}

export function shouldSkipDuplicateRecoveryErrorHandling(
  state: GoalRecoveryMachineState,
  turnIndex: number | null,
): boolean {
  return turnIndex !== null && state.lastHandledErrorTurnIndex === turnIndex;
}

export function clearRecoveryErrorHandledTurn(state: GoalRecoveryMachineState): void {
  state.lastHandledErrorTurnIndex = null;
}

export function setRecoveryAttention(state: GoalRecoveryMachineState, reason: string): string {
  const message = recoveryAttentionMessage(reason);
  state.attention = message;
  return message;
}

export function planRecoveryForAssistantError(
  state: GoalRecoveryMachineState,
  message: AssistantErrorMessage,
  goalId: string,
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
    if (state.compactionInFlight) {
      return { type: "noop" };
    }
    return {
      type: "request_compaction",
      reason: "context window exceeded",
      scope: beginRecoveryCompactionRequest(state, goalId),
    };
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
  return {
    type: "schedule_retry",
    delayMs: transientErrorBackoffMs(state.counters.transientAttempts),
  };
}
