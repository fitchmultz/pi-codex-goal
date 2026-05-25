import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { formatFooterStatus } from "./format.js";
import { budgetLimitPrompt, continuationGoalIdFromPrompt, continuationPrompt } from "./prompts.js";
import { applyUsage, clearEntry, goalWithLiveUsage, goalsEquivalent, reconstructGoal, setEntry, updateGoalStatus } from "./state.js";
import { registerGoalTools } from "./tools.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  budgetWarningSentFor: string | null;
}

interface StatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

interface AssistantUsage {
  input: number;
  output: number;
}

interface QueuedGoalMessageDetails {
  kind?: unknown;
  goalId?: unknown;
}

interface TextMessagePart {
  type?: unknown;
  text?: unknown;
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function assistantTurnTokens(message: { role: string; usage?: AssistantUsage }): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

function isAbortedAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

function isQueuedGoalWorkKind(kind: unknown): boolean {
  return kind === "continuation" || kind === "command_start" || kind === "command_resume";
}

function isQueuedGoalMessageDetails(details: unknown): details is QueuedGoalMessageDetails {
  return details !== null && typeof details === "object";
}

function textContentFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const textPart = part as TextMessagePart;
    if (textPart.type === "text" && typeof textPart.text === "string") {
      textParts.push(textPart.text);
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : null;
}

function continuationGoalIdFromMessageContent(content: unknown): string | null {
  const text = textContentFromMessageContent(content);
  return text === null ? null : continuationGoalIdFromPrompt(text);
}

function staleGoalContinuationMessage(queuedGoalId: string, currentGoal: ThreadGoal | null): string {
  const currentState = currentGoal
    ? `Current goal id: ${currentGoal.goalId}; current status: ${currentGoal.status}.`
    : "There is no current goal.";
  return [
    "A queued hidden goal continuation was stale and has been cancelled before running.",
    `Queued goal id: ${queuedGoalId}.`,
    currentState,
    "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
  ].join("\n");
}

function queuedGoalWorkMessageId(message: {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
}): string | null {
  if (message.role === "user") {
    return continuationGoalIdFromMessageContent(message.content);
  }

  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }

  if (isQueuedGoalMessageDetails(message.details)) {
    const { kind, goalId } = message.details;
    if (isQueuedGoalWorkKind(kind) && typeof goalId === "string") {
      return goalId;
    }
  }

  return continuationGoalIdFromMessageContent(message.content);
}

function staleGoalContinuationContextMessage<TMessage extends { role: string; content?: unknown }>(
  message: TMessage,
  queuedGoalId: string,
  currentGoal: ThreadGoal | null,
): TMessage {
  const content = staleGoalContinuationMessage(queuedGoalId, currentGoal);

  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: {
        kind: "stale_continuation",
        goalId: queuedGoalId,
        currentGoalId: currentGoal?.goalId ?? null,
        currentStatus: currentGoal?.status ?? null,
      },
    } as TMessage;
  }

  return {
    ...message,
    content: [{ type: "text", text: content }],
  } as TMessage;
}

