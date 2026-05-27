import { goalsEquivalent } from "./state.js";
import type { GoalEntrySource, ThreadGoal } from "./types.js";

export type GoalTransitionRequest =
  | {
      kind: "set";
      nextGoal: ThreadGoal;
      source: GoalEntrySource;
      /** Command /goal resume: goal was paused immediately before this transition. */
      wasPausedBefore?: boolean;
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
      crossedBudget: boolean;
    };

export interface GoalMemoryEffectPlan {
  clearContinuation: boolean;
  clearActiveAccounting: boolean;
  resetRecovery: boolean;
  clearBudgetWarning: boolean;
}

interface GoalTransitionEffectPlanShared {
  source: GoalEntrySource;
  markContinuationQueued: boolean;
  resetRecoveryBeforePersist: boolean;
  resetRecoveryAfterPersist: boolean;
  clearContinuationBeforePersist: boolean;
  clearActiveAccountingBeforePersist: boolean;
  clearHostOverflowRecovery: boolean;
  recoveryPausedReason: string | null;
}

export type GoalTransitionEffectPlan =
  | (GoalTransitionEffectPlanShared & {
      persist: "skip";
      nextGoal: ThreadGoal | null;
    })
  | (GoalTransitionEffectPlanShared & {
      persist: "defer";
      nextGoal: ThreadGoal;
      memory: GoalMemoryEffectPlan;
    })
  | (GoalTransitionEffectPlanShared & {
      persist: "set";
      nextGoal: ThreadGoal;
      memory: GoalMemoryEffectPlan;
    })
  | (GoalTransitionEffectPlanShared & {
      persist: "clear";
      nextGoal: null;
      memory: GoalMemoryEffectPlan;
    });

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

function mergeMemoryPlans(...plans: readonly GoalMemoryEffectPlan[]): GoalMemoryEffectPlan {
  return {
    clearContinuation: plans.some((plan) => plan.clearContinuation),
    clearActiveAccounting: plans.some((plan) => plan.clearActiveAccounting),
    resetRecovery: plans.some((plan) => plan.resetRecovery),
    clearBudgetWarning: plans.some((plan) => plan.clearBudgetWarning),
  };
}

function runtimeTransitionShared(): GoalTransitionEffectPlanShared {
  return {
    source: "runtime",
    markContinuationQueued: false,
    resetRecoveryBeforePersist: false,
    resetRecoveryAfterPersist: false,
    clearContinuationBeforePersist: false,
    clearActiveAccountingBeforePersist: false,
    clearHostOverflowRecovery: false,
    recoveryPausedReason: null,
  };
}

function recoveryPauseShared(
  recoveryReason: string,
  clearHostOverflowRecovery: boolean,
): GoalTransitionEffectPlanShared {
  return {
    source: "runtime",
    markContinuationQueued: false,
    resetRecoveryBeforePersist: false,
    resetRecoveryAfterPersist: false,
    clearContinuationBeforePersist: true,
    clearActiveAccountingBeforePersist: false,
    clearHostOverflowRecovery,
    recoveryPausedReason: recoveryReason,
  };
}

