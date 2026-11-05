import {
  applyPersistedHostOverflowUserReset,
  clearHostOverflowRecoveryActive,
  hostOverflowRecoveringNeedsUserStartPhase,
  idleRecoveryPhase,
  recoveryPhaseNeedsUserStartTurn,
  type RecoveryPhase,
} from "./recovery-phase.ts";
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
  createRecoveryPausedAttention,
  createRecoveryPendingAttention,
  isRecoveryPendingAttention,
  type AssistantErrorMessage,
  type ErrorRecoveryCounters,
  type RecoveryAttention,
} from "./recovery.ts";

export type { RecoveryPhase } from "./recovery-phase.ts";
export {
  recoveryPhaseBlocksContinuation,
  recoveryPhaseNeedsUserStartTurn,
} from "./recovery-phase.ts";

export type RecoveryAction =
  | { type: "noop" }
  | { type: "pending"; reason: string }
  | { type: "pause"; reason: string };

export class GoalRecoveryMachineState {
  counters: ErrorRecoveryCounters = createErrorRecoveryCounters();
  attention: RecoveryAttention | null = null;
  phase: RecoveryPhase = idleRecoveryPhase;

  resetRecoveryMachine(): void {
    this.counters = createErrorRecoveryCounters();
    this.attention = null;
    this.clearActiveHostOverflowRecovery();
  }

  resetRecoveryCounters(): void {
    this.counters = createErrorRecoveryCounters();
    this.attention = null;
  }

  onRecoveryUserInput(): void {
    this.resetRecoveryMachine();
  }

  onRecoverySuccessfulTurn(message: AssistantErrorMessage): boolean {
    if (!isSuccessfulAssistantTurn(message)) {
      return false;
    }
    this.resetRecoveryCounters();
    return true;
  }

  onRecoverySessionCompact(): void {
    const attention = this.attention;
    if (
      isRecoveryPendingAttention(attention) &&
      attention.reason === HOST_OVERFLOW_RECOVERY_REASON
    ) {
      this.attention = null;
    }

    if (this.counters.compactionAttempts > 0) {
      this.counters = {
        ...this.counters,
        transientAttempts: 0,
      };
    }
  }

  setRecoveryPendingAttention(reason: string): RecoveryAttention {
    const attention = createRecoveryPendingAttention(reason);
    this.attention = attention;
    return attention;
  }

  setRecoveryPausedAttention(reason: string): RecoveryAttention {
    const attention = createRecoveryPausedAttention(reason);
    this.attention = attention;
    return attention;
  }

  clearActiveHostOverflowRecovery(): void {
    this.phase = clearHostOverflowRecoveryActive(this.phase);
  }

  applyHostOverflowUserResetPersistence(needsUserReset: boolean): boolean {
    if (recoveryPhaseNeedsUserStartTurn(this.phase) === needsUserReset) {
      return false;
    }
    this.phase = applyPersistedHostOverflowUserReset(this.phase, needsUserReset);
    return true;
  }

  syncHostOverflowUserResetFromSession(needsUserReset: boolean): void {
    this.phase = applyPersistedHostOverflowUserReset(this.phase, needsUserReset);
  }

  requireHostOverflowUserReset(): boolean {
    const persistHostOverflowCapReset = !recoveryPhaseNeedsUserStartTurn(this.phase);
    this.phase = applyPersistedHostOverflowUserReset(this.phase, true);
    return persistHostOverflowCapReset;
  }

  beginHostOverflowRecovery(needsUserReset = true): {
    attention: RecoveryAttention;
    persistHostOverflowCapReset: boolean;
  } {
    const persistHostOverflowCapReset =
      recoveryPhaseNeedsUserStartTurn(this.phase) !== needsUserReset;
    this.phase = needsUserReset
      ? hostOverflowRecoveringNeedsUserStartPhase()
      : { kind: "hostOverflowRecovering" };
    const attention = this.setRecoveryPendingAttention(HOST_OVERFLOW_RECOVERY_REASON);
    return { attention, persistHostOverflowCapReset };
  }

  private incrementOverflowCompactionAttempts(): RecoveryAction {
    this.counters = {
      ...this.counters,
      signature: CONTEXT_OVERFLOW_SIGNATURE,
      compactionAttempts: this.counters.compactionAttempts + 1,
    };
    if (this.counters.compactionAttempts > MAX_CONTEXT_COMPACTION_RETRIES) {
      return {
        type: "pause",
        reason: "context window recovery failed after repeated compaction attempts",
      };
    }
    return { type: "noop" };
  }

  planRecoveryForAssistantError(message: AssistantErrorMessage): RecoveryAction {
    if (isContextOverflowError(message.errorMessage, message.provider)) {
      return this.incrementOverflowCompactionAttempts();
    }

    const signature = failureSignature(message.errorMessage);
    this.counters = countersForFailureSignature(this.counters, signature);

    if (!isRetryableTransientError(message.errorMessage)) {
      return {
        type: "pause",
        reason: `non-retryable provider error (${signature})`,
      };
    }

    this.counters = {
      ...this.counters,
      transientAttempts: this.counters.transientAttempts + 1,
    };
    return {
      type: "pending",
      reason: `provider error (${signature})`,
    };
  }

  planRecoveryForSilentContextOverflow(): RecoveryAction {
    return this.incrementOverflowCompactionAttempts();
  }
}

export function createGoalRecoveryMachine(): GoalRecoveryMachineState {
  return new GoalRecoveryMachineState();
}

export function isRepeatOverflowCompactionDue(state: GoalRecoveryMachineState): boolean {
  return state.counters.compactionAttempts >= MAX_CONTEXT_COMPACTION_RETRIES;
}
