import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { goalDeliveryDetails } from "./goal-delivery.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";
import { cancelQueuedGoalWork } from "./queued-goal-work.ts";
import { applyStaleQueuedWorkEffects } from "./goal-runtime-event-utils.ts";
import type {
  GoalRuntimeInputContextHandlerContext,
  GoalRuntimeEventHandlers,
  MessageEndEvent,
  MessageEndEventResult,
  MessageStartEvent,
} from "./goal-runtime-event-handler-types.ts";

export function createInputContextEventHandlers(
  deps: GoalRuntimeInputContextHandlerContext,
): Pick<
  GoalRuntimeEventHandlers,
  "onInput" | "onContext" | "onBeforeAgentStart" | "onMessageStart" | "onMessageEnd"
> {
  const handlers = new InputContextEventHandlers(deps);
  return {
    onInput: handlers.onInput,
    onContext: handlers.onContext,
    onBeforeAgentStart: handlers.onBeforeAgentStart,
    onMessageStart: handlers.onMessageStart,
    onMessageEnd: handlers.onMessageEnd,
  };
}

class InputContextEventHandlers {
  private readonly deps: GoalRuntimeInputContextHandlerContext;

  constructor(deps: GoalRuntimeInputContextHandlerContext) {
    this.deps = deps;
  }

  onInput = (async (event, ctx) => {
    // Input text has no ownership semantics, including literal old Goal envelopes.
    if (event.source !== "extension") {
      this.deps.providerLimitAutoResume.clear();
      this.deps.recoveryRuntime.onUserInput();
      applyStaleQueuedWorkEffects(
        this.deps.runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects,
        ctx,
        this.deps,
      );
      this.deps.status.refreshUi(ctx);
    }
    return;
  }) satisfies ExtensionHandler<InputEvent, InputEventResult>;

  // Historical provider prefixes remain append-only, including cancellations.
  onContext = (async (_event, ctx) => {
    // Native abort can discard later queued user input. A finalized cancellation
    // is inert; let the native loop drain genuine pending work instead.
    if (ctx.hasPendingMessages()) {
      this.deps.runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
    }
    const plan = this.deps.runtimeState.staleQueuedWorkGuard.planContextAbort(
      this.deps.runtimeState.currentTurnIndex,
    );
    if (plan !== null) {
      applyStaleQueuedWorkEffects(plan.effects, ctx, this.deps);
    }
    return;
  }) satisfies ExtensionHandler<ContextEvent>;

  onBeforeAgentStart = (async (_event, ctx) => {
    applyStaleQueuedWorkEffects(
      this.deps.runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects,
      ctx,
      this.deps,
    );
    return;
  }) satisfies ExtensionHandler<BeforeAgentStartEvent>;

  onMessageStart = (async (event, ctx) => {
    const details = goalDeliveryDetails(event.message);
    if (details !== null) {
      if (!this.deps.deliveries.start(details)) {
        this.deps.runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(details.deliveryId);
      }
      return;
    }
    if (event.message.role === "user") {
      this.deps.stateController.persistHostOverflowUserReset(false);
    }
    if (event.message.role !== "user" && event.message.role !== "custom") {
      return;
    }
    this.deps.runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
    const external =
      event.message.role === "user" || event.message.customType !== CUSTOM_ENTRY_TYPE;
    if (!external) {
      return;
    }
    this.deps.continuation.clearContinuationState();
    if (this.deps.stateController.resumeWaitingGoal(ctx)) {
      this.deps.goalAccounting.beginAccounting();
    }
  }) satisfies ExtensionHandler<MessageStartEvent>;

  private refreshContinuationContent(
    content: Extract<MessageEndEvent["message"], { role: "custom" }>["content"],
    original: string,
    goalId: string,
  ): { content: typeof content; objectiveRefresh: boolean } {
    // Replace only our own prompt, preserving captions, images and native normalization notes.
    let index: number;
    if (typeof content === "string") {
      index = content.includes(original) ? 0 : -1;
    } else {
      index = content.findIndex((part) => part.type === "text" && part.text.includes(original));
    }
    const fullPrompt = index < 0 ? null : this.deps.continuation.fullPromptForDelivery(goalId);
    if (fullPrompt === null) {
      return { content, objectiveRefresh: false };
    }
    const refreshed =
      typeof content === "string"
        ? content.replace(original, () => fullPrompt)
        : content.map((part, i) =>
            i === index && part.type === "text"
              ? { ...part, text: part.text.replace(original, () => fullPrompt) }
              : part,
          );
    return { content: refreshed, objectiveRefresh: true };
  }

  onMessageEnd = (async (event): Promise<MessageEndEventResult | undefined> => {
    const { message } = event;
    if (message.role !== "custom") {
      return undefined;
    }
    const details = goalDeliveryDetails(message);
    if (details === null || details.kind === "stale_continuation") {
      return undefined;
    }
    const original = this.deps.deliveries.finish(details);
    if (original === null) {
      this.deps.runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(details.deliveryId);
      const cancellation = cancelQueuedGoalWork(details);
      return {
        message: {
          ...message,
          content: cancellation.text,
          display: false,
          details: cancellation.details,
        },
      };
    }

    this.deps.continuation.clearContinuationStateFor(details.goalId);
    this.deps.runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
    if (details.kind === "continuation") {
      this.deps.runtimeState.agentRunFromContinuation = true;
    }
    if (details.kind === "command_resume") {
      this.deps.resetErrorRecovery();
    }
    const { content, objectiveRefresh } =
      details.kind === "continuation"
        ? this.refreshContinuationContent(message.content, original, details.goalId)
        : { content: message.content, objectiveRefresh: false };
    return {
      message: {
        ...message,
        content,
        details: {
          ...details,
          lifecycle: "delivered",
          ...(objectiveRefresh ? { objectiveRefresh: true } : {}),
        },
      },
    };
  }) satisfies ExtensionHandler<MessageEndEvent, MessageEndEventResult | undefined>;
}
