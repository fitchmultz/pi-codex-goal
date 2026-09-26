import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { budgetLimitPrompt } from "./prompts.ts";
import { applyUsage } from "./state.ts";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.ts";

export interface AccountingState {
  activeGoalId: string | null;
  /** Response owner stays fixed through pause/resume and replacements; cleared once turn_end accounts it. */
  turnGoalId: string | null;
  lastAccountedAt: number | null;
  lastSampledAt: number | null;
  budgetWarningSentFor: string | null;
}

export interface AssistantUsage {
  input: number;
  output: number;
}

export interface AssistantTurnMessage {
  role: string;
  stopReason?: string;
  usage?: AssistantUsage;
}

export function createAccountingState(): AccountingState {
  return {
    activeGoalId: null,
    turnGoalId: null,
    lastAccountedAt: null,
    lastSampledAt: null,
    budgetWarningSentFor: null,
  };
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: AssistantTurnMessage): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

/** The current response is persisted before its tools execute, but counted at turn_end. */
export function assistantTurnTokensForToolCall(entries: SessionEntry[], toolCallId: string): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    return entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)
      ? assistantTurnTokens(entry.message)
      : 0;
  }
  return 0;
}

export function isAbortedAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

interface GoalAccountingDeps {
  getGoal: () => ThreadGoal | null;
  getAccounting: () => AccountingState;
  applyRuntimeAccountingTransition: (ctx: ExtensionContext, nextGoal: ThreadGoal) => void;
  sendMessage: ExtensionAPI["sendMessage"];
}

export function createGoalAccounting(deps: GoalAccountingDeps) {
  const beginAccounting = (newTurn = true): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    if (newTurn) {
      accounting.turnGoalId = goal?.status === "active" ? goal.goalId : null;
    }
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      accounting.lastSampledAt = null;
      return;
    }

    const now = Date.now();
    // Carry unfinished milliseconds without charging the gap before this turn.
    const remainder =
      accounting.activeGoalId === goal.goalId &&
      accounting.lastAccountedAt !== null &&
      accounting.lastSampledAt !== null
        ? accounting.lastSampledAt - accounting.lastAccountedAt
        : 0;
    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = now - remainder;
    accounting.lastSampledAt = now;
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    completedTurnTokens = 0,
    accountBudgetLimited = false,
  ): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    const canAccount = goal?.status === "active" || (accountBudgetLimited && goal?.status === "budgetLimited");
    if (!goal || !canAccount) {
      beginAccounting(false);
      return;
    }
    if (accounting.activeGoalId !== goal.goalId) {
      // Re-arm elapsed time after resume/replacement without changing the response's owner.
      beginAccounting(false);
      if (accounting.activeGoalId !== goal.goalId) {
        return;
      }
    }

    const now = Date.now();
    const lastAccountedAt = accounting.lastAccountedAt ?? now;
    const elapsed = Math.floor((now - lastAccountedAt) / 1000);
    accounting.lastAccountedAt = elapsed < 0 ? now : lastAccountedAt + elapsed * 1000;
    accounting.lastSampledAt = now;

    const tokens = accounting.turnGoalId === goal.goalId ? completedTurnTokens : 0;
    const result = applyUsage(goal, tokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (!result.changed || !result.goal) {
      return;
    }

    deps.applyRuntimeAccountingTransition(ctx, result.goal);

    if (allowBudgetSteering && result.crossedBudget && accounting.budgetWarningSentFor !== result.goal.goalId) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      deps.sendMessage(
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

  return {
    beginAccounting,
    accountProgress,
  };
}
