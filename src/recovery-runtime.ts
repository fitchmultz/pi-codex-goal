import {
  onRecoverySessionCompact,
  onRecoverySuccessfulTurn,
  onRecoveryUserInput,
  planRecoveryForAssistantError,
  planRecoveryForSilentContextOverflow,
  setRecoveryPendingAttention,
  type GoalRecoveryMachineState,
  type RecoveryAction,
} from "./recovery-machine.ts";
import { isProviderLimitError, type AssistantErrorMessage } from "./recovery.ts";
import type { ThreadGoal } from "./types.ts";

interface RecoveryRuntimeDeps<TContext> {
  getGoal: () => ThreadGoal | null;
  getRecoveryState: () => GoalRecoveryMachineState;
  clearContinuationState: () => void;
  pauseGoalForRecovery: (ctx: TContext, recoveryReason: string) => void;
  refreshUi: (ctx: TContext) => void;
  maybeContinue: (ctx: TContext) => void;
  scheduleProviderLimitAutoResume: (goalId: string, ctx: TContext) => void;
}

export function createGoalRecoveryRuntime<TContext>(deps: RecoveryRuntimeDeps<TContext>) {
  const pauseForRecoveryAttention = (ctx: TContext, reason: string): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    deps.pauseGoalForRecovery(ctx, reason);
  };

  const applyRecoveryAction = (action: RecoveryAction, ctx: TContext): void => {
    switch (action.type) {
      case "noop":
        return;
      case "pending": {
        const goal = deps.getGoal();
        if (!goal || goal.status !== "active") {
          return;
        }
        deps.clearContinuationState();
        setRecoveryPendingAttention(deps.getRecoveryState(), action.reason);
        deps.refreshUi(ctx);
        return;
      }
      case "pause":
        pauseForRecoveryAttention(ctx, action.reason);
        return;
    }
  };

  const handlePersistentAssistantError = (message: AssistantErrorMessage, ctx: TContext): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    const wasProviderLimit = isProviderLimitError(message.errorMessage);
    const action = planRecoveryForAssistantError(deps.getRecoveryState(), message);
    applyRecoveryAction(action, ctx);
    const currentGoal = deps.getGoal();
    if (
      wasProviderLimit &&
      action.type === "pause" &&
      currentGoal?.goalId === goal.goalId &&
      currentGoal.status === "paused"
    ) {
      deps.scheduleProviderLimitAutoResume(currentGoal.goalId, ctx);
    }
  };

  const handleSilentContextOverflow = (ctx: TContext): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    applyRecoveryAction(planRecoveryForSilentContextOverflow(deps.getRecoveryState()), ctx);
  };

  const finishSuccessfulAssistantTurn = (
    message: AssistantErrorMessage,
    ctx: TContext,
    options?: { continueGoal?: boolean },
  ): void => {
    if (onRecoverySuccessfulTurn(deps.getRecoveryState(), message)) {
      deps.refreshUi(ctx);
      if (options?.continueGoal !== false) {
        deps.maybeContinue(ctx);
      }
    }
  };

  return {
    onUserInput: () => {
      onRecoveryUserInput(deps.getRecoveryState());
    },
    onSessionCompact: () => {
      onRecoverySessionCompact(deps.getRecoveryState());
    },
    handlePersistentAssistantError,
    handleSilentContextOverflow,
    finishSuccessfulAssistantTurn,
  };
}
