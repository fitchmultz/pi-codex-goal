import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { formatFooterStatus } from "./format.js";
import {
  assistantTurnTokens,
  createAccountingState,
  createGoalAccounting,
  isAbortedAssistantMessage,
  isToolUseAssistantMessage,
} from "./goal-accounting.js";
import { compactContinuationPrompt, continuationGoalIdFromPrompt } from "./prompts.js";
import { isCommandResumeQueuedGoalMessage } from "./queued-goal-messages.js";
import {
  applyQueuedGoalProviderContextRewrites,
  extensionQueuedGoalWorkMessageId,
  extensionQueuedGoalWorkMessageIdForRuntime,
} from "./queued-goal-work.js";
import {
  createStaleQueuedWorkGuard,
  type StaleQueuedWorkEffect,
  type StaleQueuedWorkGuard,
} from "./stale-queued-work-guard.js";
import {
  applyHostOverflowUserResetPersistence,
  clearActiveHostOverflowRecovery,
  createGoalRecoveryMachine,
  goalStartTurnStrategy,
  recoveryPhaseBlocksContinuation,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
  syncHostOverflowUserResetFromSession,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import { createGoalRecoveryRuntime } from "./recovery-runtime.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isRecoveryPendingAttention,
  reasonFromRecoveryPendingAttention,
  type AssistantErrorMessage,
} from "./recovery.js";
import {
  clearEntry,
  cloneGoal,
  goalWithLiveUsage,
  goalsEquivalent,
  hostOverflowCapResetEntry,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  setEntry,
  updateGoalStatus,
} from "./state.js";
import { registerGoalTools } from "./tools.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

interface StatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

const CONTINUATION_RETRY_MS = 50;
const RUNTIME_PERSIST_INTERVAL_MS = 60_000;

export const __testHooks = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
  runtimePersistIntervalMs: RUNTIME_PERSIST_INTERVAL_MS,
};

