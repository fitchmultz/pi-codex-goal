import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  applyGoalTransitionEffects,
  planGoalTransition,
  type GoalTransitionRequest,
} from "./goal-transition.js";
import {
  applyHostOverflowUserResetPersistence,
  syncHostOverflowUserResetFromSession,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import { RUNTIME_PERSIST_INTERVAL_MS } from "./runtime-config.js";
import type { StatusContext } from "./goal-runtime-status.js";
import {
  clearEntry,
  cloneGoal,
  goalsEquivalent,
  hostOverflowCapResetEntry,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  setEntry,
  updateGoalStatus,
} from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

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

interface GoalPersistenceDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  getRecoveryState: () => GoalRecoveryMachineState;
  transitionEffectHandlers: GoalTransitionEffectHandlers;
  refreshUi: (ctx: StatusContext) => void;
  clearContinuationState: () => void;
  clearActiveAccounting: () => void;
  resetErrorRecovery: () => void;
}

export function createGoalPersistence(deps: GoalPersistenceDeps) {
  let goal: ThreadGoal | null = null;
  let lastPersistedGoal: ThreadGoal | null = null;
  let lastRuntimePersistAt: number | null = null;

  const getGoal = (): ThreadGoal | null => goal;

  const isCurrentActiveGoalId = (goalId: string): boolean =>
    goal?.goalId === goalId && goal.status === "active";

  const flushGoalPersistence = (source: GoalEntrySource): boolean => {
    if (!goal) {
      return false;
    }
    if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) {
      return false;
    }

    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(goal, source));
    lastPersistedGoal = cloneGoal(goal);
    lastRuntimePersistAt = Date.now();
    return true;
  };

  const maybeFlushRuntimePersistence = (source: GoalEntrySource): void => {
    if (!goal || goal.status !== "active") {
      return;
    }
    const now = Date.now();
    if (lastRuntimePersistAt !== null && now - lastRuntimePersistAt < RUNTIME_PERSIST_INTERVAL_MS) {
      return;
    }
    flushGoalPersistence(source);
  };

  const applyGoalTransition = (
    request: GoalTransitionRequest,
    ctx: StatusContext | null,
  ): boolean => {
    const plan = planGoalTransition(goal, request);

    applyGoalTransitionEffects(plan.beforePersist, deps.transitionEffectHandlers);

    if (plan.persist === "clear") {
      const clearedGoalId = goal?.goalId ?? null;
      goal = null;
      lastPersistedGoal = null;
      lastRuntimePersistAt = null;
      deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, plan.source));
      applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return true;
    }

    if (plan.persist === "skip") {
      applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return false;
    }

    if (plan.persist === "defer") {
      goal = plan.nextGoal;
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return false;
    }

    goal = plan.nextGoal;
    const persisted = flushGoalPersistence(plan.source);
    applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
    if (ctx) {
      deps.refreshUi(ctx);
    }

    return persisted;
  };

  const persistHostOverflowUserReset = (needsReset: boolean): void => {
    if (!applyHostOverflowUserResetPersistence(deps.getRecoveryState(), needsReset)) {
      return;
    }
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsReset));
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    const previousGoalId = goal?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    goal = reconstructGoal(branch).goal;
    lastPersistedGoal = goal ? cloneGoal(goal) : null;
    lastRuntimePersistAt = null;
    syncHostOverflowUserResetFromSession(
      deps.getRecoveryState(),
      reconstructHostOverflowCapNeedsUserReset(branch),
    );
    deps.clearContinuationState();
    if (goal?.status !== "active") {
      deps.clearActiveAccounting();
    }
    if ((goal?.goalId ?? null) !== previousGoalId) {
      deps.resetErrorRecovery();
    }
    deps.refreshUi(ctx);
  };

  const pauseForAbort = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active") {
      return;
    }

    const result = updateGoalStatus(goal, "paused");
    if (!result.ok || !result.goal) {
      return;
    }

    applyGoalTransition({ kind: "abort_pause", nextGoal: result.goal }, ctx);
  };

  const resumePausedGoal = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "paused") {
      return;
    }

    const result = updateGoalStatus(goal, "active");
    if (!result.ok || !result.goal) {
      return;
    }

    if (result.goal.status === "active") {
      applyGoalTransition({ kind: "resume_active", nextGoal: result.goal }, ctx);
      return;
    }

    applyGoalTransition({ kind: "set", nextGoal: result.goal, source: "runtime" }, ctx);
  };

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    const result = updateGoalStatus(goal, "complete");
    if (!result.ok || !result.goal) {
      return result;
    }
    if (goal && goalsEquivalent(goal, result.goal)) {
      return result;
    }
    applyGoalTransition({ kind: "set", nextGoal: result.goal, source }, ctx);
    return result;
  };

  return {
    applyGoalTransition,
    completeGoal,
    flushGoalPersistence,
    getGoal,
    isCurrentActiveGoalId,
    maybeFlushRuntimePersistence,
    pauseForAbort,
    persistHostOverflowUserReset,
    reloadFromSession,
    resumePausedGoal,
  };
}
