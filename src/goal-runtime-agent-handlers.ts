import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";

import { assistantTurnTokens, isAbortedAssistantMessage } from "./goal-accounting.js";
import { isErrorAssistantMessage, type AssistantErrorMessage } from "./recovery.js";
import {
  handleAgentErrorMessage,
  recordAssistantContextOverflow,
  runStaleQueuedWorkPlan,
  shouldPauseStatusInspectionOnlyContinuation,
  STATUS_INSPECTION_ONLY_CONTINUATION_REASON,
} from "./goal-runtime-event-utils.js";
import type { GoalRuntimeAgentHandlerContext } from "./goal-runtime-event-handler-types.js";

export function createAgentEventHandlers(deps: GoalRuntimeAgentHandlerContext) {
  const { runtimeState, stateController, continuation, goalAccounting, resetErrorRecovery } = deps;

  return {
    onAgentStart: (async () => {
      runtimeState.agentRunSequence += 1;
      runtimeState.agentRunFromContinuation = false;
      runtimeState.agentRunToolNames = [];
    }) satisfies ExtensionHandler<AgentStartEvent>,

    onAgentSettled: (() => {
      continuation.settlePostCompactContinuationFallback();
    }) satisfies ExtensionHandler<AgentSettledEvent>,

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
      if (
        shouldPauseStatusInspectionOnlyContinuation(
          runtimeState.agentRunFromContinuation,
          runtimeState.agentRunToolNames,
        )
      ) {
        stateController.pauseForRecovery(ctx, STATUS_INSPECTION_ONLY_CONTINUATION_REASON);
        return;
      }
      resetErrorRecovery();
      continuation.maybeContinue(ctx);
    }) satisfies ExtensionHandler<AgentEndEvent>,
  };
}
