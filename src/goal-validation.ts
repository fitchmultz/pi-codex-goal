import type {
  GoalCustomEntry,
  GoalUsage,
  ThreadGoal,
  GoalStatus,
  RuntimeUsageGoalStatus,
} from "./types.ts";
import { isRecord } from "./validation.ts";

type RestoredGoalEntry =
  | Exclude<GoalCustomEntry, { kind: "set" | "clear" }>
  | (Omit<Extract<GoalCustomEntry, { kind: "set" }>, "source"> & { source?: unknown })
  | (Omit<Extract<GoalCustomEntry, { kind: "clear" }>, "source"> & { source?: unknown });

export function isGoalCustomEntry(entry: unknown): entry is RestoredGoalEntry {
  if (!isRecord(entry) || entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  switch (entry.kind) {
    case "clear":
      return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
    case "usage":
      return isRuntimeUsageEntry(entry);
    case "host_overflow_cap_reset":
      return typeof entry.active === "boolean";
    case "set":
      return isThreadGoal(entry.goal);
    default:
      return false;
  }
}

function isRuntimeUsageEntry(entry: Record<string, unknown>): boolean {
  return (
    entry.source === "runtime" &&
    typeof entry.goalId === "string" &&
    isRuntimeUsageGoalStatus(entry.status) &&
    isGoalUsage(entry.usage) &&
    typeof entry.updatedAt === "number"
  );
}

export function isGoalUsage(usage: unknown): usage is GoalUsage {
  return (
    isRecord(usage) &&
    typeof usage.tokensUsed === "number" &&
    typeof usage.activeSeconds === "number"
  );
}

export function isRuntimeUsageGoalStatus(status: unknown): status is RuntimeUsageGoalStatus {
  return status === "active" || status === "budgetLimited";
}

function validGoalReason(reason: unknown, required: boolean): boolean {
  if (reason === undefined) {
    return !required;
  }
  return typeof reason === "string" && (!required || reason.trim().length > 0);
}

export function isThreadGoal(goal: unknown): goal is ThreadGoal {
  return isRecord(goal) && isGoalIdentity(goal) && isGoalState(goal);
}

function isGoalIdentity(goal: Record<string, unknown>): boolean {
  return (
    typeof goal.goalId === "string" &&
    typeof goal.objective === "string" &&
    typeof goal.createdAt === "number" &&
    typeof goal.updatedAt === "number"
  );
}

function isGoalState(goal: Record<string, unknown>): boolean {
  return (
    isGoalStatus(goal.status) &&
    validGoalReason(goal.blockedReason, goal.status === "blocked") &&
    validGoalReason(goal.waitingReason, goal.status === "waiting") &&
    (goal.tokenBudget === null || typeof goal.tokenBudget === "number") &&
    isGoalUsage(goal.usage)
  );
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return (
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "waiting" ||
    status === "budgetLimited" ||
    status === "complete"
  );
}
