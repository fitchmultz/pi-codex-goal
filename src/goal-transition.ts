import { goalsEquivalent } from "./state.js";
import type { GoalEntrySource, GoalStatus, ThreadGoal } from "./types.js";

export type GoalTransitionRequest =
  | {
      kind: "set";
      nextGoal: ThreadGoal;
      source: GoalEntrySource;
    }
  | { kind: "clear"; source: GoalEntrySource }
  | { kind: "abort_pause"; nextGoal: ThreadGoal }
  | { kind: "resume_active"; nextGoal: ThreadGoal }
  | {
      kind: "recovery_pause";
      nextGoal: ThreadGoal;
      recoveryReason: string;
    }
  | {
      kind: "recovery_shutdown_pause";
      nextGoal: ThreadGoal;
      recoveryReason: string;
    }
  | {
      kind: "runtime_accounting";
      nextGoal: ThreadGoal;
    };

export type GoalTransitionEffect =
  | { type: "clearContinuation" }
  | { type: "clearActiveAccounting" }
  | { type: "resetRecovery" }
  | { type: "clearBudgetWarning" }
  | { type: "clearHostOverflowRecovery" }
  | { type: "setRecoveryPausedAttention"; reason: string }
  | { type: "markContinuationQueued"; goalId: string }
  | { type: "stopStatusRefresh" };

export type GoalTransitionPlan = {
  persist: "skip" | "defer" | "set" | "clear";
  nextGoal: ThreadGoal | null;
  source: GoalEntrySource;
  beforePersist: GoalTransitionEffect[];
  afterPersist: GoalTransitionEffect[];
};

interface GoalMemoryEffectPlan {
  clearContinuation: boolean;
  clearActiveAccounting: boolean;
  resetRecovery: boolean;
  clearBudgetWarning: boolean;
}

function planMemoryEffectsOnGoalChange(
  previous: ThreadGoal | null,
  next: ThreadGoal,
): GoalMemoryEffectPlan {
  const goalIdChanged = (previous?.goalId ?? null) !== next.goalId;

  let clearContinuation = false;
  let clearActiveAccounting = false;
  let resetRecovery = false;
  let clearBudgetWarning = false;

  if (goalIdChanged) {
    clearContinuation = true;
    clearActiveAccounting = true;
    resetRecovery = true;
    clearBudgetWarning = true;
  }
  if (next.status === "complete") {
    clearContinuation = true;
    clearActiveAccounting = true;
    resetRecovery = true;
  } else if (next.status === "paused") {
    clearContinuation = true;
    clearActiveAccounting = true;
  } else if (next.status === "budgetLimited") {
    clearContinuation = true;
    clearActiveAccounting = true;
    resetRecovery = true;
  }
  if (next.status !== "budgetLimited") {
    clearBudgetWarning = true;
  }

  return {
    clearContinuation,
    clearActiveAccounting,
    resetRecovery,
    clearBudgetWarning,
  };
}

function memoryEffectsFromGoalChange(
  previous: ThreadGoal | null,
  next: ThreadGoal,
): GoalTransitionEffect[] {
  const plan = planMemoryEffectsOnGoalChange(previous, next);
  const effects: GoalTransitionEffect[] = [];
  if (plan.clearContinuation) {
    effects.push({ type: "clearContinuation" });
  }
  if (plan.clearActiveAccounting) {
    effects.push({ type: "clearActiveAccounting" });
  }
  if (plan.resetRecovery) {
    effects.push({ type: "resetRecovery" });
  }
  if (plan.clearBudgetWarning) {
    effects.push({ type: "clearBudgetWarning" });
  }
  return effects;
}

function effectKey(effect: GoalTransitionEffect): string {
  return effect.type;
}

function uniqueEffects(effects: readonly GoalTransitionEffect[]): GoalTransitionEffect[] {
  const seen = new Set<string>();
  const result: GoalTransitionEffect[] = [];
  for (const effect of effects) {
    const key = effectKey(effect);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(effect);
  }
  return result;
}

function crossedBudgetTransition(current: ThreadGoal | null, nextGoal: ThreadGoal): boolean {
  return current?.status !== "budgetLimited" && nextGoal.status === "budgetLimited";
}

