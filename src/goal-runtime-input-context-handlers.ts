import type {
  BeforeAgentStartEvent, ContextEvent, ExtensionHandler, InputEvent, InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { goalDeliveryDetails } from "./goal-delivery.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";
import { cancelQueuedGoalWork } from "./queued-goal-work.ts";
import { applyStaleQueuedWorkEffects } from "./goal-runtime-event-utils.ts";
import type {
  GoalRuntimeInputContextHandlerContext, MessageEndEvent, MessageEndEventResult, MessageStartEvent,
} from "./goal-runtime-event-handler-types.ts";

export function createInputContextEventHandlers(deps: GoalRuntimeInputContextHandlerContext) {
  const { runtimeState, stateController, continuation, recoveryRuntime, status, resetErrorRecovery, deliveries } = deps;

  return {
    onInput: (async (event, ctx) => {
      // Input text has no ownership semantics, including literal old Goal envelopes.
      if (event.source !== "extension") {
        deps.providerLimitAutoResume.clear();
        recoveryRuntime.onUserInput();
        applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects, ctx, deps);
        status.refreshUi(ctx);
      }
      return undefined;
    }) satisfies ExtensionHandler<InputEvent, InputEventResult>,

    // Historical provider prefixes remain append-only, including cancellations.
    onContext: (async (_event, ctx) => {
      // Native abort can discard later queued user input. A finalized cancellation
      // is inert; let the native loop drain genuine pending work instead.
      if (ctx.hasPendingMessages()) runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
      const plan = runtimeState.staleQueuedWorkGuard.planContextAbort(runtimeState.currentTurnIndex);
      if (plan !== null) applyStaleQueuedWorkEffects(plan.effects, ctx, deps);
      return undefined;
    }) satisfies ExtensionHandler<ContextEvent, undefined>,

    onBeforeAgentStart: (async (_event, ctx) => {
      applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx, deps);
      return undefined;
    }) satisfies ExtensionHandler<BeforeAgentStartEvent, undefined>,

    onMessageStart: (async (event, ctx) => {
      const details = goalDeliveryDetails(event.message);
      if (details === null) {
        if (event.message.role === "user") stateController.persistHostOverflowUserReset(false);
        if (event.message.role === "user" || event.message.role === "custom") {
          runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
          const external = event.message.role === "user" ||
            (event.message.role === "custom" && event.message.customType !== CUSTOM_ENTRY_TYPE);
          if (external) {
            continuation.clearContinuationState();
            if (stateController.resumeWaitingGoal(ctx)) deps.goalAccounting.beginAccounting();
          }
        }
        return;
      }
      if (!deliveries.start(details)) {
        runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(details.deliveryId);
      }
    }) satisfies ExtensionHandler<MessageStartEvent>,

    onMessageEnd: (async (event): Promise<MessageEndEventResult | undefined> => {
      const { message } = event;
      if (message.role !== "custom") return undefined;
      const details = goalDeliveryDetails(message);
      if (details === null || details.kind === "stale_continuation") return undefined;
      const original = deliveries.finish(details);
      if (original === null) {
        runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(details.deliveryId);
        const cancellation = cancelQueuedGoalWork(details);
        return { message: { ...message, content: cancellation.text, display: false, details: cancellation.details } };
      }

      continuation.clearContinuationStateFor(details.goalId);
      runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
      if (details.kind === "continuation") runtimeState.agentRunFromContinuation = true;
      if (details.kind === "command_resume") resetErrorRecovery();
      let content = message.content;
      let objectiveRefresh = false;
      // Metadata establishes ownership. Match only our own produced prompt inside
      // that delivery, preserving captions, images and native normalization notes.
      if (details.kind === "continuation") {
        const index = typeof content === "string" ? (content.includes(original) ? 0 : -1) :
          content.findIndex((part) => part.type === "text" && part.text.includes(original));
        const fullPrompt = index < 0 ? null : continuation.fullPromptForDelivery(details.goalId);
        if (fullPrompt !== null) {
          objectiveRefresh = true;
          content = typeof content === "string" ? content.replace(original, fullPrompt) :
            content.map((part, i) => i === index && part.type === "text" ?
              { ...part, text: part.text.replace(original, fullPrompt) } : part);
        }
      }
      return { message: { ...message, content, details: { ...details, lifecycle: "delivered", ...(objectiveRefresh ? { objectiveRefresh: true } : {}) } } };
    }) satisfies ExtensionHandler<MessageEndEvent, MessageEndEventResult | undefined>,
  };
}
