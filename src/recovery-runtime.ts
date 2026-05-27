import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  beginHostOverflowRecovery,
  onRecoverySessionCompact,
  onRecoverySuccessfulTurn,
  onRecoveryUserInput,
  planRecoveryForAssistantError,
  planRecoveryForSilentContextOverflow,
  requireHostOverflowUserReset,
  setRecoveryPausedAttention,
  setRecoveryPendingAttention,
  type GoalRecoveryMachineState,
  type RecoveryAction,
} from "./recovery-machine.js";
import type { AssistantErrorMessage } from "./recovery.js";
import type { ThreadGoal } from "./types.js";

interface RecoveryRuntimeDeps {
  getGoal: () => ThreadGoal | null;
  getRecoveryState: () => GoalRecoveryMachineState;
  clearContinuationState: () => void;
  pauseGoalForRecovery: (ctx: ExtensionContext, pausedGoal: ThreadGoal) => void;
  refreshUi: (ctx: ExtensionContext) => void;
  maybeContinue: (ctx: ExtensionContext) => void;
}

export function createGoalRecoveryRuntime(deps: RecoveryRuntimeDeps) {
  const pauseForRecoveryAttention = (ctx: ExtensionContext, reason: string): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    deps.clearContinuationState();
    deps.pauseGoalForRecovery(ctx, goal);
    setRecoveryPausedAttention(deps.getRecoveryState(), reason);
    deps.refreshUi(ctx);
  };

  const applyRecoveryAction = (action: RecoveryAction, ctx: ExtensionContext): void => {
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

  const handlePersistentAssistantError = (message: AssistantErrorMessage, ctx: ExtensionContext): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    applyRecoveryAction(planRecoveryForAssistantError(deps.getRecoveryState(), message), ctx);
  };

  const handleSilentContextOverflow = (ctx: ExtensionContext): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    applyRecoveryAction(planRecoveryForSilentContextOverflow(deps.getRecoveryState()), ctx);
  };

  const beginOverflowRecovery = (ctx: ExtensionContext): boolean => {
    const goal = deps.getGoal();
    const hasActiveGoal = Boolean(goal && goal.status === "active");

    if (hasActiveGoal) {
      deps.clearContinuationState();
      const { persistHostOverflowCapReset } = beginHostOverflowRecovery(deps.getRecoveryState());
      deps.refreshUi(ctx);
      return persistHostOverflowCapReset;
    }

    return requireHostOverflowUserReset(deps.getRecoveryState());
  };

  const finishSuccessfulAssistantTurn = (
    message: AssistantErrorMessage,
    ctx: ExtensionContext,
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
    beginOverflowRecovery,
    handlePersistentAssistantError,
    handleSilentContextOverflow,
    finishSuccessfulAssistantTurn,
  };
}
