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
    };

export interface GoalMemoryEffectPlan {
  resetStoppedRuntime: boolean;
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
  resetStoppedRuntimeBeforePersist: boolean;
  clearContinuationBeforePersist: boolean;
  clearHostOverflowRecovery: boolean;
  recoveryPausedReason: string | null;
  stopStatusRefresh: boolean;
  refreshUi: boolean;
}

export type GoalTransitionEffectPlan =
  | (GoalTransitionEffectPlanShared & {
      persist: "skip";
      nextGoal: ThreadGoal | null;
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

  let resetStoppedRuntime = false;
  let clearContinuation = false;
  let clearActiveAccounting = false;
  let resetRecovery = false;
  let clearBudgetWarning = false;

  if (goalIdChanged) {
    resetStoppedRuntime = true;
    clearBudgetWarning = true;
  }
  if (next.status === "complete") {
    resetStoppedRuntime = true;
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
    resetStoppedRuntime,
    clearContinuation,
    clearActiveAccounting,
    resetRecovery,
    clearBudgetWarning,
  };
}

function mergeMemoryPlans(...plans: readonly GoalMemoryEffectPlan[]): GoalMemoryEffectPlan {
  return {
    resetStoppedRuntime: plans.some((plan) => plan.resetStoppedRuntime),
    clearContinuation: plans.some((plan) => plan.clearContinuation),
    clearActiveAccounting: plans.some((plan) => plan.clearActiveAccounting),
    resetRecovery: plans.some((plan) => plan.resetRecovery),
    clearBudgetWarning: plans.some((plan) => plan.clearBudgetWarning),
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
    resetStoppedRuntimeBeforePersist: false,
    clearContinuationBeforePersist: true,
    clearHostOverflowRecovery,
    recoveryPausedReason: recoveryReason,
    stopStatusRefresh: false,
    refreshUi: true,
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
          resetStoppedRuntime: true,
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
        resetStoppedRuntimeBeforePersist: false,
        clearContinuationBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: true,
        refreshUi: true,
      };
    }
    case "abort_pause": {
      const { nextGoal } = request;
      const shared: GoalTransitionEffectPlanShared = {
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: false,
        resetRecoveryAfterPersist: false,
        resetStoppedRuntimeBeforePersist: true,
        clearContinuationBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: true,
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
            resetStoppedRuntime: true,
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
        resetStoppedRuntimeBeforePersist: false,
        clearContinuationBeforePersist: true,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: true,
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
    case "set": {
      const { nextGoal, source, wasPausedBefore = false } = request;
      const commandEffects =
        source === "command"
          ? {
              markContinuationQueued: nextGoal.status === "active",
              resetRecoveryBeforePersist: false,
              resetRecoveryAfterPersist:
                (nextGoal.status === "active" && wasPausedBefore) || nextGoal.status === "paused",
              resetStoppedRuntimeBeforePersist: false,
              clearContinuationBeforePersist: false,
            }
          : {
              markContinuationQueued: false,
              resetRecoveryBeforePersist: false,
              resetRecoveryAfterPersist: false,
              resetStoppedRuntimeBeforePersist: false,
              clearContinuationBeforePersist: false,
            };
      const shared: GoalTransitionEffectPlanShared = {
        source,
        markContinuationQueued: commandEffects.markContinuationQueued,
        resetRecoveryBeforePersist: commandEffects.resetRecoveryBeforePersist,
        resetRecoveryAfterPersist: commandEffects.resetRecoveryAfterPersist,
        resetStoppedRuntimeBeforePersist: commandEffects.resetStoppedRuntimeBeforePersist,
        clearContinuationBeforePersist: commandEffects.clearContinuationBeforePersist,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: true,
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
  resetStoppedRuntime: () => void;
  clearContinuation: () => void;
  clearActiveAccounting: () => void;
  resetRecovery: () => void;
  clearBudgetWarning: () => void;
}

export function applyGoalMemoryEffects(
  plan: GoalMemoryEffectPlan,
  handlers: GoalMemoryEffectHandlers,
): void {
  if (plan.resetStoppedRuntime) {
    handlers.resetStoppedRuntime();
  }
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
    "resetRecoveryAfterPersist" | "markContinuationQueued" | "nextGoal" | "persist"
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
