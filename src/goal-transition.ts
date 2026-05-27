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
  | { kind: "recovery_pause"; nextGoal: ThreadGoal }
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

export interface GoalTransitionEffectPlan {
  memory: GoalMemoryEffectPlan;
  persist: "set" | "clear" | "skip";
  nextGoal: ThreadGoal | null;
  source: GoalEntrySource;
  markContinuationQueued: boolean;
  resetRecoveryBeforePersist: boolean;
  resetRecoveryAfterPersist: boolean;
  clearContinuationBeforePersist: boolean;
  clearHostOverflowRecovery: boolean;
  recoveryPausedReason: string | null;
  stopStatusRefresh: boolean;
  refreshUi: boolean;
}

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

export function planGoalTransition(
  current: ThreadGoal | null,
  request: GoalTransitionRequest,
): GoalTransitionEffectPlan | null {
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
        clearContinuationBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: true,
        refreshUi: true,
      };
    }
    case "abort_pause": {
      const { nextGoal } = request;
      return {
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
        persist: current && goalsEquivalent(current, nextGoal) ? "skip" : "set",
        nextGoal,
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: false,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: true,
      };
    }
    case "resume_active": {
      const { nextGoal } = request;
      return {
        memory: planMemoryEffectsOnGoalChange(current, nextGoal),
        persist: current && goalsEquivalent(current, nextGoal) ? "skip" : "set",
        nextGoal,
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: true,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: true,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: true,
      };
    }
    case "recovery_pause": {
      return {
        memory: planMemoryEffectsOnGoalChange(current, request.nextGoal),
        persist: current && goalsEquivalent(current, request.nextGoal) ? "skip" : "set",
        nextGoal: request.nextGoal,
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: false,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: false,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: false,
      };
    }
    case "recovery_shutdown_pause": {
      return {
        memory: planMemoryEffectsOnGoalChange(current, request.nextGoal),
        persist: current && goalsEquivalent(current, request.nextGoal) ? "skip" : "set",
        nextGoal: request.nextGoal,
        source: "runtime",
        markContinuationQueued: false,
        resetRecoveryBeforePersist: false,
        resetRecoveryAfterPersist: false,
        clearContinuationBeforePersist: true,
        clearHostOverflowRecovery: true,
        recoveryPausedReason: request.recoveryReason,
        stopStatusRefresh: false,
        refreshUi: true,
      };
    }
    case "set": {
      const { nextGoal, source, wasPausedBefore = false } = request;
      const persist =
        current && goalsEquivalent(current, nextGoal) ? ("skip" as const) : ("set" as const);
      const commandEffects =
        source === "command"
          ? {
              markContinuationQueued: nextGoal.status === "active",
              resetRecoveryBeforePersist: false,
              resetRecoveryAfterPersist:
                (nextGoal.status === "active" && wasPausedBefore) || nextGoal.status === "paused",
              clearContinuationBeforePersist: false,
            }
          : {
              markContinuationQueued: false,
              resetRecoveryBeforePersist: false,
              resetRecoveryAfterPersist: false,
              clearContinuationBeforePersist: false,
            };

      return {
        memory: planMemoryEffectsOnGoalChange(current, nextGoal),
        persist,
        nextGoal,
        source,
        markContinuationQueued: commandEffects.markContinuationQueued,
        resetRecoveryBeforePersist: commandEffects.resetRecoveryBeforePersist,
        resetRecoveryAfterPersist: commandEffects.resetRecoveryAfterPersist,
        clearContinuationBeforePersist: commandEffects.clearContinuationBeforePersist,
        clearHostOverflowRecovery: false,
        recoveryPausedReason: null,
        stopStatusRefresh: false,
        refreshUi: true,
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
    return;
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
