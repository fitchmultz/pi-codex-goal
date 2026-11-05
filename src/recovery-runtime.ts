import type { GoalRecoveryMachineState, RecoveryAction } from "./recovery-machine.ts";
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

interface GoalRecoveryRuntime<TContext> {
  onUserInput: () => void;
  onSessionCompact: () => void;
  handlePersistentAssistantError: (message: AssistantErrorMessage, ctx: TContext) => void;
  handleSilentContextOverflow: (ctx: TContext) => void;
  finishSuccessfulAssistantTurn: (
    message: AssistantErrorMessage,
    ctx: TContext,
    options?: { continueGoal?: boolean },
  ) => void;
}

export function createGoalRecoveryRuntime<TContext>(
  deps: RecoveryRuntimeDeps<TContext>,
): GoalRecoveryRuntime<TContext> {
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
        deps.getRecoveryState().setRecoveryPendingAttention(action.reason);
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
    const action = deps.getRecoveryState().planRecoveryForAssistantError(message);
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

    applyRecoveryAction(deps.getRecoveryState().planRecoveryForSilentContextOverflow(), ctx);
  };

  const finishSuccessfulAssistantTurn = (
    message: AssistantErrorMessage,
    ctx: TContext,
    options?: { continueGoal?: boolean },
  ): void => {
    if (deps.getRecoveryState().onRecoverySuccessfulTurn(message)) {
      deps.refreshUi(ctx);
      if (options?.continueGoal !== false) {
        deps.maybeContinue(ctx);
      }
    }
  };

  return {
    onUserInput: (): void => {
      deps.getRecoveryState().onRecoveryUserInput();
    },
    onSessionCompact: (): void => {
      deps.getRecoveryState().onRecoverySessionCompact();
    },
    handlePersistentAssistantError,
    handleSilentContextOverflow,
    finishSuccessfulAssistantTurn,
  };
}