export default function (pi: ExtensionAPI): void {
  let goal: ThreadGoal | null = null;
  let continuationQueuedFor: string | null = null;
  let continuationScheduledFor: string | null = null;
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;
  let statusContext: StatusContext | null = null;
  let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let currentTurnIndex: number | null = null;
  // Do not rely on agent_end after ctx.abort(): pi's normal prompt loop ends there,
  // but compaction/shutdown and later queued turns can cross this stale cleanup boundary.
  const staleQueuedWorkGuard: StaleQueuedWorkGuard = createStaleQueuedWorkGuard();
  let passthroughContinuationInput: { text: string; turnIndex: number | null } | null = null;
  const accounting = createAccountingState();
  let recoveryState: GoalRecoveryMachineState = createGoalRecoveryMachine();
  let lastPersistedGoal: ThreadGoal | null = null;
  let lastRuntimePersistAt: number | null = null;

  const goalForDisplay = (): ThreadGoal | null =>
    goalWithLiveUsage(goal, accounting.activeGoalId, accounting.lastAccountedAt);

  const stopStatusRefresh = (): void => {
    if (statusRefreshTimer) {
      clearInterval(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };

  const clearContinuationTimer = (): void => {
    if (continuationTimer) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }
    continuationScheduledFor = null;
  };

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(recoveryState);
  };

  const clearContinuationState = (): void => {
    clearContinuationTimer();
    continuationQueuedFor = null;
  };

  const clearContinuationStateFor = (goalId: string): void => {
    if (continuationQueuedFor === goalId) {
      continuationQueuedFor = null;
    }
    if (continuationScheduledFor === goalId) {
      clearContinuationTimer();
    }
  };

  const isCurrentActiveGoalId = (goalId: string): boolean => {
    return goal?.goalId === goalId && goal.status === "active";
  };

  const clearActiveAccounting = (): void => {
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const applyStaleQueuedWorkEffects = (effects: readonly StaleQueuedWorkEffect[], ctx: ExtensionContext): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "clearAccounting":
          clearActiveAccounting();
          break;
        case "refreshUi":
          refreshUi(ctx);
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

  const clearStoppedRuntimeState = (): void => {
    clearContinuationState();
    clearActiveAccounting();
    resetErrorRecovery();
  };

  const syncStatusRefresh = (): void => {
    if (goal?.status === "active" && statusContext && !statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || goal?.status !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay(), recoveryState.attention));
      }, 1_000);
      statusRefreshTimer.unref?.();
      return;
    }

    if (goal?.status !== "active") {
      stopStatusRefresh();
    }
  };

  const refreshUi = (ctx: StatusContext): void => {
    statusContext = ctx;
    ctx.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay(), recoveryState.attention));
    syncStatusRefresh();
  };

  const clearPassthroughContinuationInput = (): void => {
    passthroughContinuationInput = null;
  };

  const bindPassthroughContinuationInputToTurn = (turnIndex: number): void => {
    if (!passthroughContinuationInput) {
      return;
    }
    if (passthroughContinuationInput.turnIndex === null) {
      passthroughContinuationInput = { ...passthroughContinuationInput, turnIndex };
      return;
    }
    if (passthroughContinuationInput.turnIndex !== turnIndex) {
      clearPassthroughContinuationInput();
    }
  };

  const isPassthroughContinuationInput = (text: string): boolean => {
    if (!passthroughContinuationInput || passthroughContinuationInput.text !== text) {
      return false;
    }
    return passthroughContinuationInput.turnIndex === null || passthroughContinuationInput.turnIndex === currentTurnIndex;
  };

  const continuationGoalIdFromRuntimePrompt = (prompt: string): string | null => {
    if (isPassthroughContinuationInput(prompt)) {
      return null;
    }
    return continuationGoalIdFromPrompt(prompt);
  };

  const queuedGoalWorkMessageIdForRuntime = (message: {
    role: string;
    customType?: string;
    details?: unknown;
    content?: unknown;
  }): string | null =>
    extensionQueuedGoalWorkMessageIdForRuntime(message, continuationGoalIdFromRuntimePrompt);

  const applyGoalSideEffects = (nextGoal: ThreadGoal): void => {
    const previousGoalId = goal?.goalId ?? null;
    if (previousGoalId !== nextGoal.goalId) {
      accounting.budgetWarningSentFor = null;
      clearStoppedRuntimeState();
    }
    if (nextGoal.status === "complete") {
      clearStoppedRuntimeState();
    } else if (nextGoal.status === "paused") {
      clearContinuationState();
      clearActiveAccounting();
    } else if (nextGoal.status === "budgetLimited") {
      clearContinuationState();
      clearActiveAccounting();
      resetErrorRecovery();
    }
    if (nextGoal.status !== "budgetLimited") {
      accounting.budgetWarningSentFor = null;
    }
  };

  const setGoalInMemory = (nextGoal: ThreadGoal): void => {
    applyGoalSideEffects(nextGoal);
    goal = nextGoal;
  };

  const flushGoalPersistence = (source: GoalEntrySource): boolean => {
    if (!goal) {
      return false;
    }
    if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) {
      return false;
    }

    pi.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(goal, source));
    lastPersistedGoal = cloneGoal(goal);
    lastRuntimePersistAt = Date.now();
    return true;
  };

  const maybeFlushRuntimePersistence = (source: GoalEntrySource): void => {
    if (!goal || goal.status !== "active") {
      return;
    }
    const now = Date.now();
    if (lastRuntimePersistAt !== null && now - lastRuntimePersistAt < RUNTIME_PERSIST_INTERVAL_MS) {
      return;
    }
    flushGoalPersistence(source);
  };

  const persistGoal = (nextGoal: ThreadGoal, source: GoalEntrySource): boolean => {
    if (goal && goalsEquivalent(goal, nextGoal)) {
      return false;
    }

    setGoalInMemory(nextGoal);
    return flushGoalPersistence(source);
  };

  const persistClear = (source: GoalEntrySource): void => {
    const clearedGoalId = goal?.goalId ?? null;
    goal = null;
    lastPersistedGoal = null;
    lastRuntimePersistAt = null;
    clearStoppedRuntimeState();
    stopStatusRefresh();
    pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };

  const pauseForAbort = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active") {
      return;
    }

    const result = updateGoalStatus(goal, "paused");
    if (!result.ok || !result.goal) {
      return;
    }

    clearStoppedRuntimeState();
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
  };

  const resumePausedGoal = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "paused") {
      return;
    }

    const result = updateGoalStatus(goal, "active");
    if (!result.ok || !result.goal) {
      return;
    }

    resetErrorRecovery();
    clearContinuationState();
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
  };

  const persistHostOverflowUserReset = (needsReset: boolean): void => {
    if (!applyHostOverflowUserResetPersistence(recoveryState, needsReset)) {
      return;
    }
    pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsReset));
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    const previousGoalId = goal?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    goal = reconstructGoal(branch).goal;
    lastPersistedGoal = goal ? cloneGoal(goal) : null;
    lastRuntimePersistAt = null;
    syncHostOverflowUserResetFromSession(
      recoveryState,
      reconstructHostOverflowCapNeedsUserReset(branch),
    );
    clearContinuationState();
    if (goal?.status !== "active") {
      clearActiveAccounting();
    }
    if ((goal?.goalId ?? null) !== previousGoalId) {
      resetErrorRecovery();
    }
    refreshUi(ctx);
  };

  const goalAccounting = createGoalAccounting({
    getGoal: () => goal,
    setGoal: setGoalInMemory,
    getAccounting: () => accounting,
    flushGoalPersistence,
    refreshUi,
    sendMessage: pi.sendMessage.bind(pi),
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    goalAccounting.accountProgress(ctx, false, 0, true);
    const result = updateGoalStatus(goal, "complete");
    if (!result.ok || !result.goal) {
      return result;
    }
    if (goal && goalsEquivalent(goal, result.goal)) {
      return result;
    }
    persistGoal(result.goal, source);
    refreshUi(ctx);
    return result;
  };

  const sendContinuation = (goalToContinue: ThreadGoal): void => {
    continuationQueuedFor = goalToContinue.goalId;
    pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: compactContinuationPrompt(goalToContinue),
        display: false,
        details: { kind: "continuation", goalId: goalToContinue.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const hasPendingRecoveryAttention = (): boolean => {
    return goal?.status === "active" && isRecoveryPendingAttention(recoveryState.attention);
  };

  const maybeContinue = (ctx: ExtensionContext): void => {
    if (
      staleQueuedWorkGuard.isBlockingContinuation() ||
      !goal ||
      goal.status !== "active" ||
      continuationQueuedFor === goal.goalId ||
      hasPendingRecoveryAttention() ||
      recoveryPhaseBlocksContinuation(recoveryState.phase)
    ) {
      return;
    }

    const goalId = goal.goalId;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      if (continuationScheduledFor === goalId) {
        return;
      }
      continuationScheduledFor = goalId;
      continuationTimer = setTimeout(() => {
        continuationTimer = null;
        continuationScheduledFor = null;
        maybeContinue(ctx);
      }, CONTINUATION_RETRY_MS);
      continuationTimer.unref?.();
      return;
    }

    clearContinuationTimer();
    if (!goal || goal.status !== "active" || goal.goalId !== goalId) {
      return;
    }
    sendContinuation(goal);
  };

  const getContextWindow = (ctx: ExtensionContext): number => ctx.model?.contextWindow ?? 0;

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => goal,
    getRecoveryState: () => recoveryState,
    clearContinuationState,
    pauseGoalForRecovery(ctx, activeGoal) {
      const result = updateGoalStatus(activeGoal, "paused");
      if (!result.ok || !result.goal) {
        return;
      }
      persistGoal(result.goal, "runtime");
    },
    refreshUi,
    maybeContinue,
  });

  const pauseForPendingRecoveryShutdown = (ctx: ExtensionContext): void => {
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

    clearContinuationState();
    clearActiveHostOverflowRecovery(recoveryState);
    setRecoveryPausedAttention(recoveryState, reason);
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
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
      persistGoal(nextGoal, source);
      refreshUi(ctx);
    },
    completeGoal,
  });

  registerGoalCommand(pi, {
    getGoal: () => goalForDisplay(),
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      const wasPaused = goal?.status === "paused";
      persistGoal(nextGoal, source);
      if (source === "command") {
        if (nextGoal.status === "active") {
          if (wasPaused) {
            resetErrorRecovery();
          }
          continuationQueuedFor = nextGoal.goalId;
        } else if (nextGoal.status === "paused") {
          resetErrorRecovery();
        }
      }
      refreshUi(ctx);
    },
    clearGoal(source, ctx) {
      persistClear(source);
      refreshUi(ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    clearPassthroughContinuationInput();
    const continuationGoalId = continuationGoalIdFromPrompt(event.text);

    if (event.source !== "extension") {
      recoveryRuntime.onUserInput();
      applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planUserInputClearAbort().effects, ctx);
      if (continuationGoalId !== null) {
        passthroughContinuationInput = { text: event.text, turnIndex: null };
      }
      return undefined;
    }

    if (continuationGoalId === null) {
      return undefined;
    }

    applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects, ctx);
    clearContinuationStateFor(continuationGoalId);
    if (isCurrentActiveGoalId(continuationGoalId)) {
      return { action: "continue" } as const;
    }

    refreshUi(ctx);
    return { action: "handled" } as const;
  });

  pi.on("context", async (event, ctx): Promise<{ messages: typeof event.messages } | undefined> => {
    const { messages, changed } = applyQueuedGoalProviderContextRewrites(event.messages, {
      goal,
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
    reloadFromSession(ctx);
    goalAccounting.beginAccounting();
    if (event.reason === "resume" && goal?.status === "paused" && ctx.hasUI) {
      const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${goal.objective}`);
      if (shouldResume) {
        resumePausedGoal(ctx);
        goalAccounting.beginAccounting();
        if (goal) {
          pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
        }
        return;
      }
    }
    maybeContinue(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reloadFromSession(ctx);
    goalAccounting.beginAccounting();
    maybeContinue(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const continuationGoalId = continuationGoalIdFromRuntimePrompt(_event.prompt);
    if (continuationGoalId !== null) {
      clearContinuationStateFor(continuationGoalId);
      if (!isCurrentActiveGoalId(continuationGoalId)) {
        refreshUi(ctx);
        return undefined;
      }
      applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx);
    } else {
      applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx);
      clearContinuationState();
    }
  });

  pi.on("message_start", async (event) => {
    if (event.message.role === "user") {
      persistHostOverflowUserReset(false);
    }

    const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
    if (queuedGoalId === null) {
      if (event.message.role === "user" || event.message.role === "custom") {
        staleQueuedWorkGuard.noteRunnableWorkStarted();
        clearContinuationState();
      }
      return;
    }

    clearContinuationStateFor(queuedGoalId);
    if (isCurrentActiveGoalId(queuedGoalId)) {
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
    bindPassthroughContinuationInputToTurn(_event.turnIndex);
    applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planTurnStart().effects, ctx);
    goalAccounting.beginAccounting();
    refreshUi(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    const toolEndPlan = staleQueuedWorkGuard.planToolExecutionEnd();
    applyStaleQueuedWorkEffects(toolEndPlan.effects, ctx);
    if (toolEndPlan.skip) {
      return;
    }

    goalAccounting.accountProgress(ctx, true, 0, true);
    maybeFlushRuntimePersistence("runtime");
  });

  pi.on("turn_end", async (_event, ctx) => {
    const turnEndPlan = staleQueuedWorkGuard.planTurnEnd(_event.turnIndex, _event.message);
    applyStaleQueuedWorkEffects(turnEndPlan.effects, ctx);
    if (turnEndPlan.skip) {
      return;
    }

    const completedTurnTokens = assistantTurnTokens(_event.message);
    goalAccounting.accountProgress(ctx, true, completedTurnTokens);
    flushGoalPersistence("runtime");
    if (isAbortedAssistantMessage(_event.message)) {
      pauseForAbort(ctx);
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
    clearPassthroughContinuationInput();
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
    flushGoalPersistence("runtime");
    if (abortedMessages.length > 0) {
      pauseForAbort(ctx);
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
    maybeContinue(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const compactPlan = staleQueuedWorkGuard.planSessionBeforeCompact();
    applyStaleQueuedWorkEffects(compactPlan.effects, ctx);
    if (compactPlan.skip) {
      return;
    }

    goalAccounting.accountProgress(ctx, false, 0, true);
    flushGoalPersistence("runtime");
  });

  pi.on("session_compact", async (_event, ctx) => {
    const compactPlan = staleQueuedWorkGuard.planSessionCompact();
    applyStaleQueuedWorkEffects(compactPlan.effects, ctx);
    if (compactPlan.skip) {
      return;
    }

    flushGoalPersistence("runtime");
    recoveryRuntime.onSessionCompact();
    refreshUi(ctx);
    if (!recoveryPhaseBlocksContinuation(recoveryState.phase)) {
      maybeContinue(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearPassthroughContinuationInput();
    applyStaleQueuedWorkEffects(staleQueuedWorkGuard.planSessionShutdown().effects, ctx);

    goalAccounting.accountProgress(ctx, false, 0, true);
    flushGoalPersistence("runtime");
    clearContinuationTimer();
    if (hasPendingRecoveryAttention()) {
      pauseForPendingRecoveryShutdown(ctx);
    } else {
      resetErrorRecovery();
    }
    stopStatusRefresh();
  });
}