function commandAfterPersistEffects(
  current: ThreadGoal | null,
  nextGoal: ThreadGoal,
  wasPausedBefore: boolean,
): GoalTransitionEffect[] {
  const goalIdChanged = (current?.goalId ?? null) !== nextGoal.goalId;
  const effects: GoalTransitionEffect[] = [];
  if (nextGoal.status === "active") {
    effects.push({ type: "markContinuationQueued", goalId: nextGoal.goalId });
  }
  if (nextGoal.status === "paused" && !goalIdChanged) {
    effects.push({ type: "resetRecovery" });
  } else if (nextGoal.status === "active" && wasPausedBefore && !goalIdChanged) {
    effects.push({ type: "resetRecovery" });
  }
  return effects;
}

const ABORT_PAUSE_SET_BEFORE_PERSIST: GoalTransitionEffect[] = [
  { type: "clearContinuation" },
  { type: "clearActiveAccounting" },
  { type: "resetRecovery" },
  { type: "clearBudgetWarning" },
];

const RESUME_ACTIVE_BEFORE_PERSIST: GoalTransitionEffect[] = [
  { type: "clearContinuation" },
  { type: "resetRecovery" },
];

const CLEAR_BEFORE_PERSIST: GoalTransitionEffect[] = [
  { type: "clearContinuation" },
  { type: "clearActiveAccounting" },
  { type: "resetRecovery" },
  { type: "clearBudgetWarning" },
];

const RUNTIME_ACCOUNTING_STATUSES = new Set<GoalStatus>(["active", "budgetLimited"]);

function transitionInvariantError(kind: string, detail: string): Error {
  return new Error(`Invalid ${kind} transition: ${detail}`);
}

function requireCurrentGoal(
  current: ThreadGoal | null,
  kind: string,
): asserts current is ThreadGoal {
  if (!current) {
    throw transitionInvariantError(kind, "current goal is required");
  }
}

function requireSameGoalId(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.goalId !== nextGoal.goalId) {
    throw transitionInvariantError(
      kind,
      `goalId mismatch (current=${current.goalId}, next=${nextGoal.goalId})`,
    );
  }
}

function requireUnchangedObjective(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.objective !== nextGoal.objective) {
    throw transitionInvariantError(kind, "objective must be unchanged");
  }
}

function requireUnchangedTokenBudget(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.tokenBudget !== nextGoal.tokenBudget) {
    throw transitionInvariantError(kind, "tokenBudget must be unchanged");
  }
}

function requireUnchangedCreatedAt(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.createdAt !== nextGoal.createdAt) {
    throw transitionInvariantError(kind, "createdAt must be unchanged");
  }
}

function requireUnchangedUsage(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.usage.tokensUsed !== nextGoal.usage.tokensUsed) {
    throw transitionInvariantError(kind, "usage.tokensUsed must be unchanged");
  }
  if (current.usage.activeSeconds !== nextGoal.usage.activeSeconds) {
    throw transitionInvariantError(kind, "usage.activeSeconds must be unchanged");
  }
}

function requireNonRewindingUpdatedAt(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (nextGoal.updatedAt < current.updatedAt) {
    throw transitionInvariantError(kind, "updatedAt must not decrease");
  }
}

function requireRuntimeAccountingChange(
  current: ThreadGoal,
  nextGoal: ThreadGoal,
  kind: string,
): void {
  const usageIncreased =
    nextGoal.usage.tokensUsed > current.usage.tokensUsed ||
    nextGoal.usage.activeSeconds > current.usage.activeSeconds;
  const statusChanged = current.status !== nextGoal.status;
  if (!usageIncreased && !statusChanged) {
    throw transitionInvariantError(
      kind,
      "runtime accounting must increase usage or change status",
    );
  }
}

function requireStatusHelperImmutableFields(
  current: ThreadGoal,
  nextGoal: ThreadGoal,
  kind: string,
): void {
  requireUnchangedObjective(current, nextGoal, kind);
  requireUnchangedTokenBudget(current, nextGoal, kind);
  requireUnchangedUsage(current, nextGoal, kind);
  requireUnchangedCreatedAt(current, nextGoal, kind);
  requireNonRewindingUpdatedAt(current, nextGoal, kind);
}

function requireNonDecreasingUsage(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (nextGoal.usage.tokensUsed < current.usage.tokensUsed) {
    throw transitionInvariantError(kind, "usage.tokensUsed must not decrease");
  }
  if (nextGoal.usage.activeSeconds < current.usage.activeSeconds) {
    throw transitionInvariantError(kind, "usage.activeSeconds must not decrease");
  }
}

