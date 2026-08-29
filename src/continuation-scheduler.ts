import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { compactContinuationPrompt, continuationGoalIdFromPrompt } from "./prompts.js";
import {
  recoveryPhaseBlocksContinuation,
  type GoalRecoveryMachineState,
} from "./recovery-machine.js";
import { isRecoveryPendingAttention } from "./recovery.js";
import { CONTINUATION_RETRY_MS } from "./runtime-config.js";
import type { StaleQueuedWorkGuard } from "./stale-queued-work-guard.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";

interface ContinuationSchedulerDeps {
  pi: Pick<ExtensionAPI, "sendMessage">;
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

export function createContinuationScheduler(deps: ContinuationSchedulerDeps) {
  let continuationQueuedFor: string | null = null;
  let continuationScheduledFor: string | null = null;
  let continuationScheduledDelayMs: number | null = null;
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;
  let postCompactContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  let postCompactContinuationFallback: (() => void) | null = null;
  let passthroughContinuationInput: { text: string; turnIndex: number | null } | null = null;

  const clearContinuationTimer = (): void => {
    if (continuationTimer) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }
    continuationScheduledFor = null;
    continuationScheduledDelayMs = null;
  };

  const clearPostCompactContinuationFallback = (): void => {
    if (postCompactContinuationTimer) {
      clearTimeout(postCompactContinuationTimer);
      postCompactContinuationTimer = null;
    }
    postCompactContinuationFallback = null;
  };

  const clearContinuationState = (): void => {
    clearContinuationTimer();
    continuationQueuedFor = null;
  };

  const clearContinuationStateFor = (goalId: string): void => {
    if (continuationQueuedFor === goalId) {
      continuationQueuedFor = null;
    }
    if (continuationScheduledFor === goalId) {
      clearContinuationTimer();
    }
  };

  const markContinuationQueued = (goalId: string): void => {
    continuationQueuedFor = goalId;
  };

  const clearPassthroughContinuationInput = (): void => {
    passthroughContinuationInput = null;
  };

  const bindPassthroughContinuationInputToTurn = (turnIndex: number): void => {
    if (!passthroughContinuationInput) {
      return;
    }
    if (passthroughContinuationInput.turnIndex === null) {
      passthroughContinuationInput = { ...passthroughContinuationInput, turnIndex };
      return;
    }
    if (passthroughContinuationInput.turnIndex !== turnIndex) {
      clearPassthroughContinuationInput();
    }
  };

  const isPassthroughContinuationInput = (text: string): boolean => {
    if (!passthroughContinuationInput || passthroughContinuationInput.text !== text) {
      return false;
    }
    const currentTurnIndex = deps.getCurrentTurnIndex();
    return (
      passthroughContinuationInput.turnIndex === null ||
      passthroughContinuationInput.turnIndex === currentTurnIndex
    );
  };

  const continuationGoalIdFromRuntimePrompt = (prompt: string): string | null => {
    if (isPassthroughContinuationInput(prompt)) {
      return null;
    }
    return continuationGoalIdFromPrompt(prompt);
  };

  const notePassthroughContinuationInput = (text: string): void => {
    passthroughContinuationInput = { text, turnIndex: null };
  };

  const hasPendingRecoveryAttention = (): boolean => {
    const goal = deps.getGoal();
    return Boolean(goal?.status === "active" && isRecoveryPendingAttention(deps.getRecoveryState().attention));
  };

  const sendContinuation = (goalToContinue: ThreadGoal): void => {
    continuationQueuedFor = goalToContinue.goalId;
    deps.pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: compactContinuationPrompt(goalToContinue),
        display: false,
        details: { kind: "continuation", goalId: goalToContinue.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const canPlanContinuationFor = (goal: ThreadGoal | null): goal is ThreadGoal => {
    return Boolean(
      !deps.staleQueuedWorkGuard.isBlockingContinuation() &&
        goal &&
        goal.status === "active" &&
        continuationQueuedFor !== goal.goalId &&
        !hasPendingRecoveryAttention() &&
        !recoveryPhaseBlocksContinuation(deps.getRecoveryState().phase),
    );
  };

  const scheduleContinuationCheck = (
    goalId: string,
    ctx: ExtensionContext,
    delayMs: number,
  ): void => {
    if (continuationTimer && continuationScheduledFor === goalId) {
      if (continuationScheduledDelayMs !== null && delayMs >= continuationScheduledDelayMs) {
        return;
      }
      clearContinuationTimer();
    } else if (continuationTimer) {
      clearContinuationTimer();
    }

    continuationScheduledFor = goalId;
    continuationScheduledDelayMs = delayMs;
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      continuationScheduledFor = null;
      continuationScheduledDelayMs = null;
      maybeContinue(ctx);
    }, delayMs);
    continuationTimer.unref?.();
  };

