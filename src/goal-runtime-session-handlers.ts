import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import { filterGoalCompactionInput } from "./goal-compaction.ts";
import {
  recoveryPhaseBlocksContinuation,
  recoveryPhaseNeedsUserStartTurn,
  type GoalRecoveryMachineState,
} from "./recovery-machine.ts";
import { isRecoveryPendingAttention, reasonFromRecoveryPendingAttention } from "./recovery.ts";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.ts";
import type {
  GoalRuntimeSessionHandlerContext,
  GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handler-types.ts";
import type { ThreadGoal } from "./types.ts";

export function createSessionEventHandlers(
  deps: GoalRuntimeSessionHandlerContext,
): Pick<
  GoalRuntimeEventHandlers,
  | "onSessionStart"
  | "onSessionTree"
  | "onSessionBeforeCompact"
  | "onSessionCompact"
  | "onSessionCompactFailed"
  | "onSessionShutdown"
> {
  const handlers = new SessionEventHandlers(deps);
  return {
    onSessionStart: handlers.onSessionStart,
    onSessionTree: handlers.onSessionTree,
    onSessionBeforeCompact: handlers.onSessionBeforeCompact,
    onSessionCompact: handlers.onSessionCompact,
    onSessionCompactFailed: handlers.onSessionCompactFailed,
    onSessionShutdown: handlers.onSessionShutdown,
  };
}

class SessionEventHandlers {
  private readonly deps: GoalRuntimeSessionHandlerContext;

  constructor(deps: GoalRuntimeSessionHandlerContext) {
    this.deps = deps;
  }

  private readonly pauseRestoredOverflow = (ctx: ExtensionContext): boolean => {
    const goal = this.deps.stateController.getGoal();
    if (
      (goal?.status !== "active" && goal?.status !== "paused") ||
      this.deps.runtimeState.recoveryState.phase.kind !== "hostOverflowNeedsUserStart"
    ) {
      return false;
    }
    this.deps.stateController.pauseForRecovery(
      ctx,
      "Restored overflow recovery is paused. Reduce context or switch models, then send a genuine user message before /goal resume.",
    );
    return true;
  };

  private readonly schedulePostCompactContinuationFallback = (
    ctx: ExtensionContext,
    options: { clearHostOverflowRecovery: boolean },
  ): void => {
    const fallbackOptions = {
      turnIndex: this.deps.runtimeState.currentTurnIndex,
      agentRunSequence: this.deps.runtimeState.agentRunSequence,
    };
    this.deps.continuation.maybeContinueAfterPostCompactFallback(
      ctx,
      options.clearHostOverflowRecovery
        ? {
            ...fallbackOptions,
            prepareContinuation: () => {
              if (!recoveryPhaseBlocksContinuation(this.deps.runtimeState.recoveryState.phase)) {
                return false;
              }
              this.deps.runtimeState.recoveryState.clearActiveHostOverflowRecovery();
              if (recoveryPhaseNeedsUserStartTurn(this.deps.runtimeState.recoveryState.phase)) {
                this.deps.stateController.pauseForRecovery(
                  ctx,
                  "Native overflow retry did not start. Goal cannot reset its allowance; send a genuine user message after reducing context or switching models, then /goal resume.",
                );
                return false;
              }
              this.deps.status.refreshUi(ctx);
              return true;
            },
          }
        : fallbackOptions,
    );
  };

  onSessionStart = (async (event, ctx) => {
    this.deps.continuation.clearPostCompactContinuationFallback();
    this.deps.providerLimitAutoResume.clear();
    this.deps.clearActiveAccounting();
    this.deps.stateController.reloadFromSession(ctx);
    this.deps.continuation.restoreCompactionRefresh(ctx.sessionManager.getBranch());
    this.deps.goalAccounting.beginAccounting();
    if (this.pauseRestoredOverflow(ctx)) {
      return;
    }
    const goal = this.deps.stateController.getGoal();
    const pausedGoal = goal?.status === "paused" ? goal : null;
    if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
      const shouldResume = await ctx.ui.confirm(
        "Resume paused goal?",
        `Goal: ${pausedGoal.objective}`,
      );
      if (shouldResume) {
        this.deps.resumeGoalWithContinuation(pausedGoal.goalId, "runtime", ctx);
        this.deps.goalAccounting.beginAccounting();
        return;
      }
    }
    this.deps.continuation.maybeContinue(ctx);
  }) satisfies ExtensionHandler<SessionStartEvent>;

  onSessionTree = (async (_event, ctx) => {
    this.deps.continuation.clearPostCompactContinuationFallback();
    this.deps.providerLimitAutoResume.clear();
    this.deps.clearActiveAccounting();
    this.deps.stateController.reloadFromSession(ctx);
    this.deps.continuation.restoreCompactionRefresh(ctx.sessionManager.getBranch());
    this.deps.goalAccounting.beginAccounting();
    if (this.pauseRestoredOverflow(ctx)) {
      return;
    }
    this.deps.continuation.maybeContinue(ctx);
  }) satisfies ExtensionHandler<SessionTreeEvent>;

  onSessionBeforeCompact = (async (event, ctx) => {
    filterGoalCompactionInput(event.preparation);
    if (
      runStaleQueuedWorkPlan(
        this.deps.runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact(),
        ctx,
        this.deps,
      )
    ) {
      return;
    }

    this.deps.goalAccounting.accountProgress(ctx, false, 0, true);
    this.deps.stateController.flushGoalPersistence("runtime");
  }) satisfies ExtensionHandler<SessionBeforeCompactEvent>;

  onSessionCompact = (async (event, ctx) => {
    this.deps.continuation.requireFullGoal();
    if (
      runStaleQueuedWorkPlan(
        this.deps.runtimeState.staleQueuedWorkGuard.planSessionCompact(),
        ctx,
        this.deps,
      )
    ) {
      return;
    }

    this.deps.stateController.flushGoalPersistence("runtime");
    const wasRecoveringFromHostOverflow = recoveryPhaseBlocksContinuation(
      this.deps.runtimeState.recoveryState.phase,
    );
    this.deps.recoveryRuntime.onSessionCompact();
    this.deps.status.refreshUi(ctx);
    if (event.willRetry) {
      this.schedulePostCompactContinuationFallback(ctx, {
        clearHostOverflowRecovery: wasRecoveringFromHostOverflow,
      });
      return;
    }
    if (!recoveryPhaseBlocksContinuation(this.deps.runtimeState.recoveryState.phase)) {
      this.deps.continuation.maybeContinueAfterCurrentEvent(ctx);
    } else if (wasRecoveringFromHostOverflow) {
      this.schedulePostCompactContinuationFallback(ctx, { clearHostOverflowRecovery: true });
    }
  }) satisfies ExtensionHandler<SessionCompactEvent>;

  onSessionCompactFailed = (async (event, ctx) => {
    if (event.reason !== "overflow") {
      return;
    }
    this.deps.continuation.clearPostCompactContinuationFallback();
    this.deps.continuation.clearContinuationTimer();
    this.deps.stateController.pauseForRecovery(
      ctx,
      "Native context overflow recovery stopped. Goal follow-ups cannot reset its allowance; reduce context or switch models, then send a genuine user message before /goal resume.",
    );
  }) satisfies ExtensionHandler<SessionCompactFailedEvent>;

  onSessionShutdown = (async (_event, ctx) => {
    this.deps.deliveries.invalidate();
    this.deps.continuation.clearPostCompactContinuationFallback();
    this.deps.providerLimitAutoResume.clear();
    this.deps.continuation.clearContinuationTimer();
    applyStaleQueuedWorkEffects(
      this.deps.runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects,
      ctx,
      this.deps,
    );

    this.deps.goalAccounting.accountProgress(ctx, false, 0, true);
    this.deps.stateController.flushGoalPersistence("runtime");
    if (hasPendingRecoveryAttention(this.deps)) {
      pauseForPendingRecoveryShutdown(ctx, this.deps);
    } else {
      this.deps.resetErrorRecovery();
    }
    this.deps.status.stopStatusRefresh();
  }) satisfies ExtensionHandler<SessionShutdownEvent>;
}