function requireBudgetLimitedUsageAtOrOverBudget(nextGoal: ThreadGoal, kind: string): void {
  if (nextGoal.tokenBudget === null) {
    throw transitionInvariantError(
      kind,
      "tokenBudget must be set when next status is budgetLimited",
    );
  }
  if (nextGoal.usage.tokensUsed < nextGoal.tokenBudget) {
    throw transitionInvariantError(
      kind,
      "usage.tokensUsed must be at or above tokenBudget when next status is budgetLimited",
    );
  }
}

function validateActiveToPausedTransition(
  kind: "abort_pause" | "recovery_pause" | "recovery_shutdown_pause",
  current: ThreadGoal | null,
  nextGoal: ThreadGoal,
): void {
  requireCurrentGoal(current, kind);
  requireSameGoalId(current, nextGoal, kind);
  if (current.status !== "active") {
    throw transitionInvariantError(
      kind,
      `current status must be active (got ${current.status})`,
    );
  }
  if (nextGoal.status !== "paused") {
    throw transitionInvariantError(kind, `next status must be paused (got ${nextGoal.status})`);
  }
  requireStatusHelperImmutableFields(current, nextGoal, kind);
}

function validateAbortPause(current: ThreadGoal | null, nextGoal: ThreadGoal): void {
  validateActiveToPausedTransition("abort_pause", current, nextGoal);
}

function validateResumeActive(current: ThreadGoal | null, nextGoal: ThreadGoal): void {
  const kind = "resume_active";
  requireCurrentGoal(current, kind);
  requireSameGoalId(current, nextGoal, kind);
  if (current.status !== "paused") {
    throw transitionInvariantError(
      kind,
      `current status must be paused (got ${current.status})`,
    );
  }
  if (nextGoal.status !== "active") {
    throw transitionInvariantError(kind, `next status must be active (got ${nextGoal.status})`);
  }
  requireStatusHelperImmutableFields(current, nextGoal, kind);
}

function validateRuntimeAccounting(current: ThreadGoal | null, nextGoal: ThreadGoal): void {
  const kind = "runtime_accounting";
  requireCurrentGoal(current, kind);
  requireSameGoalId(current, nextGoal, kind);
  if (!RUNTIME_ACCOUNTING_STATUSES.has(current.status)) {
    throw transitionInvariantError(
      kind,
      `current status must be active or budgetLimited (got ${current.status})`,
    );
  }
  if (nextGoal.status === "paused" || nextGoal.status === "complete") {
    throw transitionInvariantError(
      kind,
      `next status must be active or budgetLimited (got ${nextGoal.status})`,
    );
  }
  if (!RUNTIME_ACCOUNTING_STATUSES.has(nextGoal.status)) {
    throw transitionInvariantError(
      kind,
      `next status must be active or budgetLimited (got ${nextGoal.status})`,
    );
  }
  if (current.status === "budgetLimited" && nextGoal.status === "active") {
    throw transitionInvariantError(
      kind,
      "budgetLimited goals cannot transition to active via runtime accounting",
    );
  }
  requireUnchangedObjective(current, nextGoal, kind);
  requireUnchangedTokenBudget(current, nextGoal, kind);
  requireUnchangedCreatedAt(current, nextGoal, kind);
  requireNonRewindingUpdatedAt(current, nextGoal, kind);
  requireNonDecreasingUsage(current, nextGoal, kind);
  requireRuntimeAccountingChange(current, nextGoal, kind);
  if (nextGoal.status === "budgetLimited") {
    requireBudgetLimitedUsageAtOrOverBudget(nextGoal, kind);
  }
}

