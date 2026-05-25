import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  beginHostOverflowRecovery,
  onRecoverySessionCompact,
  onRecoverySuccessfulTurn,
  onRecoveryUserInput,
  planRecoveryForAssistantError,
  planRecoveryForSilentContextOverflow,
  resetRecoveryMachine,
  setRecoveryAttention,
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
  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(deps.getRecoveryState());
  };

  const pauseForRecoveryAttention = (ctx: ExtensionContext, reason: string): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    deps.clearContinuationState();
    deps.pauseGoalForRecovery(ctx, goal);
    setRecoveryAttention(deps.getRecoveryState(), reason);
    deps.refreshUi(ctx);
  };

  const applyRecoveryAction = (action: RecoveryAction, ctx: ExtensionContext): void => {
    switch (action.type) {
      case "noop":
        return;
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

  const beginOverflowRecovery = (ctx: ExtensionContext): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    deps.clearContinuationState();
    beginHostOverflowRecovery(deps.getRecoveryState());
    deps.refreshUi(ctx);
  };

  const finishSuccessfulAssistantTurn = (
    message: AssistantErrorMessage,
    ctx: ExtensionContext,
    options?: { continueGoal?: boolean },
  ): void => {
    if (onRecoverySuccessfulTurn(deps.getRecoveryState(), message) && options?.continueGoal !== false) {
      deps.maybeContinue(ctx);
    }
  };

  return {
    resetErrorRecovery,
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
