import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalPersistence } from "./goal-persistence.js";
import type { StatusContext } from "./goal-runtime-status.js";
import {
  applyGoalTransitionEffects,
  planGoalTransition,
  type GoalTransitionEffectHandlers,
  type GoalTransitionRequest,
} from "./goal-transition.js";
import {
  applyHostOverflowUserResetPersistence,
  beginHostOverflowRecovery,
  requireHostOverflowUserReset,
  syncHostOverflowUserResetFromSession,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import {
  goalsEquivalent,
  hostOverflowCapResetEntry,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  updateGoalStatus,
} from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

interface GoalStateControllerDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  persistence: GoalPersistence;
  getRecoveryState: () => GoalRecoveryMachineState;
  transitionEffectHandlers: GoalTransitionEffectHandlers;
  refreshUi: (ctx: StatusContext) => void;
  clearContinuationState: () => void;
  clearActiveAccounting: () => void;
  resetErrorRecovery: () => void;
}

export interface GoalStateController {
  applyGoalTransition: (
    request: GoalTransitionRequest,
    ctx: StatusContext | null,
  ) => boolean;
  beginOverflowRecovery: (ctx: StatusContext) => void;
  completeGoal: (source: GoalEntrySource, ctx: ExtensionContext) => GoalResult;
  flushGoalPersistence: GoalPersistence["flushGoalPersistence"];
  getGoal: () => ThreadGoal | null;
  isCurrentActiveGoalId: (goalId: string) => boolean;
  maybeFlushRuntimePersistence: GoalPersistence["maybeFlushRuntimePersistence"];
  pauseForAbort: (ctx: ExtensionContext) => void;
  persistHostOverflowUserReset: (needsReset: boolean) => void;
  reloadFromSession: (ctx: ExtensionContext) => void;
  resumePausedGoal: (ctx: ExtensionContext) => void;
}

export function createGoalStateController(deps: GoalStateControllerDeps) {
  const getGoal = (): ThreadGoal | null => deps.persistence.getGoal();

  const isCurrentActiveGoalId = (goalId: string): boolean =>
    getGoal()?.goalId === goalId && getGoal()?.status === "active";

  const applyGoalTransition = (
    request: GoalTransitionRequest,
    ctx: StatusContext | null,
  ): boolean => {
    const plan = planGoalTransition(getGoal(), request);

    applyGoalTransitionEffects(plan.beforePersist, deps.transitionEffectHandlers);

    if (plan.persist === "clear") {
      const clearedGoalId = getGoal()?.goalId ?? null;
      deps.persistence.appendClearEntry(clearedGoalId, plan.source);
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
      deps.persistence.setGoalSnapshot(plan.nextGoal);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return false;
    }

    deps.persistence.setGoalSnapshot(plan.nextGoal);
    const persisted = deps.persistence.flushGoalPersistence(plan.source);
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

  const beginOverflowRecovery = (ctx: StatusContext): void => {
    const goal = getGoal();
    const hasActiveGoal = Boolean(goal && goal.status === "active");
    let shouldPersist: boolean;

    if (hasActiveGoal) {
      deps.clearContinuationState();
      const { persistHostOverflowCapReset } = beginHostOverflowRecovery(deps.getRecoveryState());
      shouldPersist = persistHostOverflowCapReset;
      deps.refreshUi(ctx);
    } else {
      shouldPersist = requireHostOverflowUserReset(deps.getRecoveryState());
    }

    if (shouldPersist) {
      deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(true));
    }
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    const previousGoalId = getGoal()?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    const reconstructed = reconstructGoal(branch).goal;
    deps.persistence.setGoalSnapshot(reconstructed);
    deps.persistence.syncPersistedSnapshot(reconstructed);
    syncHostOverflowUserResetFromSession(
      deps.getRecoveryState(),
      reconstructHostOverflowCapNeedsUserReset(branch),
    );
    deps.clearContinuationState();
    if (reconstructed?.status !== "active") {
      deps.clearActiveAccounting();
    }
    if ((reconstructed?.goalId ?? null) !== previousGoalId) {
      deps.resetErrorRecovery();
    }
    deps.refreshUi(ctx);
  };

  const pauseForAbort = (ctx: ExtensionContext): void => {
    const goal = getGoal();
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
    const goal = getGoal();
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
    const goal = getGoal();
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

  const controller: GoalStateController = {
    applyGoalTransition,
    beginOverflowRecovery,
    completeGoal,
    flushGoalPersistence: deps.persistence.flushGoalPersistence,
    getGoal,
    isCurrentActiveGoalId,
    maybeFlushRuntimePersistence: deps.persistence.maybeFlushRuntimePersistence,
    pauseForAbort,
    persistHostOverflowUserReset,
    reloadFromSession,
    resumePausedGoal,
  };

  return controller;
}
