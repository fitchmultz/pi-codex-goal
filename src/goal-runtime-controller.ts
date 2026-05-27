import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { createContinuationScheduler } from "./continuation-scheduler.js";
import {
  assistantTurnTokens,
  createGoalAccounting,
  isAbortedAssistantMessage,
  isToolUseAssistantMessage,
} from "./goal-accounting.js";
import { createGoalPersistence } from "./goal-persistence.js";
import { createGoalRuntimeStatus } from "./goal-runtime-status.js";
import { createGoalRuntimeState } from "./goal-runtime-state.js";
import { createGoalStateController } from "./goal-state-controller.js";
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
  goalStartTurnStrategy,
  recoveryPhaseBlocksContinuation,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
} from "./recovery-machine.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isRecoveryPendingAttention,
  reasonFromRecoveryPendingAttention,
  type AssistantErrorMessage,
} from "./recovery.js";
import type { StaleQueuedWorkEffect } from "./stale-queued-work-guard.js";
import { goalWithLiveUsage, hostOverflowCapResetEntry, updateGoalStatus } from "./state.js";
import { registerGoalTools } from "./tools.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult } from "./types.js";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.js";

export function createGoalRuntimeController(pi: ExtensionAPI) {
  const runtimeState = createGoalRuntimeState();
  const persistence = createGoalPersistence({ pi });

  const clearActiveAccounting = (): void => {
    runtimeState.accounting.activeGoalId = null;
    runtimeState.accounting.lastAccountedAt = null;
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

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
  });

  const transitionEffectHandlers = {
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
  };

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers,
    refreshUi: (ctx) => status.refreshUi(ctx),
    clearContinuationState: continuation.clearContinuationState,
    clearActiveAccounting,
    resetErrorRecovery,
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
    getGoal: () => stateController.getGoal(),
    getAccounting: () => runtimeState.accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal) {
      stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi),
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.completeGoal(source, ctx);
  };

  const getContextWindow = (ctx: ExtensionContext): number => ctx.model?.contextWindow ?? 0;

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, activeGoal, recoveryReason) {
      const result = updateGoalStatus(activeGoal, "paused");
      if (!result.ok || !result.goal) {
        return;
      }
      stateController.applyGoalTransition(
        { kind: "recovery_pause", nextGoal: result.goal, recoveryReason },
        ctx,
      );
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
  });

  const hasPendingRecoveryAttention = (): boolean => {
    const goal = stateController.getGoal();
    return Boolean(
      goal?.status === "active" && isRecoveryPendingAttention(runtimeState.recoveryState.attention),
    );
  };

  const pauseForPendingRecoveryShutdown = (ctx: ExtensionContext): void => {
    const goal = stateController.getGoal();
    if (!goal || goal.status !== "active" || !runtimeState.recoveryState.attention) {
      return;
    }

    const reason = reasonFromRecoveryPendingAttention(runtimeState.recoveryState.attention);
    if (!reason) {
      return;
    }

    const result = updateGoalStatus(goal, "paused");
    if (!result.ok || !result.goal) {
      return;
    }

    stateController.applyGoalTransition(
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
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    completeGoal,
  });

  registerGoalCommand(pi, {
    getGoal: () => goalForDisplay(),
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    clearGoal(source, ctx) {
      stateController.applyGoalTransition({ kind: "clear", source }, ctx);
    },
  });

  return {
    onInput: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      const continuationGoalId = continuationGoalIdFromPrompt(event.text);

      if (event.source !== "extension") {
        recoveryRuntime.onUserInput();
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects,
          ctx,
        );
        if (continuationGoalId !== null) {
          continuation.notePassthroughContinuationInput(event.text);
        }
        return undefined;
      }

      if (continuationGoalId === null) {
        return undefined;
      }

      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects,
        ctx,
      );
      continuation.clearContinuationStateFor(continuationGoalId);
      if (stateController.isCurrentActiveGoalId(continuationGoalId)) {
        return { action: "continue" } as const;
      }

      status.refreshUi(ctx);
      return { action: "handled" } as const;
    }) satisfies ExtensionHandler<InputEvent, InputEventResult>,

    onContext: (async (event, ctx) => {
      const { messages, changed } = applyQueuedGoalProviderContextRewrites(event.messages, {
        goal: stateController.getGoal(),
        resolveStaleQueuedGoalWorkMessageId: queuedGoalWorkMessageIdForRuntime,
        resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
      });

      const contextAbortPlan = runtimeState.staleQueuedWorkGuard.planContextAbort(
        runtimeState.currentTurnIndex,
      );
      if (contextAbortPlan !== null) {
        applyStaleQueuedWorkEffects(contextAbortPlan.effects, ctx);
      }

      return changed ? { messages } : undefined;
    }) satisfies ExtensionHandler<ContextEvent, { messages?: ContextEvent["messages"] } | undefined>,

    onSessionStart: (async (event, ctx) => {
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      const goal = stateController.getGoal();
      const pausedGoal = goal?.status === "paused" ? goal : null;
      if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
        const shouldResume = await ctx.ui.confirm(
          "Resume paused goal?",
          `Goal: ${pausedGoal.objective}`,
        );
        if (shouldResume) {
          stateController.resumePausedGoal(ctx);
          goalAccounting.beginAccounting();
          const resumedGoal = stateController.getGoal();
          if (resumedGoal?.status === "active") {
            pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
          }
          return;
        }
      }
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionStartEvent>,

    onSessionTree: (async (_event, ctx) => {
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onBeforeAgentStart: (async (event, ctx) => {
      const continuationGoalId = continuation.continuationGoalIdFromRuntimePrompt(event.prompt);
      if (continuationGoalId !== null) {
        continuation.clearContinuationStateFor(continuationGoalId);
        if (!stateController.isCurrentActiveGoalId(continuationGoalId)) {
          status.refreshUi(ctx);
          return undefined;
        }
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
          ctx,
        );
      } else {
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
          ctx,
        );
        continuation.clearContinuationState();
      }
      return undefined;
    }) satisfies ExtensionHandler<BeforeAgentStartEvent, undefined>,

    onMessageStart: (async (event) => {
      if (event.message.role === "user") {
        stateController.persistHostOverflowUserReset(false);
      }

      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
      if (queuedGoalId === null) {
        if (event.message.role === "user" || event.message.role === "custom") {
          runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
          continuation.clearContinuationState();
        }
        return;
      }

      continuation.clearContinuationStateFor(queuedGoalId);
      if (stateController.isCurrentActiveGoalId(queuedGoalId)) {
        runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
        if (isCommandResumeQueuedGoalMessage(event.message)) {
          resetErrorRecovery();
        }
        return;
      }

      runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(queuedGoalId);
    }) satisfies ExtensionHandler<{ type: "message_start"; message: TurnEndEvent["message"] }>,

    onTurnStart: (async (event, ctx) => {
      runtimeState.currentTurnIndex = event.turnIndex;
      continuation.bindPassthroughContinuationInputToTurn(event.turnIndex);
      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planTurnStart().effects,
        ctx,
      );
      goalAccounting.beginAccounting();
      status.refreshUi(ctx);
    }) satisfies ExtensionHandler<TurnStartEvent>,

    onToolExecutionEnd: (async (_event, ctx) => {
      const toolEndPlan = runtimeState.staleQueuedWorkGuard.planToolExecutionEnd();
      applyStaleQueuedWorkEffects(toolEndPlan.effects, ctx);
      if (toolEndPlan.skip) {
        return;
      }

      goalAccounting.accountProgress(ctx, true, 0, true);
      stateController.maybeFlushRuntimePersistence("runtime");
    }) satisfies ExtensionHandler<{ type: "tool_execution_end" }>,

    onTurnEnd: (async (event, ctx) => {
      const turnEndPlan = runtimeState.staleQueuedWorkGuard.planTurnEnd(
        event.turnIndex,
        event.message,
      );
      applyStaleQueuedWorkEffects(turnEndPlan.effects, ctx);
      if (turnEndPlan.skip) {
        return;
      }

      const completedTurnTokens = assistantTurnTokens(event.message);
      goalAccounting.accountProgress(ctx, true, completedTurnTokens);
      stateController.flushGoalPersistence("runtime");
      if (isAbortedAssistantMessage(event.message)) {
        stateController.pauseForAbort(ctx);
        return;
      }
      if (isErrorAssistantMessage(event.message)) {
        return;
      }
      if (isAssistantContextOverflow(event.message, getContextWindow(ctx))) {
        beginOverflowRecoveryAttention(ctx);
        return;
      }
      recoveryRuntime.finishSuccessfulAssistantTurn(event.message, ctx, {
        continueGoal: !isToolUseAssistantMessage(event.message),
      });
    }) satisfies ExtensionHandler<TurnEndEvent>,

    onAgentEnd: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      const agentEndPlan = runtimeState.staleQueuedWorkGuard.planAgentEnd(event.messages);
      applyStaleQueuedWorkEffects(agentEndPlan.effects, ctx);
      if (agentEndPlan.skip) {
        return;
      }

      const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
      const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
        return sum + assistantTurnTokens(message);
      }, 0);
      goalAccounting.accountProgress(ctx, false, abortedTurnTokens, true);
      stateController.flushGoalPersistence("runtime");
      if (abortedMessages.length > 0) {
        stateController.pauseForAbort(ctx);
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

      const lastAssistant = [...event.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant && recordAssistantContextOverflow(lastAssistant, ctx)) {
        return;
      }
      resetErrorRecovery();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<AgentEndEvent>,

    onSessionBeforeCompact: (async (_event, ctx) => {
      const compactPlan = runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact();
      applyStaleQueuedWorkEffects(compactPlan.effects, ctx);
      if (compactPlan.skip) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
    }) satisfies ExtensionHandler<SessionBeforeCompactEvent>,

    onSessionCompact: (async (_event, ctx) => {
      const compactPlan = runtimeState.staleQueuedWorkGuard.planSessionCompact();
      applyStaleQueuedWorkEffects(compactPlan.effects, ctx);
      if (compactPlan.skip) {
        return;
      }

      stateController.flushGoalPersistence("runtime");
      recoveryRuntime.onSessionCompact();
      status.refreshUi(ctx);
      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
        continuation.maybeContinue(ctx);
      }
    }) satisfies ExtensionHandler<SessionCompactEvent>,

    onSessionShutdown: (async (_event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects,
        ctx,
      );

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
      continuation.clearContinuationTimer();
      if (hasPendingRecoveryAttention()) {
        pauseForPendingRecoveryShutdown(ctx);
      } else {
        resetErrorRecovery();
      }
      status.stopStatusRefresh();
    }) satisfies ExtensionHandler<SessionShutdownEvent>,
  };
}

export type GoalRuntimeController = ReturnType<typeof createGoalRuntimeController>;

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerGoalRuntimeEvents(pi, controller);
}
