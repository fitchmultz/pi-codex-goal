import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { continuationPrompt } from "./prompts.ts";
import { goalDeliveryDetails, type GoalDeliveries } from "./goal-delivery.ts";
import { reconstructGoal } from "./state.ts";
import {
  recoveryPhaseBlocksContinuation,
  type GoalRecoveryMachineState,
} from "./recovery-machine.ts";
import { isRecoveryPendingAttention } from "./recovery.ts";
import { CONTINUATION_RETRY_MS } from "./runtime-config.ts";
import type { StaleQueuedWorkGuard } from "./stale-queued-work-guard.ts";
import type { ThreadGoal } from "./types.ts";

interface ContinuationSchedulerDeps {
  deliveries: Pick<GoalDeliveries, "send">;
  getGoal: () => ThreadGoal | null;
  getRecoveryState: () => GoalRecoveryMachineState;
  staleQueuedWorkGuard: StaleQueuedWorkGuard;
  getCurrentTurnIndex: () => number | null;
  getAgentRunSequence: () => number;
}

interface PostCompactContinuationOptions {
  turnIndex: number | null;
  agentRunSequence: number;
  prepareContinuation?: () => boolean;
}

function hasDeliveredObjectiveRefresh(entry: SessionEntry, goalId: string): boolean {
  if (entry.type !== "custom_message") {
    return false;
  }
  const details = goalDeliveryDetails({
    role: "custom",
    customType: entry.customType,
    details: entry.details,
  });
  return (
    details?.kind === "continuation" &&
    details.lifecycle === "delivered" &&
    details.goalId === goalId &&
    details.objectiveRefresh === true
  );
}

export function createContinuationScheduler(
  deps: ContinuationSchedulerDeps,
): ContinuationScheduler {
  return new ContinuationScheduler(deps);
}

class ContinuationScheduler {
  private readonly deps: ContinuationSchedulerDeps;

  constructor(deps: ContinuationSchedulerDeps) {
    this.deps = deps;
  }

  private continuationQueuedFor: string | null = null;
  private fullGoalNeededFor: string | null = null;
  private continuationScheduledFor: string | null = null;
  private continuationScheduledDelayMs: number | null = null;
  private continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private postCompactContinuationTimer: ReturnType<typeof setTimeout> | null = null;

  clearContinuationTimer = (): void => {
    if (this.continuationTimer) {
      clearTimeout(this.continuationTimer);
      this.continuationTimer = null;
    }
    this.continuationScheduledFor = null;
    this.continuationScheduledDelayMs = null;
  };

  clearPostCompactContinuationFallback = (): void => {
    if (!this.postCompactContinuationTimer) {
      return;
    }
    clearTimeout(this.postCompactContinuationTimer);
    this.postCompactContinuationTimer = null;
  };

  clearContinuationState = (): void => {
    this.clearContinuationTimer();
    this.continuationQueuedFor = null;
  };

  clearContinuationStateFor = (goalId: string): void => {
    if (this.continuationQueuedFor === goalId) {
      this.continuationQueuedFor = null;
    }
    if (this.continuationScheduledFor === goalId) {
      this.clearContinuationTimer();
    }
  };

  markContinuationQueued = (goalId: string): void => {
    this.continuationQueuedFor = goalId;
  };

  requireFullGoal = (): void => {
    this.fullGoalNeededFor = this.deps.getGoal()?.goalId ?? null;
  };

  restoreCompactionRefresh = (branch: readonly SessionEntry[]): void => {
    const compactIndex = branch.findLastIndex((entry) => entry.type === "compaction");
    this.fullGoalNeededFor =
      compactIndex < 0
        ? null
        : (reconstructGoal(branch.slice(0, compactIndex)).goal?.goalId ?? null);
    if (this.fullGoalNeededFor === null) {
      return;
    }
    const goalId = this.fullGoalNeededFor;
    if (
      branch.slice(compactIndex + 1).some((entry) => hasDeliveredObjectiveRefresh(entry, goalId))
    ) {
      this.fullGoalNeededFor = null;
    }
  };

  // Consume at delivery, not enqueue: compaction may occur with a continuation
  // already queued, and a native retry must not discard the pending refresh.
  fullPromptForDelivery = (goalId: string): string | null => {
    const goal = this.deps.getGoal();
    if (
      this.fullGoalNeededFor !== goalId ||
      !goal ||
      goal.goalId !== goalId ||
      goal.status !== "active"
    ) {
      return null;
    }
    this.fullGoalNeededFor = null;
    return continuationPrompt(goal);
  };