  const maybeContinue = (ctx: ExtensionContext): void => {
    const goal = deps.getGoal();
    if (!canPlanContinuationFor(goal)) {
      return;
    }

    const goalId = goal.goalId;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      scheduleContinuationCheck(goalId, ctx, CONTINUATION_RETRY_MS);
      return;
    }

    clearContinuationTimer();
    const currentGoal = deps.getGoal();
    if (!currentGoal || currentGoal.status !== "active" || currentGoal.goalId !== goalId) {
      return;
    }
    sendContinuation(currentGoal);
  };

  const maybeContinueAfterCurrentEvent = (ctx: ExtensionContext): void => {
    const goal = deps.getGoal();
    if (!canPlanContinuationFor(goal)) {
      return;
    }
    scheduleContinuationCheck(goal.goalId, ctx, 0);
  };

  const canSchedulePostCompactFallbackFor = (goal: ThreadGoal | null, prepareContinuation?: () => boolean): goal is ThreadGoal => {
    return Boolean(
      !deps.staleQueuedWorkGuard.isBlockingContinuation() &&
        goal &&
        goal.status === "active" &&
        continuationQueuedFor !== goal.goalId &&
        !hasPendingRecoveryAttention() &&
        (prepareContinuation || !recoveryPhaseBlocksContinuation(deps.getRecoveryState().phase)),
    );
  };

  const maybeContinueAfterPostCompactFallback = (
    ctx: ExtensionContext,
    options: PostCompactContinuationOptions,
  ): void => {
    clearPostCompactContinuationFallback();
    const goal = deps.getGoal();
    if (!canSchedulePostCompactFallbackFor(goal, options.prepareContinuation)) {
      return;
    }

    const goalId = goal.goalId;
    const runFallback = (ignoreRunIdentity: boolean): void => {
      postCompactContinuationTimer = null;
      const currentGoal = deps.getGoal();
      if (
        !canSchedulePostCompactFallbackFor(currentGoal, options.prepareContinuation) ||
        currentGoal.goalId !== goalId
      ) {
        clearPostCompactContinuationFallback();
        return;
      }
      if (
        !ignoreRunIdentity &&
        (deps.getCurrentTurnIndex() !== options.turnIndex ||
          deps.getAgentRunSequence() !== options.agentRunSequence)
      ) {
        // A host retry now owns continuation. Keep the fallback dormant until
        // agent_settled proves that retry left no runnable work behind.
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        postCompactContinuationTimer = setTimeout(
          () => runFallback(false),
          CONTINUATION_RETRY_MS,
        );
        postCompactContinuationTimer.unref?.();
        return;
      }
      if (options.prepareContinuation && !options.prepareContinuation()) {
        clearPostCompactContinuationFallback();
        return;
      }
      clearPostCompactContinuationFallback();
      maybeContinue(ctx);
    };

    postCompactContinuationFallback = () => {
      if (postCompactContinuationTimer) {
        clearTimeout(postCompactContinuationTimer);
        postCompactContinuationTimer = null;
      }
      // agent_settled guarantees that no host retry remains runnable, so a
      // lifecycle identity change no longer justifies abandoning the fallback.
      runFallback(true);
    };
    postCompactContinuationTimer = setTimeout(
      () => runFallback(false),
      CONTINUATION_RETRY_MS,
    );
    postCompactContinuationTimer.unref?.();
  };

  const settlePostCompactContinuationFallback = (): void => {
    postCompactContinuationFallback?.();
  };

  return {
    bindPassthroughContinuationInputToTurn,
    clearContinuationState,
    clearContinuationStateFor,
    clearContinuationTimer,
    clearPostCompactContinuationFallback,
    clearPassthroughContinuationInput,
    continuationGoalIdFromRuntimePrompt,
    markContinuationQueued,
    maybeContinue,
    maybeContinueAfterCurrentEvent,
    maybeContinueAfterPostCompactFallback,
    notePassthroughContinuationInput,
    settlePostCompactContinuationFallback,
  };
}
