import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { continuationGoalIdFromPrompt, continuationPromptEnd } from "./prompts.ts";
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
      continuation.clearPassthroughContinuationInput();
      const continuationGoalId = continuationGoalIdFromPrompt(event.text);

      if (event.source !== "extension") {
        deps.providerLimitAutoResume.clear();
        recoveryRuntime.onUserInput();
        applyStaleQueuedWorkEffects(
          runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects,
          ctx,
          deps,
        );
        if (continuationGoalId !== null) {
          continuation.notePassthroughContinuationInput(event.text);
        }
        status.refreshUi(ctx);
        return undefined;
      }

      if (continuationGoalId === null) {
        return undefined;
      }

      applyStaleQueuedWorkEffects(
        runtimeState.staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects,
        ctx,
        deps,
      );
      if (stateController.isCurrentActiveGoalId(continuationGoalId)) {
        continuation.markContinuationQueued(continuationGoalId);
        return { action: "continue" } as const;
      }

      continuation.clearContinuationStateFor(continuationGoalId);
      status.refreshUi(ctx);
      return { action: "handled" } as const;
    }) satisfies ExtensionHandler<InputEvent, InputEventResult>,

    // Provider context is left exactly as the transcript has it. Prompt caches match the request
    // prefix, so any message rewritten here from current goal state after the provider has seen it
    // re-caches everything from that message on. Fresh metadata-owned custom controls
    // can be cancelled at delivery instead; old sent controls stay verbatim.
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
      const continuationGoalId = continuation.continuationGoalIdFromRuntimePrompt(event.prompt);
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
      const { message } = event;
      // Delivery-time changes require Goal metadata. User messages keep the
      // existing marker guard and native input lifecycle, with no new delivery tracking.
      if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE ||
          !isActiveGoalQueuedDetails(message.details)) return undefined;
      const queuedGoalId = message.details.goalId;
      if (!stateController.isCurrentActiveGoalId(queuedGoalId)) {
        const cancellation = cancelQueuedGoalWork(message, queuedGoalId, stateController.getGoal());
        if (cancellation === null) return undefined;
        return { message: { ...message, content: cancellation.text, display: false, details: cancellation.details } };
      }

      // Only the first normal automatic continuation after compaction gets the
      // full saved goal. Command start/resume and historical context do not.
      if (message.details.kind !== "continuation") return undefined;
      const original = typeof message.content === "string"
        ? message.content : message.content.find((part) => part.type === "text")?.text;
      const end = original === undefined ? null : continuationPromptEnd(original);
      const prompt = end === null ? null : continuation.fullPromptForDelivery(queuedGoalId);
      if (prompt === null || original === undefined || end === null) return undefined;
      const text = prompt + original.slice(end);
      if (typeof message.content === "string") return { message: { ...message, content: text } };
      const firstText = message.content.findIndex((part) => part.type === "text");
      const content = message.content.map((part, index) => index === firstText ? { ...part, text } : part);
      return { message: { ...message, content } };
    }) satisfies ExtensionHandler<MessageEndEvent, MessageEndEventResult | undefined>,
  };
}
