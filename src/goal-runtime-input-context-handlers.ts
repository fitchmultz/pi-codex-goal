import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { continuationPromptEnd } from "./prompts.ts";
import { finalizeGoalUserDelivery, goalIdFromDeliveryPrompt, noteGoalUserDeliveryStarted, prepareGoalUserInput } from "./goal-user-delivery.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";
import { cancelQueuedGoalWork } from "./queued-goal-work.ts";
import {
  isActiveGoalQueuedDetails,
  isCommandResumeQueuedGoalMessage,
} from "./queued-goal-messages.ts";
import { applyStaleQueuedWorkEffects } from "./goal-runtime-event-utils.ts";
import type {
  GoalRuntimeInputContextHandlerContext,
  MessageEndEvent,
  MessageEndEventResult,
  MessageStartEvent,
  QueuedGoalWorkMessageIdResolver,
} from "./goal-runtime-event-handler-types.ts";

export function createInputContextEventHandlers(
  deps: GoalRuntimeInputContextHandlerContext,
  queuedGoalWorkMessageIdForRuntime: QueuedGoalWorkMessageIdResolver,
) {
  const { runtimeState, stateController, continuation, recoveryRuntime, status, resetErrorRecovery } = deps;

  return {
    onInput: (async (event, ctx) => {
      const prepared = prepareGoalUserInput(event);
      const continuationGoalId = prepared.goalId;
      const transformed = prepared.text === event.text ? undefined
        : { action: "transform" as const, text: prepared.text };

      if (event.source !== "extension") {
        deps.providerLimitAutoResume.clear();
        recoveryRuntime.onUserInput();
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects,
          ctx,
          deps,
        );
        status.refreshUi(ctx);
        return transformed;
      }

      if (continuationGoalId === null) {
        return transformed;
      }

      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects,
        ctx,
        deps,
      );
      if (stateController.isCurrentActiveGoalId(continuationGoalId)) {
        continuation.markContinuationQueued(continuationGoalId);
        return transformed;
      }

      continuation.clearContinuationStateFor(continuationGoalId);
      status.refreshUi(ctx);
      return { action: "handled" } as const;
    }) satisfies ExtensionHandler<InputEvent, InputEventResult>,

    // Provider context is left exactly as the transcript has it. Prompt caches match the request
    // prefix, so any message rewritten here from current goal state after the provider has seen it
    // re-caches everything from that message on. Stale queued work is cancelled at delivery instead.
    onContext: (async (_event, ctx) => {
      const contextAbortPlan = runtimeState.staleQueuedWorkGuard.planContextAbort(
        runtimeState.currentTurnIndex,
      );
      if (contextAbortPlan !== null) {
        applyStaleQueuedWorkEffects(contextAbortPlan.effects, ctx, deps);
      }

      return undefined;
    }) satisfies ExtensionHandler<ContextEvent, undefined>,

    onBeforeAgentStart: (async (event, ctx) => {
      if (!("prompt" in event)) return undefined;
      const continuationGoalId = goalIdFromDeliveryPrompt(event.prompt);
      if (continuationGoalId !== null) {
        continuation.clearContinuationStateFor(continuationGoalId);
        if (!stateController.isCurrentActiveGoalId(continuationGoalId)) {
          status.refreshUi(ctx);
          return undefined;
        }
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
          ctx,
          deps,
        );
      } else {
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
          ctx,
          deps,
        );
        continuation.clearContinuationState();
      }
      return undefined;
    }) satisfies ExtensionHandler<BeforeAgentStartEvent, undefined>,

    onMessageStart: (async (event, ctx) => {
      if (event.message.role === "user") {
        noteGoalUserDeliveryStarted(event.message);
        stateController.persistHostOverflowUserReset(false);
      }

      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
      if (queuedGoalId === null) {
        if (event.message.role === "user" || event.message.role === "custom") {
          runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
          continuation.clearContinuationState();
          // Goal bookkeeping must never wake a wait. Native turn_start precedes
          // message_start, so re-arm this response's accounting after waking.
          const isExternalInput = event.message.role === "user" ||
            (event.message.role === "custom" && event.message.customType !== CUSTOM_ENTRY_TYPE);
          if (isExternalInput && stateController.resumeWaitingGoal(ctx)) {
            deps.goalAccounting.beginAccounting();
          }
        }
        return;
      }

      continuation.clearContinuationStateFor(queuedGoalId);
      if (stateController.isCurrentActiveGoalId(queuedGoalId)) {
        runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
        const details =
          "details" in event.message ? (event.message as { details?: unknown }).details : undefined;
        if (isActiveGoalQueuedDetails(details) && details.kind === "continuation") {
          runtimeState.agentRunFromContinuation = true;
        }
        if (isCommandResumeQueuedGoalMessage(event.message)) {
          resetErrorRecovery();
        }
        return;
      }

      runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(queuedGoalId);
    }) satisfies ExtensionHandler<MessageStartEvent>,

    onMessageEnd: (async (event, _ctx): Promise<MessageEndEventResult | undefined> => {
      const rewrite = (message: MessageEndEvent["message"], queuedGoalId: string): MessageEndEventResult | undefined => {
        if (stateController.isCurrentActiveGoalId(queuedGoalId)) {
          // Only a newly delivered, runnable Goal message can be refreshed. Never
          // rewrite answered history, user-pasted markers, or cancelled notices.
          if ((message.role === "user" || message.role === "custom") &&
              (message.role !== "custom" || isActiveGoalQueuedDetails(message.details))) {
            const original = typeof message.content === "string"
              ? message.content : message.content.find((part) => part.type === "text")?.text;
            const end = original === undefined ? null : continuationPromptEnd(original);
            const prompt = end === null ? null : continuation.fullPromptForDelivery(queuedGoalId);
            if (prompt !== null && original !== undefined && end !== null) {
              // Pi can merge captions and append resize notes into this text block.
              // Replace only the control envelope, not the accompanying input.
              const text = prompt + original.slice(end);
              if (typeof message.content === "string") {
                if (message.role === "custom") return { message: { ...message, content: text } };
                return { message: { ...message, content: [{ type: "text", text }] } };
              }
              const firstText = message.content.findIndex((part) => part.type === "text");
              const content = message.content.map((part, index) => index === firstText ? { type: "text" as const, text } : part);
              if (message.role === "custom") return { message: { ...message, content } };
              return { message: { ...message, content } };
            }
          }
          return undefined;
        }

        const cancellation = cancelQueuedGoalWork(message, queuedGoalId, stateController.getGoal());
        if (cancellation === null) {
          return undefined;
        }
        if (message.role === "custom") {
          return { message: { ...message, content: cancellation.text, display: false, details: cancellation.details } };
        }
        if (message.role === "user") {
          return { message: { ...message, content: [{ type: "text", text: cancellation.text }] } };
        }
        return undefined;
      };
      if (event.message.role === "user") return finalizeGoalUserDelivery(event.message, rewrite);
      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
      return queuedGoalId === null ? undefined : rewrite(event.message, queuedGoalId);
    }) satisfies ExtensionHandler<MessageEndEvent, MessageEndEventResult | undefined>,
  };
}