  hasPendingRecoveryAttention = (): boolean => {
    const goal = this.deps.getGoal();
    return (
      goal?.status === "active" &&
      isRecoveryPendingAttention(this.deps.getRecoveryState().attention)
    );
  };

  sendContinuation = (goalToContinue: ThreadGoal): void => {
    this.continuationQueuedFor = goalToContinue.goalId;
    this.deps.deliveries.send(goalToContinue, "continuation");
  };

  canPlanContinuationFor = (goal: ThreadGoal | null): goal is ThreadGoal => {
    return Boolean(
      !this.deps.staleQueuedWorkGuard.isBlockingContinuation() &&
      goal &&
      goal.status === "active" &&
      this.continuationQueuedFor !== goal.goalId &&
      !this.hasPendingRecoveryAttention() &&
      !recoveryPhaseBlocksContinuation(this.deps.getRecoveryState().phase),
    );
  };

  scheduleContinuationCheck = (goalId: string, ctx: ExtensionContext, delayMs: number): void => {
    if (this.continuationTimer && this.continuationScheduledFor === goalId) {
      if (
        this.continuationScheduledDelayMs !== null &&
        delayMs >= this.continuationScheduledDelayMs
      ) {
        return;
      }
      this.clearContinuationTimer();
    } else if (this.continuationTimer) {
      this.clearContinuationTimer();
    }

    this.continuationScheduledFor = goalId;
    this.continuationScheduledDelayMs = delayMs;
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = null;
      this.continuationScheduledFor = null;
      this.continuationScheduledDelayMs = null;
      this.maybeContinue(ctx);
    }, delayMs);
    this.continuationTimer.unref();
  };

  maybeContinue = (ctx: ExtensionContext, duringAgentEnd = false): void => {
    const goal = this.deps.getGoal();
    if (!this.canPlanContinuationFor(goal)) {
      return;
    }

    const goalId = goal.goalId;
    if ((!duringAgentEnd && !ctx.isIdle()) || ctx.hasPendingMessages()) {
      this.scheduleContinuationCheck(goalId, ctx, CONTINUATION_RETRY_MS);
      return;
    }

    this.clearContinuationTimer();
    const currentGoal = this.deps.getGoal();
    if (!currentGoal || currentGoal.status !== "active" || currentGoal.goalId !== goalId) {
      return;
    }
    this.sendContinuation(currentGoal);
  };

  maybeContinueAfterCurrentEvent = (ctx: ExtensionContext): void => {
    const goal = this.deps.getGoal();
    if (!this.canPlanContinuationFor(goal)) {
      return;
    }
    this.scheduleContinuationCheck(goal.goalId, ctx, 0);
  };

  canSchedulePostCompactFallbackFor = (
    goal: ThreadGoal | null,
    prepareContinuation?: () => boolean,
  ): goal is ThreadGoal => {
    return Boolean(
      !this.deps.staleQueuedWorkGuard.isBlockingContinuation() &&
      goal &&
      goal.status === "active" &&
      this.continuationQueuedFor !== goal.goalId &&
      !this.hasPendingRecoveryAttention() &&
      (prepareContinuation || !recoveryPhaseBlocksContinuation(this.deps.getRecoveryState().phase)),
    );
  };

  maybeContinueAfterPostCompactFallback = (
    ctx: ExtensionContext,
    options: PostCompactContinuationOptions,
  ): void => {
    this.clearPostCompactContinuationFallback();
    const goal = this.deps.getGoal();
    if (!this.canSchedulePostCompactFallbackFor(goal, options.prepareContinuation)) {
      return;
    }

    const goalId = goal.goalId;
    const runFallback = (): void => {
      this.postCompactContinuationTimer = null;
      const currentGoal = this.deps.getGoal();
      if (!currentGoal || currentGoal.status !== "active" || currentGoal.goalId !== goalId) {
        return;
      }
      if (this.deps.getCurrentTurnIndex() !== options.turnIndex) {
        return;
      }
      if (this.deps.getAgentRunSequence() !== options.agentRunSequence) {
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        this.postCompactContinuationTimer = setTimeout(runFallback, CONTINUATION_RETRY_MS);
        this.postCompactContinuationTimer.unref();
        return;
      }
      if (options.prepareContinuation && !options.prepareContinuation()) {
        return;
      }
      this.maybeContinue(ctx);
    };

    this.postCompactContinuationTimer = setTimeout(runFallback, CONTINUATION_RETRY_MS);
    this.postCompactContinuationTimer.unref();
  };
}
