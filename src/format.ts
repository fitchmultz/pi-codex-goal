import type { GoalStatus, ThreadGoal } from "./types.js";

const COMPACT_TOKEN_UNITS = [
  { suffix: "T", value: 1_000_000_000_000 },
  { suffix: "B", value: 1_000_000_000 },
  { suffix: "M", value: 1_000_000 },
  { suffix: "K", value: 1_000 },
] as const;

export interface GoalToolRecord {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalToolResponse {
  goal: GoalToolRecord | null;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
}

export function formatDuration(seconds: number): string {
  const normalized = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(normalized / 86_400);
  const hours = Math.floor((normalized % 86_400) / 3_600);
  const minutes = Math.floor((normalized % 3_600) / 60);
  const remainingSeconds = normalized % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${remainingSeconds}s`;
}

export function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

export function formatCompactTokenValue(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized < 100_000) {
    return formatInteger(normalized);
  }

  const unit = COMPACT_TOKEN_UNITS.find((candidate) => normalized >= candidate.value);
  if (!unit) {
    return formatInteger(normalized);
  }

  const scaled = normalized / unit.value;
  const fractionDigits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  const compact = scaled.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
  return `${compact}${unit.suffix}`;
}

export function formatTokenValue(value: number): string {
  const exact = formatInteger(value);
  const compact = formatCompactTokenValue(value);
  if (compact === exact) {
    return exact;
  }
  return `${compact} (${exact})`;
}

export function formatBudget(goal: ThreadGoal): string {
  if (goal.tokenBudget === null) {
    return `${formatTokenValue(goal.usage.tokensUsed)} tokens`;
  }
  return `${formatTokenValue(goal.usage.tokensUsed)}/${formatTokenValue(goal.tokenBudget)} tokens`;
}

function statusLabel(status: GoalStatus): string {
  return status === "budgetLimited" ? "limited by budget" : status;
}

function commandHint(status: GoalStatus): string {
  if (status === "active") {
    return "/goal pause, /goal clear";
  }
  if (status === "paused") {
    return "/goal resume, /goal clear";
  }
  if (status === "complete") {
    return "/goal <objective> to replace, /goal clear";
  }
  return "/goal clear";
}

export function formatGoalSummary(goal: ThreadGoal | null): string {
  if (!goal) {
    return ["Usage: /goal <objective>", "No goal is currently set."].join("\n");
  }

  const lines = [
    `Status: ${statusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatDuration(goal.usage.activeSeconds)}`,
    `Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
  ];

  if (goal.tokenBudget !== null) {
    lines.push(`Token budget: ${formatTokenValue(goal.tokenBudget)}`);
  }

  lines.push(`Hint: ${commandHint(goal.status)}`);
  return lines.join("\n");
}

function compactBudgetUsage(goal: ThreadGoal): string {
  if (goal.tokenBudget === null) {
    return `${formatCompactTokenValue(goal.usage.tokensUsed)} tokens`;
  }
  return `${formatCompactTokenValue(goal.usage.tokensUsed)} / ${formatCompactTokenValue(goal.tokenBudget)}`;
}

export function formatFooterStatus(goal: ThreadGoal | null, recoveryAttention: string | null = null): string | undefined {
  if (!goal) {
    return undefined;
  }

  if (goal.status === "budgetLimited") {
    if (goal.tokenBudget !== null) {
      return `Goal unmet (${compactBudgetUsage(goal)} tokens)`;
    }
    return "Goal abandoned";
  }

  if (recoveryAttention) {
    return recoveryAttention;
  }

  if (goal.status === "active") {
    if (goal.tokenBudget !== null) {
      return `Pursuing goal (${compactBudgetUsage(goal)})`;
    }
    if (goal.usage.activeSeconds > 0) {
      return `Pursuing goal (${formatDuration(goal.usage.activeSeconds)})`;
    }
    return "Pursuing goal";
  }

  if (goal.status === "paused") {
    return "Goal paused (/goal resume)";
  }

  if (goal.tokenBudget !== null) {
    return `Goal achieved (${formatCompactTokenValue(goal.usage.tokensUsed)} tokens)`;
  }
  if (goal.usage.activeSeconds > 0) {
    return `Goal achieved (${formatDuration(goal.usage.activeSeconds)})`;
  }
  return "Goal achieved";
}

export function toToolGoal(goal: ThreadGoal): GoalToolRecord {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.usage.tokensUsed,
    timeUsedSeconds: goal.usage.activeSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function remainingTokens(goal: ThreadGoal | null): number | null {
  if (!goal || goal.tokenBudget === null) {
    return null;
  }
  return Math.max(0, goal.tokenBudget - goal.usage.tokensUsed);
}

export function completionBudgetReport(goal: ThreadGoal | null): string | null {
  if (!goal || goal.status !== "complete") {
    return null;
  }
  if (goal.tokenBudget === null && goal.usage.activeSeconds <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (goal.usage.activeSeconds > 0) {
    parts.push(`time used: ${formatDuration(goal.usage.activeSeconds)}.`);
  }
  if (goal.tokenBudget !== null) {
    parts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)} of ${formatInteger(goal.tokenBudget)}.`);
  } else if (goal.usage.tokensUsed > 0) {
    parts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)}.`);
  }

  return `Goal achieved. Report final budget usage to the user: ${parts.join(" ")}`;
}

export function goalToolResponse(goal: ThreadGoal | null, includeCompletionBudgetReport = false): GoalToolResponse {
  return {
    goal: goal ? toToolGoal(goal) : null,
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: includeCompletionBudgetReport ? completionBudgetReport(goal) : null,
  };
}

export function toToolText(goal: ThreadGoal | null, includeCompletionBudgetReport = false): string {
  return JSON.stringify(goalToolResponse(goal, includeCompletionBudgetReport), null, 2);
}