interface PendingRecoveryShutdownContext {
  recoveryState: Pick<GoalRecoveryMachineState, "attention">;
  getGoal: () => ThreadGoal | null;
}

export function pendingRecoveryShutdownReason({
  recoveryState,
  getGoal,
}: PendingRecoveryShutdownContext): string | null {
  const goal = getGoal();
  if (goal?.status !== "active" || !isRecoveryPendingAttention(recoveryState.attention)) {
    return null;
  }
  return reasonFromRecoveryPendingAttention(recoveryState.attention);
}

function hasPendingRecoveryAttention({
  runtimeState,
  stateController,
}: GoalRuntimeSessionHandlerContext): boolean {
  return (
    pendingRecoveryShutdownReason({
      recoveryState: runtimeState.recoveryState,
      getGoal: stateController.getGoal,
    }) !== null
  );
}

function pauseForPendingRecoveryShutdown(
  ctx: ExtensionContext,
  deps: GoalRuntimeSessionHandlerContext,
): void {
  const { runtimeState, stateController } = deps;
  const reason = pendingRecoveryShutdownReason({
    recoveryState: runtimeState.recoveryState,
    getGoal: stateController.getGoal,
  });
  if (reason === null || reason.length === 0) {
    return;
  }

  stateController.applyGoalTransition(
    {
      kind: "recovery_shutdown_pause",
      recoveryReason: reason,
    },
    ctx,
  );
}