export function planGoalTransition(
  current: ThreadGoal | null,
  request: GoalTransitionRequest,
): GoalTransitionEffectPlan {
  switch (request.kind) {
    case "clear": {
      return {
        memory: {
          clearContinuation: true,
          clearActiveAccounting: true,
          resetRecovery: true,
          clearBudgetWarning: true,
        },
        persist: "clear",
        nextGoal: null,
        source: request.source,
        markContinuationQueued: false,
        resetRecoveryBeforePersist: false,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: false,
        clearActiveAccountingBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
      };
    }
    case "abort_pause": {
      const { nextGoal } = request;
      const shared: GoalTransitionEffectPlanShared = {
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: true,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: true,
        clearActiveAccountingBeforePersist: true,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
      };
      if (current && goalsEquivalent(current, nextGoal)) {
        return { ...shared, persist: "skip", nextGoal };
      }
      return {
        ...shared,
        persist: "set",
        nextGoal,
        memory: mergeMemoryPlans(
          {
            clearContinuation: true,
            clearActiveAccounting: true,
            resetRecovery: true,
            clearBudgetWarning: true,
          },
          planMemoryEffectsOnGoalChange(current, nextGoal),
        ),
      };
    }
    case "resume_active": {
      const { nextGoal } = request;
      const shared: GoalTransitionEffectPlanShared = {
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: true,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: true,
        clearActiveAccountingBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
      };
      if (current && goalsEquivalent(current, nextGoal)) {
        return { ...shared, persist: "skip", nextGoal };
      }
      return {
        ...shared,
        persist: "set",
        nextGoal,
        memory: planMemoryEffectsOnGoalChange(current, nextGoal),
      };
    }
    case "recovery_pause": {
      const { nextGoal, recoveryReason } = request;
      const shared = recoveryPauseShared(recoveryReason, false);
      if (current && goalsEquivalent(current, nextGoal)) {
        return { ...shared, persist: "skip", nextGoal };
      }
      return {
        ...shared,
        persist: "set",
        nextGoal,
        memory: planMemoryEffectsOnGoalChange(current, nextGoal),
      };
    }
    case "recovery_shutdown_pause": {
      const { nextGoal, recoveryReason } = request;
      const shared = recoveryPauseShared(recoveryReason, true);
      if (current && goalsEquivalent(current, nextGoal)) {
        return { ...shared, persist: "skip", nextGoal };
      }
      return {
        ...shared,
        persist: "set",
        nextGoal,
        memory: planMemoryEffectsOnGoalChange(current, nextGoal),
      };
    }
    case "runtime_accounting": {
      const { nextGoal, crossedBudget } = request;
      const shared = runtimeTransitionShared();
      if (current && goalsEquivalent(current, nextGoal)) {
        return { ...shared, persist: "skip", nextGoal };
      }
      const memory = planMemoryEffectsOnGoalChange(current, nextGoal);
      if (crossedBudget) {
        return {
          ...shared,
          persist: "set",
          nextGoal,
          memory,
        };
      }
      return {
        ...shared,
        persist: "defer",
        nextGoal,
        memory,
      };
    }
    case "set": {
      const { nextGoal, source, wasPausedBefore = false } = request;
      const commandEffects =
        source === "command"
          ? {
              markContinuationQueued: nextGoal.status === "active",
              resetRecoveryBeforePersist: false,
              resetRecoveryAfterPersist:
                (nextGoal.status === "active" && wasPausedBefore) || nextGoal.status === "paused",
              clearContinuationBeforePersist: false,
              clearActiveAccountingBeforePersist: false,
            }
          : {
              markContinuationQueued: false,
              resetRecoveryBeforePersist: false,
              resetRecoveryAfterPersist: false,
              clearContinuationBeforePersist: false,
              clearActiveAccountingBeforePersist: false,
            };
      const shared: GoalTransitionEffectPlanShared = {
        source,
        markContinuationQueued: commandEffects.markContinuationQueued,
        resetRecoveryBeforePersist: commandEffects.resetRecoveryBeforePersist,
        resetRecoveryAfterPersist: commandEffects.resetRecoveryAfterPersist,
        clearContinuationBeforePersist: commandEffects.clearContinuationBeforePersist,
        clearActiveAccountingBeforePersist: commandEffects.clearActiveAccountingBeforePersist,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
      };
      if (current && goalsEquivalent(current, nextGoal)) {
        return { ...shared, persist: "skip", nextGoal };
      }
      return {
        ...shared,
        persist: "set",
        nextGoal,
        memory: planMemoryEffectsOnGoalChange(current, nextGoal),
      };
    }
    default: {
      const _exhaustive: never = request;
      throw new Error(`Unhandled goal transition request: ${String(_exhaustive)}`);
    }
  }
}

export interface GoalMemoryEffectHandlers {
  clearContinuation: () => void;
  clearActiveAccounting: () => void;
  resetRecovery: () => void;
  clearBudgetWarning: () => void;
}

export function applyGoalMemoryEffects(
  plan: GoalMemoryEffectPlan,
  handlers: GoalMemoryEffectHandlers,
): void {
  if (plan.clearContinuation) {
    handlers.clearContinuation();
  }
  if (plan.clearActiveAccounting) {
    handlers.clearActiveAccounting();
  }
  if (plan.resetRecovery) {
    handlers.resetRecovery();
  }
  if (plan.clearBudgetWarning) {
    handlers.clearBudgetWarning();
  }
}

export interface GoalTransitionPostPersistHandlers {
  resetRecoveryAfterPersist: () => void;
  markContinuationQueued: (goalId: string) => void;
}

export function applyGoalTransitionPostPersistEffects(
  plan: Pick<
    GoalTransitionEffectPlan,
    "resetRecoveryAfterPersist" | "markContinuationQueued" | "nextGoal"
  >,
  handlers: GoalTransitionPostPersistHandlers,
): void {
  if (plan.resetRecoveryAfterPersist) {
    handlers.resetRecoveryAfterPersist();
  }
  if (plan.markContinuationQueued && plan.nextGoal) {
    handlers.markContinuationQueued(plan.nextGoal.goalId);
  }
}
