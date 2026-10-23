import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  GoalRuntimeContinuationPort,
  GoalRuntimeOverflowRecoveryContext,
  QueuedGoalWorkMessage,
  QueuedGoalWorkMessageIdResolver,
  StaleQueuedWorkEffectContext,
} from "./goal-runtime-event-handler-types.ts";
import { extensionQueuedGoalWorkMessageIdForRuntime } from "./queued-goal-work.ts";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  type AssistantErrorMessage,
} from "./recovery.ts";
import type { StaleQueuedWorkEffect, StaleQueuedWorkPlan } from "./stale-queued-work-guard.ts";

export function applyStaleQueuedWorkEffects(
  effects: readonly StaleQueuedWorkEffect[],
  ctx: ExtensionContext,
  context: StaleQueuedWorkEffectContext,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearAccounting":
        context.clearActiveAccounting();
        break;
      case "refreshUi":
        context.status.refreshUi(ctx);
        break;
      case "abort":
        ctx.abort();
        break;
      default: {
        const _exhaustive: never = effect;
        throw new Error(`Unhandled stale queued-work effect: ${String(_exhaustive)}`);
      }
    }
  }
}

export function runStaleQueuedWorkPlan(
  plan: StaleQueuedWorkPlan,
  ctx: ExtensionContext,
  context: StaleQueuedWorkEffectContext,
): boolean {
  applyStaleQueuedWorkEffects(plan.effects, ctx, context);
  return plan.skip;
}

export function createQueuedGoalWorkMessageIdResolver(
  continuation: GoalRuntimeContinuationPort,
): QueuedGoalWorkMessageIdResolver {
  return (message: QueuedGoalWorkMessage): string | null =>
    extensionQueuedGoalWorkMessageIdForRuntime(
      message,
      continuation.continuationGoalIdFromRuntimePrompt,
    );
}

export function getContextWindow(ctx: ExtensionContext): number {
  return ctx.model?.contextWindow ?? 0;
}

/** Hidden continuations that only call get_goal / *.__get_goal are blocked, not progressed. */
export const STATUS_INSPECTION_ONLY_CONTINUATION_REASON =
  "continuation only re-inspected goal status with no actionable progress";

export function isGoalStatusInspectionToolName(name: string): boolean {
  return name === "get_goal" || name.endsWith("__get_goal");
}

export function isStatusInspectionOnlyToolRun(toolNames: readonly string[]): boolean {
  return toolNames.length > 0 && toolNames.every(isGoalStatusInspectionToolName);
}

export function shouldPauseStatusInspectionOnlyContinuation(
  fromContinuation: boolean,
  toolNames: readonly string[],
): boolean {
  return fromContinuation && isStatusInspectionOnlyToolRun(toolNames);
}

export function recordAssistantContextOverflow(
  message: AssistantErrorMessage,
  ctx: ExtensionContext,
  context: GoalRuntimeOverflowRecoveryContext,
): boolean {
  if (!isAssistantContextOverflow(message, getContextWindow(ctx))) {
    return false;
  }

  context.stateController.beginOverflowRecovery(ctx);
  if (isErrorAssistantMessage(message)) {
    context.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  } else {
    context.recoveryRuntime.handleSilentContextOverflow(ctx);
  }
  return true;
}

export function handleAgentErrorMessage(
  message: AssistantErrorMessage,
  ctx: ExtensionContext,
  context: GoalRuntimeOverflowRecoveryContext,
): void {
  recordAssistantContextOverflow(message, ctx, context);
  if (!isContextOverflowError(message.errorMessage, message.provider)) {
    context.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  }
}
