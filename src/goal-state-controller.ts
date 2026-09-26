import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalPersistence } from "./goal-persistence.ts";
import type { StatusContext } from "./goal-runtime-status.ts";
import {
  applyGoalTransitionEffects,
  planGoalTransition,
  reloadGoalRuntimeEffects,
  type GoalTransitionEffectHandlers,
  type GoalTransitionRequest,
} from "./goal-transition.ts";
import {
  applyHostOverflowUserResetPersistence,
  beginHostOverflowRecovery,
  requireHostOverflowUserReset,
  syncHostOverflowUserResetFromSession,
  type GoalRecoveryMachineState,
} from "./recovery-machine.ts";
import {
  goalsEquivalent,
  hostOverflowCapResetEntry,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  updateGoalStatus,
} from "./state.ts";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.ts";

interface GoalStateControllerDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  persistence: GoalPersistence;
  getRecoveryState: () => GoalRecoveryMachineState;
  transitionEffectHandlers: GoalTransitionEffectHandlers;
  refreshUi: (ctx: StatusContext) => void;
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
  pauseForRecovery: (ctx: ExtensionContext, recoveryReason: string) => void;
  persistHostOverflowUserReset: (needsReset: boolean) => void;
  reloadFromSession: (ctx: ExtensionContext) => void;
  resumePausedGoal: (ctx: StatusContext) => void;
}

export function createGoalStateController(deps: GoalStateControllerDeps) {
  const getGoal = (): ThreadGoal | null => deps.persistence.getGoal();

  const isCurrentActiveGoalId = (goalId: string): boolean => {
    const goal = getGoal();
    return goal?.goalId === goalId && goal.status === "active";
  };

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
      applyGoalTransitionEffects([{ type: "clearContinuation" }], deps.transitionEffectHandlers);
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
    applyGoalTransitionEffects(
      reloadGoalRuntimeEffects(previousGoalId, reconstructed),
      deps.transitionEffectHandlers,
    );
    deps.refreshUi(ctx);
  };

  const pauseForAbort = (ctx: ExtensionContext): void => {
    const goal = getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    applyGoalTransition({ kind: "abort_pause" }, ctx);
  };

  const pauseForRecovery = (ctx: ExtensionContext, recoveryReason: string): void => {
    const goal = getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    applyGoalTransition({ kind: "recovery_pause", recoveryReason }, ctx);
  };

  const resumePausedGoal = (ctx: StatusContext): void => {
    const goal = getGoal();
    if (!goal || goal.status !== "paused") {
      return;
    }

    applyGoalTransition({ kind: "resume_active" }, ctx);
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
    pauseForRecovery,
    persistHostOverflowUserReset,
    reloadFromSession,
    resumePausedGoal,
  };

  return controller;
}
