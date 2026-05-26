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
import {
  dedupeActiveGoalContinuations,
  extensionQueuedGoalWorkMessageId,
  extensionQueuedGoalWorkMessageIdForRuntime,
  pendingStaleQueuedGoalWorkIdsFromMessages,
  staleGoalContinuationContextMessage,
} from "./queued-goal-work.js";
import {
  createGoalRecoveryMachine,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
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

export const __testHooks = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
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
  let staleQueuedGoalWorkTurnActive = false;
  let staleQueuedGoalWorkActiveTurnIndex: number | null = null;
  const staleQueuedGoalWorkTurnEndSkipIndexes = new Set<number>();
  const staleQueuedGoalWorkAgentEndGoalIds = new Set<string>();
  let passthroughContinuationInput: { text: string; turnIndex: number | null } | null = null;
  let startedStaleQueuedGoalWorkThisTurn = false;
  let startedRunnableWorkThisTurn = false;
  const startedStaleQueuedGoalWorkGoalIds = new Set<string>();
  const accounting = createAccountingState();
  let recoveryState: GoalRecoveryMachineState = createGoalRecoveryMachine();
  let hostOverflowRecoveryInProgress = false;
  let hostOverflowCapNeedsUserReset = false;

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
    hostOverflowRecoveryInProgress = false;
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

  const clearStartedTurnWork = (): void => {
    startedStaleQueuedGoalWorkThisTurn = false;
    startedRunnableWorkThisTurn = false;
    startedStaleQueuedGoalWorkGoalIds.clear();
  };

  const clearActiveAccounting = (): void => {
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const noteStaleQueuedGoalWorkTerminalEvents = (): void => {
    if (currentTurnIndex !== null) {
      staleQueuedGoalWorkActiveTurnIndex = currentTurnIndex;
      staleQueuedGoalWorkTurnEndSkipIndexes.add(currentTurnIndex);
    }
    for (const goalId of startedStaleQueuedGoalWorkGoalIds) {
      staleQueuedGoalWorkAgentEndGoalIds.add(goalId);
    }
  };

  const clearStaleQueuedGoalWorkTerminalEvents = (): void => {
    staleQueuedGoalWorkTurnEndSkipIndexes.clear();
    staleQueuedGoalWorkAgentEndGoalIds.clear();
    staleQueuedGoalWorkActiveTurnIndex = null;
  };

  const clearStaleQueuedGoalWorkTurn = (): boolean => {
    if (!staleQueuedGoalWorkTurnActive) {
      return false;
    }
    staleQueuedGoalWorkTurnActive = false;
    staleQueuedGoalWorkActiveTurnIndex = null;
    clearActiveAccounting();
    return true;
  };

  const skipStaleQueuedGoalWorkLifecycle = (ctx: StatusContext): boolean => {
    if (!staleQueuedGoalWorkTurnActive) {
      return false;
    }
    clearActiveAccounting();
    refreshUi(ctx);
    return true;
  };

  const finishStaleQueuedGoalWorkLifecycle = (ctx: StatusContext): boolean => {
    if (!clearStaleQueuedGoalWorkTurn()) {
      return false;
    }
    clearStaleQueuedGoalWorkTerminalEvents();
    refreshUi(ctx);
    return true;
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

  const skipStaleQueuedGoalWorkTurnEnd = (
    turnIndex: number | null,
    message: { role: string; stopReason?: string },
    ctx: StatusContext,
  ): boolean => {
    const isActiveStaleTurn =
      staleQueuedGoalWorkTurnActive &&
      turnIndex !== null &&
      staleQueuedGoalWorkActiveTurnIndex === turnIndex;
    const isPendingStaleTurnEnd =
      turnIndex !== null &&
      isAbortedAssistantMessage(message) &&
      staleQueuedGoalWorkTurnEndSkipIndexes.has(turnIndex);

    if (!isActiveStaleTurn && !isPendingStaleTurnEnd) {
      return false;
    }

    if (turnIndex !== null) {
      staleQueuedGoalWorkTurnEndSkipIndexes.delete(turnIndex);
    }
    if (isActiveStaleTurn) {
      clearActiveAccounting();
    }
    refreshUi(ctx);
    return true;
  };

  const skipStaleQueuedGoalWorkAgentEnd = (
    messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
    ctx: StatusContext,
  ): boolean => {
    if (finishStaleQueuedGoalWorkLifecycle(ctx)) {
      return true;
    }

    if (!messages.some(isAbortedAssistantMessage)) {
      return false;
    }

    const staleGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, staleQueuedGoalWorkAgentEndGoalIds);
    if (staleGoalIds.length === 0) {
      return false;
    }

    for (const goalId of staleGoalIds) {
      staleQueuedGoalWorkAgentEndGoalIds.delete(goalId);
    }
    refreshUi(ctx);
    return true;
  };

  const persistGoal = (nextGoal: ThreadGoal, source: GoalEntrySource): boolean => {
    if (goal && goalsEquivalent(goal, nextGoal)) {
      return false;
    }

    const previousGoalId = goal?.goalId ?? null;
    goal = nextGoal;
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
      resetErrorRecovery();
    }
    if (nextGoal.status !== "budgetLimited") {
      accounting.budgetWarningSentFor = null;
    }
    pi.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(nextGoal, source));
    return true;
  };

  const persistClear = (source: GoalEntrySource): void => {
    const clearedGoalId = goal?.goalId ?? null;
    goal = null;
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

  const setHostOverflowCapNeedsUserReset = (needsReset: boolean): void => {
    if (hostOverflowCapNeedsUserReset === needsReset) {
      return;
    }
    hostOverflowCapNeedsUserReset = needsReset;
    pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsReset));
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    const previousGoalId = goal?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    goal = reconstructGoal(branch).goal;
    hostOverflowCapNeedsUserReset = reconstructHostOverflowCapNeedsUserReset(branch);
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
    getAccounting: () => accounting,
    persistGoal,
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
      staleQueuedGoalWorkTurnActive ||
      !goal ||
      goal.status !== "active" ||
      continuationQueuedFor === goal.goalId ||
      hasPendingRecoveryAttention() ||
      hostOverflowRecoveryInProgress
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
    hostOverflowRecoveryInProgress = false;
    setRecoveryPausedAttention(recoveryState, reason);
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
  };

  const beginOverflowRecoveryAttention = (ctx: ExtensionContext): void => {
    setHostOverflowCapNeedsUserReset(true);
    hostOverflowRecoveryInProgress = true;
    recoveryRuntime.beginOverflowRecovery(ctx);
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
    needsHostOverflowCapReset: () => hostOverflowCapNeedsUserReset,
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
      hostOverflowRecoveryInProgress = false;
      recoveryRuntime.onUserInput();
      if (clearStaleQueuedGoalWorkTurn()) {
        refreshUi(ctx);
      }
      if (continuationGoalId !== null) {
        passthroughContinuationInput = { text: event.text, turnIndex: null };
      }
      return undefined;
    }

    if (continuationGoalId === null) {
      return undefined;
    }

    clearStaleQueuedGoalWorkTurn();
    clearContinuationStateFor(continuationGoalId);
    if (isCurrentActiveGoalId(continuationGoalId)) {
      return { action: "continue" } as const;
    }

    refreshUi(ctx);
    return { action: "handled" } as const;
  });

  pi.on("context", async (event, ctx): Promise<{ messages: typeof event.messages } | undefined> => {
    let changed = false;
    let messages: typeof event.messages = event.messages.map((message) => {
      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(message);
      if (queuedGoalId === null) {
        return message;
      }

      if (goal?.goalId === queuedGoalId && goal.status === "active") {
        return message;
      }

      changed = true;
      return staleGoalContinuationContextMessage(message, queuedGoalId, goal);
    });

    if (goal?.status === "active") {
      const deduped = dedupeActiveGoalContinuations(messages, goal, extensionQueuedGoalWorkMessageId);
      if (deduped.changed) {
        changed = true;
        messages = deduped.messages;
      }
    }

    if (startedStaleQueuedGoalWorkThisTurn && !startedRunnableWorkThisTurn) {
      if (!staleQueuedGoalWorkTurnActive) {
        noteStaleQueuedGoalWorkTerminalEvents();
      }
      staleQueuedGoalWorkTurnActive = true;
      goalAccounting.clearActiveAccounting();
      ctx.abort();
      refreshUi(ctx);
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
      clearStaleQueuedGoalWorkTurn();
    } else {
      clearStaleQueuedGoalWorkTurn();
      clearContinuationState();
    }
  });

  pi.on("message_start", async (event) => {
    if (event.message.role === "user") {
      setHostOverflowCapNeedsUserReset(false);
    }

    const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
    if (queuedGoalId === null) {
      if (event.message.role === "user" || event.message.role === "custom") {
        startedRunnableWorkThisTurn = true;
        clearContinuationState();
      }
      return;
    }

    clearContinuationStateFor(queuedGoalId);
    if (isCurrentActiveGoalId(queuedGoalId)) {
      startedRunnableWorkThisTurn = true;
      const details = (event.message as { details?: unknown }).details;
      if (
        details !== null &&
        typeof details === "object" &&
        "kind" in details &&
        (details as { kind?: unknown }).kind === "command_resume"
      ) {
        resetErrorRecovery();
      }
      return;
    }

    startedStaleQueuedGoalWorkThisTurn = true;
    startedStaleQueuedGoalWorkGoalIds.add(queuedGoalId);
  });

  pi.on("turn_start", async (_event, ctx) => {
    currentTurnIndex = _event.turnIndex;
    bindPassthroughContinuationInputToTurn(_event.turnIndex);
    clearStartedTurnWork();
    clearStaleQueuedGoalWorkTurn();
    goalAccounting.beginAccounting();
    refreshUi(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkLifecycle(ctx)) {
      return;
    }

    goalAccounting.accountProgress(ctx, true, 0, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkTurnEnd(_event.turnIndex, _event.message, ctx)) {
      return;
    }

    const completedTurnTokens = assistantTurnTokens(_event.message);
    goalAccounting.accountProgress(ctx, true, completedTurnTokens);
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
    if (skipStaleQueuedGoalWorkAgentEnd(event.messages, ctx)) {
      return;
    }

    const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
    const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
      return sum + assistantTurnTokens(message);
    }, 0);
    goalAccounting.accountProgress(ctx, false, abortedTurnTokens, true);
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
    hostOverflowRecoveryInProgress = false;
    maybeContinue(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkLifecycle(ctx)) {
      return;
    }

    goalAccounting.accountProgress(ctx, false, 0, true);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkLifecycle(ctx)) {
      return;
    }

    if (goal) {
      persistGoal(goal, "runtime");
    }
    recoveryRuntime.onSessionCompact();
    refreshUi(ctx);
    if (!hostOverflowRecoveryInProgress) {
      maybeContinue(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearPassthroughContinuationInput();
    if (staleQueuedGoalWorkTurnActive) {
      clearStaleQueuedGoalWorkTurn();
    }
    clearStaleQueuedGoalWorkTerminalEvents();

    goalAccounting.accountProgress(ctx, false, 0, true);
    clearContinuationTimer();
    if (hasPendingRecoveryAttention()) {
      pauseForPendingRecoveryShutdown(ctx);
    } else {
      resetErrorRecovery();
    }
    stopStatusRefresh();
  });
}
