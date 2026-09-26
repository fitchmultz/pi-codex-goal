import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.ts";
import { createContinuationScheduler } from "./continuation-scheduler.ts";
import { assistantTurnTokensForToolCall, createGoalAccounting } from "./goal-accounting.ts";
import { createGoalPersistence } from "./goal-persistence.ts";
import {
  createGoalRuntimeEventHandlers,
  type GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handlers.ts";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.ts";
import { createGoalRuntimeState } from "./goal-runtime-state.ts";
import { createGoalRuntimeStatus, type StatusContext } from "./goal-runtime-status.ts";
import { createGoalStateController } from "./goal-state-controller.ts";
import { createProviderLimitAutoResumeScheduler } from "./provider-limit-auto-resume.ts";
import { compactContinuationPrompt } from "./prompts.ts";
import { createGoalRecoveryRuntime } from "./recovery-runtime.ts";
import {
  clearActiveHostOverflowRecovery,
  goalStartTurnStrategy,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
  type GoalStartTurnStrategy,
} from "./recovery-machine.ts";
import { goalWithLiveUsage, updateGoalStatus } from "./state.ts";
import { registerGoalTools } from "./tools.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

export interface GoalRuntimeController extends GoalRuntimeEventHandlers {
  getGoalForDisplay(): ThreadGoal | null;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  clearGoal(source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext, toolCallId: string): GoalResult;
  cancelProviderLimitAutoResume(goalId: string, ctx: StatusContext): void;
  resumeGoalWithContinuation(goalId: string, source: GoalEntrySource, ctx: StatusContext): GoalResult;
}

export function createGoalRuntimeController(pi: ExtensionAPI): GoalRuntimeController {
  const runtimeState = createGoalRuntimeState();
  const persistence = createGoalPersistence({ pi });

  const clearActiveAccounting = (): void => {
    runtimeState.accounting.activeGoalId = null;
    runtimeState.accounting.lastAccountedAt = null;
    runtimeState.accounting.lastSampledAt = null;
  };

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(runtimeState.recoveryState);
  };

  const goalForDisplay = () =>
    goalWithLiveUsage(
      persistence.getGoal(),
      runtimeState.accounting.activeGoalId,
      runtimeState.accounting.lastAccountedAt,
    );

  let autoResumeContext: ExtensionContext | null = null;
  const providerLimitAutoResume = createProviderLimitAutoResumeScheduler({
    onTimer(goalId) {
      if (!autoResumeContext || !autoResumeContext.isIdle() || autoResumeContext.hasPendingMessages()) {
        return false;
      }
      resumeGoalWithContinuation(goalId, "runtime", autoResumeContext);
      return true;
    },
  });

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention,
    isProviderLimitAutoResumeScheduled: providerLimitAutoResume.isScheduledFor,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
    getAgentRunSequence: () => runtimeState.agentRunSequence,
  });

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting,
      resetRecovery: resetErrorRecovery,
      clearBudgetWarning: () => {
        runtimeState.accounting.budgetWarningSentFor = null;
      },
      clearHostOverflowRecovery: () => {
        clearActiveHostOverflowRecovery(runtimeState.recoveryState);
      },
      setRecoveryPausedAttention: (reason: string) => {
        setRecoveryPausedAttention(runtimeState.recoveryState, reason);
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh(),
    },
    refreshUi: (ctx) => status.refreshUi(ctx),
  });

  const goalAccounting = createGoalAccounting({
    getGoal: () => stateController.getGoal(),
    getAccounting: () => runtimeState.accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal) {
      stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi),
  });

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, recoveryReason) {
      stateController.pauseForRecovery(ctx, recoveryReason);
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
    scheduleProviderLimitAutoResume(goalId, ctx) {
      autoResumeContext = ctx;
      providerLimitAutoResume.schedule(goalId);
      status.refreshUi(ctx);
    },
  });

  const resumeGoalWithContinuation = (
    goalId: string,
    _source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult => {
    const result = updateGoalStatus(stateController.getGoal(), "active");
    if (!result.ok || !result.goal || result.goal.goalId !== goalId) {
      return result;
    }
    providerLimitAutoResume.clear();
    stateController.resumePausedGoal(ctx);
    const resumedGoal = stateController.getGoal();
    if (resumedGoal?.status === "active" && resumedGoal.goalId === goalId) {
      pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
    }
    return result;
  };

  const eventHandlers = createGoalRuntimeEventHandlers({
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    providerLimitAutoResume,
    clearActiveAccounting,
    resetErrorRecovery,
    resumeGoalWithContinuation,
  });

  const completeGoal = (
    source: GoalEntrySource,
    ctx: ExtensionContext,
    toolCallId: string,
  ): GoalResult => {
    const goal = stateController.getGoal();
    if (goal && runtimeState.completionGoalId !== null && runtimeState.completionGoalId !== goal.goalId) {
      return {
        ok: false,
        message: "Goal changed while this response was running; inspect the current goal before marking it complete.",
        goal,
      };
    }
    providerLimitAutoResume.clear();
    const completedTurnTokens = assistantTurnTokensForToolCall(ctx.sessionManager.getBranch(), toolCallId);
    goalAccounting.accountProgress(ctx, false, completedTurnTokens, true);
    return stateController.completeGoal(source, ctx);
  };

  return {
    getGoalForDisplay: goalForDisplay,
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      providerLimitAutoResume.clear();
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
      // A tool-created goal is known to this response, unlike a concurrent /goal replacement.
      if (source === "tool") {
        runtimeState.completionGoalId = nextGoal.goalId;
      }
    },
    clearGoal(source, ctx) {
      providerLimitAutoResume.clear();
      stateController.applyGoalTransition({ kind: "clear", source }, ctx);
    },
    cancelProviderLimitAutoResume(_goalId, ctx) {
      providerLimitAutoResume.clear();
      status.refreshUi(ctx);
    },
    completeGoal,
    resumeGoalWithContinuation,
    ...eventHandlers,
  };
}

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    completeGoal: controller.completeGoal.bind(controller),
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    clearGoal: controller.clearGoal.bind(controller),
    cancelProviderLimitAutoResume: controller.cancelProviderLimitAutoResume.bind(controller),
    resumeGoalWithContinuation: controller.resumeGoalWithContinuation.bind(controller),
  });
  registerGoalRuntimeEvents(pi, controller);
}
