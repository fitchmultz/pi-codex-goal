import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { createContinuationScheduler } from "./continuation-scheduler.js";
import {
  assistantTurnTokens,
  createAccountingState,
  createGoalAccounting,
  isAbortedAssistantMessage,
  isToolUseAssistantMessage,
} from "./goal-accounting.js";
import { createGoalPersistence } from "./goal-persistence.js";
import { createGoalRuntimeStatus } from "./goal-runtime-status.js";
import { compactContinuationPrompt, continuationGoalIdFromPrompt } from "./prompts.js";
import { isCommandResumeQueuedGoalMessage } from "./queued-goal-messages.js";
import {
  applyQueuedGoalProviderContextRewrites,
  extensionQueuedGoalWorkMessageId,
  extensionQueuedGoalWorkMessageIdForRuntime,
} from "./queued-goal-work.js";
import { createGoalRecoveryRuntime } from "./recovery-runtime.js";
import {
  clearActiveHostOverflowRecovery,
  createGoalRecoveryMachine,
  goalStartTurnStrategy,
  recoveryPhaseBlocksContinuation,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isRecoveryPendingAttention,
  reasonFromRecoveryPendingAttention,
  type AssistantErrorMessage,
} from "./recovery.js";
import {
  createStaleQueuedWorkGuard,
  type StaleQueuedWorkEffect,
  type StaleQueuedWorkGuard,
} from "./stale-queued-work-guard.js";
import { goalWithLiveUsage, hostOverflowCapResetEntry, updateGoalStatus } from "./state.js";
import { registerGoalTools } from "./tools.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult } from "./types.js";

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const accounting = createAccountingState();
  let recoveryState: GoalRecoveryMachineState = createGoalRecoveryMachine();
  let currentTurnIndex: number | null = null;
  const staleQueuedWorkGuard: StaleQueuedWorkGuard = createStaleQueuedWorkGuard();

  const clearActiveAccounting = (): void => {
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(recoveryState);
  };

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => recoveryState,
    staleQueuedWorkGuard,
    getCurrentTurnIndex: () => currentTurnIndex,
  });

  const persistence = createGoalPersistence({
    pi,
    getRecoveryState: () => recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting,
      resetRecovery: resetErrorRecovery,
      clearBudgetWarning: () => {
        accounting.budgetWarningSentFor = null;
      },
      clearHostOverflowRecovery: () => {
        clearActiveHostOverflowRecovery(recoveryState);
      },
      setRecoveryPausedAttention: (reason: string) => {
        setRecoveryPausedAttention(recoveryState, reason);
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh(),
    },
    refreshUi: (ctx) => status.refreshUi(ctx),
    clearContinuationState: continuation.clearContinuationState,
    clearActiveAccounting,
    resetErrorRecovery,
  });

  const goalForDisplay = () =>
    goalWithLiveUsage(persistence.getGoal(), accounting.activeGoalId, accounting.lastAccountedAt);

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => recoveryState.attention,
  });

  const applyStaleQueuedWorkEffects = (
    effects: readonly StaleQueuedWorkEffect[],
    ctx: ExtensionContext,
  ): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "clearAccounting":
          clearActiveAccounting();
          break;
        case "refreshUi":
          status.refreshUi(ctx);
          break;
        case "abort":
          ctx.abort();
          break;
        default: {
          const _exhaustive: never = effect;
          throw new Error(`Unhandled stale queued-work effect: ${String(_exhaustive)}`);
        }
      }
    }
  };

  const queuedGoalWorkMessageIdForRuntime = (message: {
    role: string;
    customType?: string;
    details?: unknown;
    content?: unknown;
  }): string | null =>
    extensionQueuedGoalWorkMessageIdForRuntime(
      message,
      continuation.continuationGoalIdFromRuntimePrompt,
    );

  const goalAccounting = createGoalAccounting({
    getGoal: () => persistence.getGoal(),
    getAccounting: () => accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal) {
      persistence.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi),
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    goalAccounting.accountProgress(ctx, false, 0, true);
    return persistence.completeGoal(source, ctx);
  };

  const getContextWindow = (ctx: ExtensionContext): number => ctx.model?.contextWindow ?? 0;

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, activeGoal, recoveryReason) {
      const result = updateGoalStatus(activeGoal, "paused");
      if (!result.ok || !result.goal) {
        return;
      }
      persistence.applyGoalTransition(
        { kind: "recovery_pause", nextGoal: result.goal, recoveryReason },
        ctx,
      );
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
  });

  const hasPendingRecoveryAttention = (): boolean => {
    const goal = persistence.getGoal();
    return Boolean(goal?.status === "active" && isRecoveryPendingAttention(recoveryState.attention));
  };

  const pauseForPendingRecoveryShutdown = (ctx: ExtensionContext): void => {
    const goal = persistence.getGoal();
    if (!goal || goal.status !== "active" || !recoveryState.attention) {
      return;
    }

    const reason = reasonFromRecoveryPendingAttention(recoveryState.attention);
    if (!reason) {
      return;
    }

    const result = updateGoalStatus(goal, "paused");
    if (!result.ok || !result.goal) {
      return;
    }

    persistence.applyGoalTransition(
      {
        kind: "recovery_shutdown_pause",
        nextGoal: result.goal,
        recoveryReason: reason,
      },
      ctx,
    );
  };

  const beginOverflowRecoveryAttention = (ctx: ExtensionContext): void => {
    if (recoveryRuntime.beginOverflowRecovery(ctx)) {
      pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(true));
    }
  };

  const recordAssistantContextOverflow = (
    message: AssistantErrorMessage,
    ctx: ExtensionContext,
  ): boolean => {
    if (!isAssistantContextOverflow(message, getContextWindow(ctx))) {
      return false;
    }

    beginOverflowRecoveryAttention(ctx);
    if (isErrorAssistantMessage(message)) {
      recoveryRuntime.handlePersistentAssistantError(message, ctx);
    } else {
      recoveryRuntime.handleSilentContextOverflow(ctx);
    }
    return true;
  };

  registerGoalTools(pi, {
    getGoal: () => goalForDisplay(),
    setGoal(nextGoal, source, ctx) {
      persistence.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    completeGoal,
  });

  registerGoalCommand(pi, {
    getGoal: () => goalForDisplay(),
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      persistence.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    clearGoal(source, ctx) {
      persistence.applyGoalTransition({ kind: "clear", source }, ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    continuation.clearPassthroughContinuationInput();
    const continuationGoalId = continuationGoalIdFromPrompt(event.text);

    if (event.source !== "extension") {
      recoveryRuntime.onUserInput();
      applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planUserInputClearAbort().effects, ctx);
      if (continuationGoalId !== null) {
        continuation.notePassthroughContinuationInput(event.text);
      }
      return undefined;
    }

    if (continuationGoalId === null) {
      return undefined;
    }

    applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects, ctx);
    continuation.clearContinuationStateFor(continuationGoalId);
    if (persistence.isCurrentActiveGoalId(continuationGoalId)) {
      return { action: "continue" } as const;
    }

    status.refreshUi(ctx);
    return { action: "handled" } as const;
  });

  pi.on("context", async (event, ctx): Promise<{ messages: typeof event.messages } | undefined> => {
    const { messages, changed } = applyQueuedGoalProviderContextRewrites(event.messages, {
      goal: persistence.getGoal(),
      resolveStaleQueuedGoalWorkMessageId: queuedGoalWorkMessageIdForRuntime,
      resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
    });

    const contextAbortPlan = staleQueuedWorkGuard.planContextAbort(currentTurnIndex);
    if (contextAbortPlan !== null) {
      applyStaleQueuedWorkEffects(contextAbortPlan.effects, ctx);
    }

    return changed ? { messages } : undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    persistence.reloadFromSession(ctx);
    goalAccounting.beginAccounting();
    const goal = persistence.getGoal();
    const pausedGoal = goal?.status === "paused" ? goal : null;
    if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
      const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${pausedGoal.objective}`);
      if (shouldResume) {
        persistence.resumePausedGoal(ctx);
        goalAccounting.beginAccounting();
        const resumedGoal = persistence.getGoal();
        if (resumedGoal?.status === "active") {
          pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
        }
        return;
      }
    }
    continuation.maybeContinue(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    persistence.reloadFromSession(ctx);
    goalAccounting.beginAccounting();
    continuation.maybeContinue(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const continuationGoalId = continuation.continuationGoalIdFromRuntimePrompt(_event.prompt);
    if (continuationGoalId !== null) {
      continuation.clearContinuationStateFor(continuationGoalId);
      if (!persistence.isCurrentActiveGoalId(continuationGoalId)) {
        status.refreshUi(ctx);
        return undefined;
      }
      applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx);
    } else {
      applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx);
      continuation.clearContinuationState();
    }
  });

  pi.on("message_start", async (event) => {
    if (event.message.role === "user") {
      persistence.persistHostOverflowUserReset(false);
    }

    const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
    if (queuedGoalId === null) {
      if (event.message.role === "user" || event.message.role === "custom") {
        staleQueuedWorkGuard.noteRunnableWorkStarted();
        continuation.clearContinuationState();
      }
      return;
    }

    continuation.clearContinuationStateFor(queuedGoalId);
    if (persistence.isCurrentActiveGoalId(queuedGoalId)) {
      staleQueuedWorkGuard.noteRunnableWorkStarted();
      if (isCommandResumeQueuedGoalMessage(event.message)) {
        resetErrorRecovery();
      }
      return;
    }

    staleQueuedWorkGuard.noteStaleWorkStarted(queuedGoalId);
  });

  pi.on("turn_start", async (_event, ctx) => {
    currentTurnIndex = _event.turnIndex;
    continuation.bindPassthroughContinuationInputToTurn(_event.turnIndex);
    applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planTurnStart().effects, ctx);
    goalAccounting.beginAccounting();
    status.refreshUi(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    const toolEndPlan = staleQueuedWorkGuard.planToolExecutionEnd();
    applyStaleQueuedWorkEffects(toolEndPlan.effects, ctx);
    if (toolEndPlan.skip) {
      return;
    }

    goalAccounting.accountProgress(ctx, true, 0, true);
    persistence.maybeFlushRuntimePersistence("runtime");
  });

  pi.on("turn_end", async (_event, ctx) => {
    const turnEndPlan = staleQueuedWorkGuard.planTurnEnd(_event.turnIndex, _event.message);
    applyStaleQueuedWorkEffects(turnEndPlan.effects, ctx);
    if (turnEndPlan.skip) {
      return;
    }

    const completedTurnTokens = assistantTurnTokens(_event.message);
    goalAccounting.accountProgress(ctx, true, completedTurnTokens);
    persistence.flushGoalPersistence("runtime");
    if (isAbortedAssistantMessage(_event.message)) {
      persistence.pauseForAbort(ctx);
      return;
    }
    if (isErrorAssistantMessage(_event.message)) {
      return;
    }
    if (isAssistantContextOverflow(_event.message, getContextWindow(ctx))) {
      beginOverflowRecoveryAttention(ctx);
      return;
    }
    recoveryRuntime.finishSuccessfulAssistantTurn(_event.message, ctx, {
      continueGoal: !isToolUseAssistantMessage(_event.message),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    continuation.clearPassthroughContinuationInput();
    const agentEndPlan = staleQueuedWorkGuard.planAgentEnd(event.messages);
    applyStaleQueuedWorkEffects(agentEndPlan.effects, ctx);
    if (agentEndPlan.skip) {
      return;
    }

    const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
    const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
      return sum + assistantTurnTokens(message);
    }, 0);
    goalAccounting.accountProgress(ctx, false, abortedTurnTokens, true);
    persistence.flushGoalPersistence("runtime");
    if (abortedMessages.length > 0) {
      persistence.pauseForAbort(ctx);
      return;
    }
    const errorMessages = event.messages.filter(isErrorAssistantMessage);
    if (errorMessages.length > 0) {
      const lastError = errorMessages.at(-1) as AssistantErrorMessage | undefined;
      if (lastError) {
        recordAssistantContextOverflow(lastError, ctx);
        if (!isContextOverflowError(lastError.errorMessage)) {
          recoveryRuntime.handlePersistentAssistantError(lastError, ctx);
        }
      }
      return;
    }

    const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant && recordAssistantContextOverflow(lastAssistant as AssistantErrorMessage, ctx)) {
      return;
    }
    resetErrorRecovery();
    continuation.maybeContinue(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const compactPlan = staleQueuedWorkGuard.planSessionBeforeCompact();
    applyStaleQueuedWorkEffects(compactPlan.effects, ctx);
    if (compactPlan.skip) {
      return;
    }

    goalAccounting.accountProgress(ctx, false, 0, true);
    persistence.flushGoalPersistence("runtime");
  });

  pi.on("session_compact", async (_event, ctx) => {
    const compactPlan = staleQueuedWorkGuard.planSessionCompact();
    applyStaleQueuedWorkEffects(compactPlan.effects, ctx);
    if (compactPlan.skip) {
      return;
    }

    persistence.flushGoalPersistence("runtime");
    recoveryRuntime.onSessionCompact();
    status.refreshUi(ctx);
    if (!recoveryPhaseBlocksContinuation(recoveryState.phase)) {
      continuation.maybeContinue(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    continuation.clearPassthroughContinuationInput();
    applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planSessionShutdown().effects, ctx);

    goalAccounting.accountProgress(ctx, false, 0, true);
    persistence.flushGoalPersistence("runtime");
    continuation.clearContinuationTimer();
    if (hasPendingRecoveryAttention()) {
      pauseForPendingRecoveryShutdown(ctx);
    } else {
      resetErrorRecovery();
    }
    status.stopStatusRefresh();
  });
}
