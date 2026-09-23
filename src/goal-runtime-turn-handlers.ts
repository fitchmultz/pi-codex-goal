import type { ExtensionHandler, TurnEndEvent, TurnStartEvent } from "@earendil-works/pi-coding-agent";

import { assistantTurnTokens, isAbortedAssistantMessage, isToolUseAssistantMessage } from "./goal-accounting.js";
import { isAssistantContextOverflow, isErrorAssistantMessage } from "./recovery.js";
import {
  getContextWindow,
  runStaleQueuedWorkPlan,
  shouldPauseStatusInspectionOnlyContinuation,
} from "./goal-runtime-event-utils.js";
import type {
  GoalRuntimeTurnHandlerContext,
  ToolExecutionEndEvent,
} from "./goal-runtime-event-handler-types.js";

export function createTurnEventHandlers(deps: GoalRuntimeTurnHandlerContext) {
  const { runtimeState, stateController, continuation, goalAccounting, recoveryRuntime, status } = deps;

  return {
    onTurnStart: (async (event, ctx) => {
      runtimeState.currentTurnIndex = event.turnIndex;
      continuation.bindPassthroughContinuationInputToTurn(event.turnIndex);
      runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planTurnStart(), ctx, deps);
      goalAccounting.beginAccounting();
      status.refreshUi(ctx);
    }) satisfies ExtensionHandler<TurnStartEvent>,

    onToolExecutionEnd: (async (event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planToolExecutionEnd(), ctx, deps)) {
        return;
      }

      runtimeState.agentRunToolNames.push(event.toolName);
      goalAccounting.accountProgress(ctx, true, 0, true);
      stateController.maybeFlushRuntimePersistence("runtime");
    }) satisfies ExtensionHandler<ToolExecutionEndEvent>,

    onTurnEnd: (async (event, ctx) => {
      if (
        runStaleQueuedWorkPlan(
          runtimeState.staleQueuedWorkGuard.planTurnEnd(event.turnIndex),
          ctx,
          deps,
        )
      ) {
        return;
      }

      const completedTurnTokens = assistantTurnTokens(event.message);
      goalAccounting.accountProgress(ctx, true, completedTurnTokens);
      runtimeState.accounting.turnGoalId = null;
      stateController.flushGoalPersistence("runtime");
      if (isAbortedAssistantMessage(event.message)) {
        stateController.pauseForAbort(ctx);
        return;
      }
      if (isErrorAssistantMessage(event.message)) {
        return;
      }
      if (isAssistantContextOverflow(event.message, getContextWindow(ctx))) {
        stateController.beginOverflowRecovery(ctx);
        return;
      }
      const suppressContinuation = shouldPauseStatusInspectionOnlyContinuation(
        runtimeState.agentRunFromContinuation,
        runtimeState.agentRunToolNames,
      );
      recoveryRuntime.finishSuccessfulAssistantTurn(event.message, ctx, {
        continueGoal: !isToolUseAssistantMessage(event.message) && !suppressContinuation,
      });
    }) satisfies ExtensionHandler<TurnEndEvent>,
  };
}
