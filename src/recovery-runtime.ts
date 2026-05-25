import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  clearRecoveryErrorHandledTurn,
  completeRecoveryCompactionRequest,
  failRecoveryCompactionRequest,
  isRecoveryCompactionScopeActive,
  markRecoveryErrorHandledForTurn,
  onRecoverySessionCompact,
  onRecoverySuccessfulTurn,
  onRecoveryUserInput,
  planRecoveryForAssistantError,
  resetRecoveryMachine,
  setRecoveryAttention,
  shouldSkipDuplicateRecoveryErrorHandling,
  type GoalRecoveryMachineState,
  type RecoveryAction,
  type RecoveryCompactionScope,
} from "./recovery-machine.js";
import type { AssistantErrorMessage } from "./recovery.js";
import type { ThreadGoal } from "./types.js";

interface RecoveryRuntimeDeps {
  getGoal: () => ThreadGoal | null;
  getRecoveryState: () => GoalRecoveryMachineState;
  clearContinuationState: () => void;
  clearErrorRecoveryTimer: () => void;
  setErrorRecoveryTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  pauseGoalForRecovery: (ctx: ExtensionContext, pausedGoal: ThreadGoal) => void;
  refreshUi: (ctx: ExtensionContext) => void;
  maybeContinue: (ctx: ExtensionContext) => void;
}

export function createGoalRecoveryRuntime(deps: RecoveryRuntimeDeps) {
  const resetErrorRecovery = (): void => {
    deps.clearErrorRecoveryTimer();
    resetRecoveryMachine(deps.getRecoveryState());
  };

  const pauseForRecoveryAttention = (ctx: ExtensionContext, reason: string): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    deps.clearContinuationState();
    deps.clearErrorRecoveryTimer();
    failRecoveryCompactionRequest(deps.getRecoveryState());
    deps.pauseGoalForRecovery(ctx, goal);
    setRecoveryAttention(deps.getRecoveryState(), reason);
    deps.refreshUi(ctx);
  };

  const requestContextCompaction = (
    ctx: ExtensionContext,
    reason: string,
    scope: RecoveryCompactionScope,
  ): void => {
    if (typeof ctx.compact !== "function") {
      pauseForRecoveryAttention(ctx, reason);
      return;
    }

    ctx.compact({
      onComplete: () => {
        if (!isRecoveryCompactionScopeActive(deps.getRecoveryState(), scope, deps.getGoal()?.goalId ?? null)) {
          return;
        }
        completeRecoveryCompactionRequest(deps.getRecoveryState());
      },
      onError: (error) => {
        if (!isRecoveryCompactionScopeActive(deps.getRecoveryState(), scope, deps.getGoal()?.goalId ?? null)) {
          return;
        }
        failRecoveryCompactionRequest(deps.getRecoveryState());
        pauseForRecoveryAttention(ctx, `${reason}: ${error.message}`);
      },
    });
  };

  const scheduleTransientErrorRetry = (ctx: ExtensionContext, delayMs: number): void => {
    deps.clearErrorRecoveryTimer();
    const timer = setTimeout(() => {
      deps.setErrorRecoveryTimer(null);
      deps.maybeContinue(ctx);
    }, delayMs);
    timer.unref?.();
    deps.setErrorRecoveryTimer(timer);
  };

  const applyRecoveryAction = (action: RecoveryAction, ctx: ExtensionContext): void => {
    switch (action.type) {
      case "noop":
        return;
      case "request_compaction":
        requestContextCompaction(ctx, action.reason, action.scope);
        return;
      case "schedule_retry":
        scheduleTransientErrorRetry(ctx, action.delayMs);
        return;
      case "pause":
        pauseForRecoveryAttention(ctx, action.reason);
        return;
    }
  };

  const handleAssistantError = (
    message: AssistantErrorMessage,
    ctx: ExtensionContext,
    turnIndex: number | null,
  ): void => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    markRecoveryErrorHandledForTurn(deps.getRecoveryState(), turnIndex);
    applyRecoveryAction(planRecoveryForAssistantError(deps.getRecoveryState(), message, goal.goalId), ctx);
  };

  const finishSuccessfulAssistantTurn = (message: AssistantErrorMessage, ctx: ExtensionContext): void => {
    if (onRecoverySuccessfulTurn(deps.getRecoveryState(), message)) {
      deps.clearErrorRecoveryTimer();
    }
    deps.maybeContinue(ctx);
  };

  return {
    resetErrorRecovery,
    onUserInput: () => {
      onRecoveryUserInput(deps.getRecoveryState());
      deps.clearErrorRecoveryTimer();
    },
    onSessionCompact: () => {
      onRecoverySessionCompact(deps.getRecoveryState());
    },
    clearHandledErrorTurn: () => {
      clearRecoveryErrorHandledTurn(deps.getRecoveryState());
    },
    shouldSkipDuplicateAgentEndError: (turnIndex: number | null) =>
      shouldSkipDuplicateRecoveryErrorHandling(deps.getRecoveryState(), turnIndex),
    handleAssistantError,
    finishSuccessfulAssistantTurn,
  };
}