const CONTINUATION_RETRY_MS = 50;

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
  const accounting: AccountingState = {
    activeGoalId: null,
    lastAccountedAt: null,
    budgetWarningSentFor: null,
  };

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
  };

  const syncStatusRefresh = (): void => {
    if (goal?.status === "active" && statusContext && !statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || goal?.status !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay()));
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
    ctx.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay()));
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
  }): string | null => {
    if (message.role === "user") {
      const text = textContentFromMessageContent(message.content);
      return text === null ? null : continuationGoalIdFromRuntimePrompt(text);
    }

    return queuedGoalWorkMessageId(message);
  };

  const pendingStaleQueuedGoalWorkIdsFromMessages = (
    messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown }>,
  ): string[] => {
    const goalIds: string[] = [];
    for (const message of messages) {
      const queuedGoalId = queuedGoalWorkMessageId(message);
      if (queuedGoalId !== null && staleQueuedGoalWorkAgentEndGoalIds.has(queuedGoalId)) {
        goalIds.push(queuedGoalId);
      }
    }
    return goalIds;
  };

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

    const staleGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages);
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
    if (nextGoal.status === "paused" || nextGoal.status === "complete") {
      clearStoppedRuntimeState();
    } else if (nextGoal.status === "budgetLimited") {
      clearContinuationState();
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

    clearContinuationState();
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    goal = reconstructGoal(ctx.sessionManager.getBranch()).goal;
    clearContinuationState();
    if (goal?.status !== "active") {
      clearActiveAccounting();
    }
    refreshUi(ctx);
  };

  const beginAccounting = (): void => {
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      return;
    }

    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    completedTurnTokens = 0,
    accountBudgetLimited = false,
  ): void => {
    const canAccount = goal?.status === "active" || (accountBudgetLimited && goal?.status === "budgetLimited");
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      beginAccounting();
      return;
    }

    const now = Date.now();
    const elapsed = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
    accounting.lastAccountedAt = now;

    const result = applyUsage(goal, completedTurnTokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (!result.changed || !result.goal) {
      return;
    }

    persistGoal(result.goal, "runtime");
    refreshUi(ctx);

    if (allowBudgetSteering && result.crossedBudget && accounting.budgetWarningSentFor !== result.goal.goalId) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      pi.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    accountProgress(ctx, false, 0, true);
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
        content: continuationPrompt(goalToContinue),
        display: false,
        details: { kind: "continuation", goalId: goalToContinue.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const maybeContinue = (ctx: ExtensionContext): void => {
    if (staleQueuedGoalWorkTurnActive || !goal || goal.status !== "active" || continuationQueuedFor === goal.goalId) {
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
    setGoal(nextGoal, source, ctx) {
      persistGoal(nextGoal, source);
      if (source === "command" && nextGoal.status === "active") {
        continuationQueuedFor = nextGoal.goalId;
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
    const messages: typeof event.messages = event.messages.map((message) => {
      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(message);
      if (queuedGoalId === null || (goal?.goalId === queuedGoalId && goal.status === "active")) {
        return message;
      }

      changed = true;
      return staleGoalContinuationContextMessage(message, queuedGoalId, goal);
    });

    if (startedStaleQueuedGoalWorkThisTurn && !startedRunnableWorkThisTurn) {
      if (!staleQueuedGoalWorkTurnActive) {
        noteStaleQueuedGoalWorkTerminalEvents();
      }
      staleQueuedGoalWorkTurnActive = true;
      clearActiveAccounting();
      ctx.abort();
      refreshUi(ctx);
    }

    return changed ? { messages } : undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    reloadFromSession(ctx);
    beginAccounting();
    if (event.reason === "resume" && goal?.status === "paused" && ctx.hasUI) {
      const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${goal.objective}`);
      if (shouldResume) {
        resumePausedGoal(ctx);
        beginAccounting();
      }
    }
    maybeContinue(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reloadFromSession(ctx);
    beginAccounting();
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
    beginAccounting();
    refreshUi(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkLifecycle(ctx)) {
      return;
    }

    accountProgress(ctx, true, 0, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkTurnEnd(_event.turnIndex, _event.message, ctx)) {
      return;
    }

    const completedTurnTokens = assistantTurnTokens(_event.message);
    accountProgress(ctx, true, completedTurnTokens);
    if (isAbortedAssistantMessage(_event.message)) {
      pauseForAbort(ctx);
      return;
    }
    if (!isToolUseAssistantMessage(_event.message)) {
      maybeContinue(ctx);
    }
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
    accountProgress(ctx, false, abortedTurnTokens, true);
    if (abortedMessages.length > 0) {
      pauseForAbort(ctx);
      return;
    }
    maybeContinue(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkLifecycle(ctx)) {
      return;
    }

    accountProgress(ctx, false, 0, true);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (skipStaleQueuedGoalWorkLifecycle(ctx)) {
      return;
    }

    if (goal) {
      persistGoal(goal, "runtime");
    }
    refreshUi(ctx);
    maybeContinue(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearPassthroughContinuationInput();
    if (staleQueuedGoalWorkTurnActive) {
      clearStaleQueuedGoalWorkTurn();
      clearStaleQueuedGoalWorkTerminalEvents();
      clearContinuationTimer();
      stopStatusRefresh();
      return;
    }
    clearStaleQueuedGoalWorkTerminalEvents();

    accountProgress(ctx, false, 0, true);
    clearContinuationTimer();
    stopStatusRefresh();
  });
}
