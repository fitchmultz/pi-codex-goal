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
  clearActiveHostOverflowRecovery,
  recoveryPhaseBlocksContinuation,
  recoveryPhaseNeedsUserStartTurn,
} from "./recovery-machine.ts";
import { isRecoveryPendingAttention, reasonFromRecoveryPendingAttention } from "./recovery.ts";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.ts";
import type { GoalRuntimeSessionHandlerContext } from "./goal-runtime-event-handler-types.ts";
import type { GoalRecoveryMachineState } from "./recovery-machine.ts";
import type { ThreadGoal } from "./types.ts";

export function createSessionEventHandlers(deps: GoalRuntimeSessionHandlerContext) {
  const {
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    resetErrorRecovery,
    resumeGoalWithContinuation,
  } = deps;

  const pauseRestoredOverflow = (ctx: ExtensionContext): boolean => {
    if (stateController.getGoal()?.status !== "active" ||
        runtimeState.recoveryState.phase.kind !== "hostOverflowNeedsUserStart") return false;
    stateController.pauseForRecovery(ctx,
      "Restored overflow recovery is paused. Reduce context or switch models, then send a genuine user message before /goal resume.");
    return true;
  };

  const schedulePostCompactContinuationFallback = (
    ctx: ExtensionContext,
    options: { clearHostOverflowRecovery: boolean },
  ): void => {
    const fallbackOptions = {
      turnIndex: runtimeState.currentTurnIndex,
      agentRunSequence: runtimeState.agentRunSequence,
    };
    continuation.maybeContinueAfterPostCompactFallback(
      ctx,
      options.clearHostOverflowRecovery
        ? {
            ...fallbackOptions,
            prepareContinuation: () => {
              if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
                return false;
              }
              clearActiveHostOverflowRecovery(runtimeState.recoveryState);
              if (recoveryPhaseNeedsUserStartTurn(runtimeState.recoveryState.phase)) {
                stateController.pauseForRecovery(ctx,
                  "Native overflow retry did not start. Goal cannot reset its allowance; send a genuine user message after reducing context or switching models, then /goal resume.");
                return false;
              }
              status.refreshUi(ctx);
              return true;
            },
          }
        : fallbackOptions,
    );
  };

  return {
    onSessionStart: (async (event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      deps.clearActiveAccounting();
      stateController.reloadFromSession(ctx);
      continuation.restoreCompactionRefresh(ctx.sessionManager.getBranch());
      goalAccounting.beginAccounting();
      if (pauseRestoredOverflow(ctx)) return;
      const goal = stateController.getGoal();
      const pausedGoal = goal?.status === "paused" ? goal : null;
      if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
        const shouldResume = await ctx.ui.confirm(
          "Resume paused goal?",
          `Goal: ${pausedGoal.objective}`,
        );
        if (shouldResume) {
          resumeGoalWithContinuation(pausedGoal.goalId, "runtime", ctx);
          goalAccounting.beginAccounting();
          return;
        }
      }
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionStartEvent>,

    onSessionTree: (async (_event, ctx) => {
      continuation.clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      deps.clearActiveAccounting();
      stateController.reloadFromSession(ctx);
      continuation.restoreCompactionRefresh(ctx.sessionManager.getBranch());
      goalAccounting.beginAccounting();
      if (pauseRestoredOverflow(ctx)) return;
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onSessionBeforeCompact: (async (event, ctx) => {
      filterGoalCompactionInput(event.preparation);
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact(),
          ctx,
          deps,
        )
      ) {
        return;
      }

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
    }) satisfies ExtensionHandler<SessionBeforeCompactEvent>,

    onSessionCompact: (async (event, ctx) => {
      continuation.requireFullGoal();
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)) {
        return;
      }

      stateController.flushGoalPersistence("runtime");
      const wasRecoveringFromHostOverflow = recoveryPhaseBlocksContinuation(
        runtimeState.recoveryState.phase,
      );
      recoveryRuntime.onSessionCompact();
      status.refreshUi(ctx);
      if (event.willRetry) {
        schedulePostCompactContinuationFallback(ctx, {
          clearHostOverflowRecovery: wasRecoveringFromHostOverflow,
        });
        return;
      }
      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
        continuation.maybeContinueAfterCurrentEvent(ctx);
      } else if (wasRecoveringFromHostOverflow) {
        schedulePostCompactContinuationFallback(ctx, { clearHostOverflowRecovery: true });
      }
    }) satisfies ExtensionHandler<SessionCompactEvent>,

    onSessionCompactFailed: (async (event, ctx) => {
      if (event.reason !== "overflow") return;
      continuation.clearPostCompactContinuationFallback();
      continuation.clearContinuationTimer();
      stateController.pauseForRecovery(ctx,
        "Native context overflow recovery stopped. Goal follow-ups cannot reset its allowance; reduce context or switch models, then send a genuine user message before /goal resume.");
    }) satisfies ExtensionHandler<SessionCompactFailedEvent>,

    onSessionShutdown: (async (_event, ctx) => {
      deps.deliveries.invalidate();
      continuation.clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      continuation.clearContinuationTimer();
      applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects, ctx, deps);

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
      if (hasPendingRecoveryAttention(deps)) {
        pauseForPendingRecoveryShutdown(ctx, deps);
      } else {
        resetErrorRecovery();
      }
      status.stopStatusRefresh();
    }) satisfies ExtensionHandler<SessionShutdownEvent>,
  };
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

function hasPendingRecoveryAttention({ runtimeState, stateController }: GoalRuntimeSessionHandlerContext): boolean {
  return pendingRecoveryShutdownReason({
    recoveryState: runtimeState.recoveryState,
    getGoal: stateController.getGoal,
  }) !== null;
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
  if (!reason) {
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
