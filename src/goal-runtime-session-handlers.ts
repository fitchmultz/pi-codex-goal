import type {
  ExtensionContext,
  ExtensionHandler,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";

import {
  clearActiveHostOverflowRecovery,
  recoveryPhaseBlocksContinuation,
} from "./recovery-machine.js";
import { isRecoveryPendingAttention, reasonFromRecoveryPendingAttention } from "./recovery.js";
import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";
import type { GoalRuntimeSessionHandlerContext } from "./goal-runtime-event-handler-types.js";
import type { GoalRecoveryMachineState } from "./recovery-machine.js";
import { CONTINUATION_RETRY_MS } from "./runtime-config.js";
import type { ThreadGoal } from "./types.js";

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

  let postCompactContinuationFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPostCompactContinuationFallback = (): void => {
    if (!postCompactContinuationFallbackTimer) {
      return;
    }
    clearTimeout(postCompactContinuationFallbackTimer);
    postCompactContinuationFallbackTimer = null;
  };

  const schedulePostCompactContinuationFallback = (
    ctx: ExtensionContext,
    options: { clearHostOverflowRecovery: boolean },
  ): void => {
    clearPostCompactContinuationFallback();
    const scheduledGoal = stateController.getGoal();
    if (!scheduledGoal || scheduledGoal.status !== "active") {
      return;
    }
    if (
      options.clearHostOverflowRecovery &&
      !recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)
    ) {
      return;
    }

    const scheduledGoalId = scheduledGoal.goalId;
    const scheduledTurnIndex = runtimeState.currentTurnIndex;
    const scheduledAgentRunSequence = runtimeState.agentRunSequence;
    postCompactContinuationFallbackTimer = setTimeout(() => {
      postCompactContinuationFallbackTimer = null;
      const goal = stateController.getGoal();
      if (!goal || goal.status !== "active" || goal.goalId !== scheduledGoalId) {
        return;
      }
      if (runtimeState.currentTurnIndex !== scheduledTurnIndex) {
        return;
      }
      if (runtimeState.agentRunSequence !== scheduledAgentRunSequence) {
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }

      const recoveryBlocksContinuation = recoveryPhaseBlocksContinuation(
        runtimeState.recoveryState.phase,
      );
      if (options.clearHostOverflowRecovery) {
        if (!recoveryBlocksContinuation) {
          return;
        }
        clearActiveHostOverflowRecovery(runtimeState.recoveryState);
        status.refreshUi(ctx);
      } else if (recoveryBlocksContinuation) {
        return;
      }
      continuation.maybeContinue(ctx);
    }, CONTINUATION_RETRY_MS);
    postCompactContinuationFallbackTimer.unref?.();
  };

  return {
    onSessionStart: (async (event, ctx) => {
      clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
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
      clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<SessionTreeEvent>,

    onSessionBeforeCompact: (async (_event, ctx) => {
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
        // A host retry is expected, but keep a guarded fallback in case no retry turn arrives.
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

    onSessionShutdown: (async (_event, ctx) => {
      clearPostCompactContinuationFallback();
      deps.providerLimitAutoResume.clear();
      continuation.clearPassthroughContinuationInput();
      applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects, ctx, deps);

      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
      continuation.clearContinuationTimer();
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
