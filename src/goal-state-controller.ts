import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalPersistence } from "./goal-persistence.ts";
import type { StatusContext } from "./goal-runtime-status.ts";
import {
  applyGoalTransitionEffects,
  planGoalTransition,
  reloadGoalRuntimeEffects,
  type GoalTransitionEffectHandlers,
  type GoalTransitionRequest,
  type GoalTransitionPlan,
} from "./goal-transition.ts";
import type { GoalRecoveryMachineState } from "./recovery-machine.ts";
import {
  goalsEquivalent,
  hostOverflowCapResetEntry,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  updateGoalStatus,
} from "./state.ts";
import {
  CUSTOM_ENTRY_TYPE,
  type GoalEntrySource,
  type GoalResult,
  type ThreadGoal,
} from "./types.ts";

interface GoalStateControllerDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  persistence: GoalPersistence;
  getRecoveryState: () => GoalRecoveryMachineState;
  transitionEffectHandlers: GoalTransitionEffectHandlers;
  refreshUi: (ctx: StatusContext) => void;
  invalidateDeliveries: () => void;
}

export interface GoalStateController {
  applyGoalTransition: (request: GoalTransitionRequest, ctx: StatusContext | null) => boolean;
  beginOverflowRecovery: (ctx: StatusContext, needsUserReset?: boolean) => void;
  updateGoal: (
    source: GoalEntrySource,
    ctx: ExtensionContext,
    status: "complete" | "blocked" | "waiting",
    reason?: string,
  ) => GoalResult;
  flushGoalPersistence: GoalPersistence["flushGoalPersistence"];
  getGoal: () => ThreadGoal | null;
  isCurrentActiveGoalId: (goalId: string) => boolean;
  maybeFlushRuntimePersistence: GoalPersistence["maybeFlushRuntimePersistence"];
  pauseForAbort: (ctx: ExtensionContext) => void;
  pauseForRecovery: (ctx: StatusContext, recoveryReason: string) => void;
  persistHostOverflowUserReset: (needsReset: boolean) => void;
  reloadFromSession: (ctx: ExtensionContext) => void;
  resumePausedGoal: (ctx: StatusContext) => void;
  resumeWaitingGoal: (ctx: StatusContext) => boolean;
}

export function createGoalStateController(deps: GoalStateControllerDeps): GoalStateController {
  return new StateController(deps);
}

class StateController implements GoalStateController {
  private readonly deps: GoalStateControllerDeps;
  readonly flushGoalPersistence: GoalPersistence["flushGoalPersistence"];
  readonly maybeFlushRuntimePersistence: GoalPersistence["maybeFlushRuntimePersistence"];

  constructor(deps: GoalStateControllerDeps) {
    this.deps = deps;
    this.flushGoalPersistence = deps.persistence.flushGoalPersistence;
    this.maybeFlushRuntimePersistence = deps.persistence.maybeFlushRuntimePersistence;
  }

  getGoal = (): ThreadGoal | null => this.deps.persistence.getGoal();

  isCurrentActiveGoalId = (goalId: string): boolean => {
    const goal = this.getGoal();
    return goal?.goalId === goalId && goal.status === "active";
  };

  applyGoalTransition = (request: GoalTransitionRequest, ctx: StatusContext | null): boolean => {
    const previous = this.getGoal();
    const plan = planGoalTransition(previous, request);
    if (
      plan.persist === "clear" ||
      (plan.persist !== "skip" &&
        (previous?.goalId !== plan.nextGoal.goalId || previous.status !== plan.nextGoal.status))
    ) {
      this.deps.invalidateDeliveries();
    }

    applyGoalTransitionEffects(plan.beforePersist, this.deps.transitionEffectHandlers);

    const persisted = this.persistTransition(plan);
    if (ctx) {
      this.deps.refreshUi(ctx);
    }
    return persisted;
  };