export function planGoalTransition(
  current: ThreadGoal | null,
  request: GoalTransitionRequest,
): GoalTransitionPlan {
  switch (request.kind) {
    case "clear": {
      return {
        persist: "clear",
        nextGoal: null,
        source: request.source,
        beforePersist: CLEAR_BEFORE_PERSIST,
        afterPersist: [{ type: "stopStatusRefresh" }],
      };
    }
    case "abort_pause": {
      const { nextGoal } = request;
      validateAbortPause(current, nextGoal);
      return {
        persist: "set",
        nextGoal,
        source: "runtime",
        beforePersist: uniqueEffects([
          ...ABORT_PAUSE_SET_BEFORE_PERSIST,
          ...memoryEffectsFromGoalChange(current, nextGoal),
        ]),
        afterPersist: [],
      };
    }
    case "resume_active": {
      const { nextGoal } = request;
      validateResumeActive(current, nextGoal);
      return {
        persist: "set",
        nextGoal,
        source: "runtime",
        beforePersist: uniqueEffects([
          ...RESUME_ACTIVE_BEFORE_PERSIST,
          ...memoryEffectsFromGoalChange(current, nextGoal),
        ]),
        afterPersist: [],
      };
    }
    case "recovery_pause": {
      const { nextGoal, recoveryReason } = request;
      validateActiveToPausedTransition("recovery_pause", current, nextGoal);
      const recoveryEffects: GoalTransitionEffect[] = [
        { type: "clearContinuation" },
        { type: "setRecoveryPausedAttention", reason: recoveryReason },
      ];
      return {
        persist: "set",
        nextGoal,
        source: "runtime",
        beforePersist: uniqueEffects([
          ...recoveryEffects,
          ...memoryEffectsFromGoalChange(current, nextGoal),
        ]),
        afterPersist: [],
      };
    }
    case "recovery_shutdown_pause": {
      const { nextGoal, recoveryReason } = request;
      validateActiveToPausedTransition("recovery_shutdown_pause", current, nextGoal);
      const recoveryEffects: GoalTransitionEffect[] = [
        { type: "clearContinuation" },
        { type: "clearHostOverflowRecovery" },
        { type: "setRecoveryPausedAttention", reason: recoveryReason },
      ];
      return {
        persist: "set",
        nextGoal,
        source: "runtime",
        beforePersist: uniqueEffects([
          ...recoveryEffects,
          ...memoryEffectsFromGoalChange(current, nextGoal),
        ]),
        afterPersist: [],
      };
    }
    case "runtime_accounting": {
      const { nextGoal } = request;
      validateRuntimeAccounting(current, nextGoal);
      const beforePersist = memoryEffectsFromGoalChange(current, nextGoal);
      if (crossedBudgetTransition(current, nextGoal)) {
        return {
          persist: "set",
          nextGoal,
          source: "runtime",
          beforePersist,
          afterPersist: [],
        };
      }
      return {
        persist: "defer",
        nextGoal,
        source: "runtime",
        beforePersist,
        afterPersist: [],
      };
    }
    case "set": {
      const { nextGoal, source } = request;
      const wasPausedBefore = current?.status === "paused";
      const afterPersist =
        source === "command"
          ? commandAfterPersistEffects(current, nextGoal, wasPausedBefore)
          : [];
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source,
          beforePersist: [],
          afterPersist,
        };
      }
      return {
        persist: "set",
        nextGoal,
        source,
        beforePersist: memoryEffectsFromGoalChange(current, nextGoal),
        afterPersist,
      };
    }
    default: {
      const _exhaustive: never = request;
      throw new Error(`Unhandled goal transition request: ${String(_exhaustive)}`);
    }
  }
}

export interface GoalTransitionEffectHandlers {
  clearContinuation: () => void;
  clearActiveAccounting: () => void;
  resetRecovery: () => void;
  clearBudgetWarning: () => void;
  clearHostOverflowRecovery: () => void;
  setRecoveryPausedAttention: (reason: string) => void;
  markContinuationQueued: (goalId: string) => void;
  stopStatusRefresh: () => void;
}

export function applyGoalTransitionEffects(
  effects: readonly GoalTransitionEffect[],
  handlers: GoalTransitionEffectHandlers,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearContinuation":
        handlers.clearContinuation();
        break;
      case "clearActiveAccounting":
        handlers.clearActiveAccounting();
        break;
      case "resetRecovery":
        handlers.resetRecovery();
        break;
      case "clearBudgetWarning":
        handlers.clearBudgetWarning();
        break;
      case "clearHostOverflowRecovery":
        handlers.clearHostOverflowRecovery();
        break;
      case "setRecoveryPausedAttention":
        handlers.setRecoveryPausedAttention(effect.reason);
        break;
      case "markContinuationQueued":
        handlers.markContinuationQueued(effect.goalId);
        break;
      case "stopStatusRefresh":
        handlers.stopStatusRefresh();
        break;
      default: {
        const _exhaustive: never = effect;
        throw new Error(`Unhandled goal transition effect: ${String(_exhaustive)}`);
      }
    }
  }
}
