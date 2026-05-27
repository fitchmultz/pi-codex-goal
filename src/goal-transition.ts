import { goalsEquivalent } from "./state.js";
import type { GoalEntrySource, ThreadGoal } from "./types.js";

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

export interface GoalMemoryEffectPlan {
  clearContinuation: boolean;
  clearActiveAccounting: boolean;
  resetRecovery: boolean;
  clearBudgetWarning: boolean;
}

export function planMemoryEffectsOnGoalChange(
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
  nextGoal: ThreadGoal,
  wasPausedBefore: boolean,
): GoalTransitionEffect[] {
  const effects: GoalTransitionEffect[] = [];
  if (nextGoal.status === "active") {
    effects.push({ type: "markContinuationQueued", goalId: nextGoal.goalId });
  }
  if ((nextGoal.status === "active" && wasPausedBefore) || nextGoal.status === "paused") {
    effects.push({ type: "resetRecovery" });
  }
  return effects;
}

const ABORT_PAUSE_BEFORE_PERSIST: GoalTransitionEffect[] = [
  { type: "clearContinuation" },
  { type: "clearActiveAccounting" },
  { type: "resetRecovery" },
];

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
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source: "runtime",
          beforePersist: ABORT_PAUSE_BEFORE_PERSIST,
          afterPersist: [],
        };
      }
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
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source: "runtime",
          beforePersist: RESUME_ACTIVE_BEFORE_PERSIST,
          afterPersist: [],
        };
      }
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
      const recoveryEffects: GoalTransitionEffect[] = [
        { type: "clearContinuation" },
        { type: "setRecoveryPausedAttention", reason: recoveryReason },
      ];
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source: "runtime",
          beforePersist: recoveryEffects,
          afterPersist: [],
        };
      }
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
      const recoveryEffects: GoalTransitionEffect[] = [
        { type: "clearContinuation" },
        { type: "clearHostOverflowRecovery" },
        { type: "setRecoveryPausedAttention", reason: recoveryReason },
      ];
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source: "runtime",
          beforePersist: recoveryEffects,
          afterPersist: [],
        };
      }
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
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source: "runtime",
          beforePersist: [],
          afterPersist: [],
        };
      }
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
        source === "command" ? commandAfterPersistEffects(nextGoal, wasPausedBefore) : [];
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