  private persistTransition(plan: GoalTransitionPlan): boolean {
    if (plan.persist === "defer") {
      this.deps.persistence.setGoalSnapshot(plan.nextGoal);
      return false;
    }
    let persisted = false;
    switch (plan.persist) {
      case "clear":
        this.deps.persistence.appendClearEntry(this.getGoal()?.goalId ?? null, plan.source);
        persisted = true;
        break;
      case "set":
        this.deps.persistence.setGoalSnapshot(plan.nextGoal);
        persisted = this.deps.persistence.flushGoalPersistence(plan.source);
        break;
      case "skip":
        break;
    }
    applyGoalTransitionEffects(plan.afterPersist, this.deps.transitionEffectHandlers);
    return persisted;
  }

  persistHostOverflowUserReset = (needsReset: boolean): void => {
    if (!this.deps.getRecoveryState().applyHostOverflowUserResetPersistence(needsReset)) {
      return;
    }
    this.deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsReset));
  };

  beginOverflowRecovery = (ctx: StatusContext, needsUserReset = true): void => {
    const goal = this.getGoal();
    const hasActiveGoal = Boolean(goal && goal.status === "active");
    let shouldPersist: boolean;

    if (hasActiveGoal) {
      applyGoalTransitionEffects(
        [{ type: "clearContinuation" }],
        this.deps.transitionEffectHandlers,
      );
      const { persistHostOverflowCapReset } = this.deps
        .getRecoveryState()
        .beginHostOverflowRecovery(needsUserReset);
      shouldPersist = persistHostOverflowCapReset;
      this.deps.refreshUi(ctx);
    } else {
      shouldPersist = needsUserReset
        ? this.deps.getRecoveryState().requireHostOverflowUserReset()
        : this.deps.getRecoveryState().applyHostOverflowUserResetPersistence(false);
    }

    if (shouldPersist) {
      this.deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsUserReset));
    }
  };

  reloadFromSession = (ctx: ExtensionContext): void => {
    this.deps.invalidateDeliveries();
    const previousGoalId = this.getGoal()?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    const reconstructed = reconstructGoal(branch).goal;
    this.deps.persistence.setGoalSnapshot(reconstructed);
    this.deps.persistence.syncPersistedSnapshot(reconstructed);
    this.deps
      .getRecoveryState()
      .syncHostOverflowUserResetFromSession(reconstructHostOverflowCapNeedsUserReset(branch));
    applyGoalTransitionEffects(
      reloadGoalRuntimeEffects(previousGoalId, reconstructed),
      this.deps.transitionEffectHandlers,
    );
    this.deps.refreshUi(ctx);
  };

  pauseForAbort = (ctx: ExtensionContext): void => {
    const goal = this.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }

    this.applyGoalTransition({ kind: "abort_pause" }, ctx);
  };

  pauseForRecovery = (ctx: StatusContext, recoveryReason: string): void => {
    const goal = this.getGoal();
    if (goal?.status === "paused") {
      this.deps.getRecoveryState().setRecoveryPausedAttention(recoveryReason);
      this.deps.refreshUi(ctx);
      return;
    }
    if (!goal || goal.status !== "active") {
      return;
    }

    this.applyGoalTransition({ kind: "recovery_pause", recoveryReason }, ctx);
  };

  resumePausedGoal = (ctx: StatusContext): void => {
    const goal = this.getGoal();
    if (!goal || goal.status !== "paused") {
      return;
    }

    this.applyGoalTransition({ kind: "resume_active" }, ctx);
  };

  resumeWaitingGoal = (ctx: StatusContext): boolean => {
    if (this.getGoal()?.status !== "waiting") {
      return false;
    }
    this.applyGoalTransition({ kind: "resume_waiting" }, ctx);
    return true;
  };

  updateGoal = (
    source: GoalEntrySource,
    ctx: ExtensionContext,
    status: "complete" | "blocked" | "waiting",
    reason?: string,
  ): GoalResult => {
    const goal = this.getGoal();
    const result = updateGoalStatus(goal, status, reason);
    if (!result.ok || !result.goal) {
      return result;
    }
    if (goal && goalsEquivalent(goal, result.goal)) {
      return result;
    }
    this.applyGoalTransition({ kind: "set", nextGoal: result.goal, source }, ctx);
    return result;
  };
}
