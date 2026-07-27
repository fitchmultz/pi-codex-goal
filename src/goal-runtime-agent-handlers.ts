import type { AgentEndEvent, AgentStartEvent, ExtensionHandler } from "@earendil-works/pi-coding-agent";

import { assistantTurnTokens, isAbortedAssistantMessage } from "./goal-accounting.js";
import { isErrorAssistantMessage, type AssistantErrorMessage } from "./recovery.js";
import {
  handleAgentErrorMessage,
  recordAssistantContextOverflow,
  runStaleQueuedWorkPlan,
} from "./goal-runtime-event-utils.js";
import type { GoalRuntimeAgentHandlerContext } from "./goal-runtime-event-handler-types.js";

function isGoalInspectionToolName(name: unknown): boolean {
  return name === "get_goal" || (typeof name === "string" && name.endsWith("__get_goal"));
}

function hasOnlyGoalInspectionToolCalls(messages: readonly { role?: string; content?: unknown }[]): boolean {
  let toolCallCount = 0;

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") {
        continue;
      }
      toolCallCount += 1;
      if (!isGoalInspectionToolName((block as { name?: unknown }).name)) {
        return false;
      }
    }
  }

  return toolCallCount > 0;
}

const BLOCKED_GOAL_INSPECTION_REASON =
  "active goal continuation made no actionable progress; user input is required";

export function createAgentEventHandlers(deps: GoalRuntimeAgentHandlerContext) {
  const { runtimeState, stateController, continuation, goalAccounting, resetErrorRecovery } = deps;

  return {
    onAgentStart: (async () => {
      runtimeState.agentRunSequence += 1;
    }) satisfies ExtensionHandler<AgentStartEvent>,

    onAgentEnd: (async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planAgentEnd(event.messages), ctx, deps)) {
        return;
      }

      const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
      const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
        return sum + assistantTurnTokens(message);
      }, 0);
      goalAccounting.accountProgress(ctx, false, abortedTurnTokens, true);
      stateController.flushGoalPersistence("runtime");
      if (abortedMessages.length > 0) {
        stateController.pauseForAbort(ctx);
        return;
      }
      const errorMessages = event.messages.filter(isErrorAssistantMessage);
      if (errorMessages.length > 0) {
        const lastError = errorMessages.at(-1) as AssistantErrorMessage | undefined;
        if (lastError) {
          handleAgentErrorMessage(lastError, ctx, deps);
        }
        return;
      }

      const lastAssistant = [...event.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (lastAssistant && recordAssistantContextOverflow(lastAssistant, ctx, deps)) {
        return;
      }
      if (hasOnlyGoalInspectionToolCalls(event.messages)) {
        stateController.applyGoalTransition(
          { kind: "recovery_pause", recoveryReason: BLOCKED_GOAL_INSPECTION_REASON },
          ctx,
        );
        return;
      }

      resetErrorRecovery();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<AgentEndEvent>,
  };
}
