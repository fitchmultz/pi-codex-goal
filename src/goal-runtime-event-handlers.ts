import { createAgentEventHandlers } from "./goal-runtime-agent-handlers.ts";
import { createInputContextEventHandlers } from "./goal-runtime-input-context-handlers.ts";
import { createSessionEventHandlers } from "./goal-runtime-session-handlers.ts";
import { createTurnEventHandlers } from "./goal-runtime-turn-handlers.ts";
import { createQueuedGoalWorkMessageIdResolver } from "./goal-runtime-event-utils.ts";
import type {
  GoalRuntimeEventContext,
  GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handler-types.ts";

export type {
  ContextEventResult,
  GoalRuntimeEventHandlers,
  MessageStartEvent,
  ToolExecutionEndEvent,
} from "./goal-runtime-event-handler-types.ts";

export function createGoalRuntimeEventHandlers(
  context: GoalRuntimeEventContext,
): GoalRuntimeEventHandlers {
  const queuedGoalWorkMessageIdForRuntime = createQueuedGoalWorkMessageIdResolver(
    context.continuation,
  );

  return {
    ...createInputContextEventHandlers(context, queuedGoalWorkMessageIdForRuntime),
    ...createTurnEventHandlers(context),
    ...createAgentEventHandlers(context),
    ...createSessionEventHandlers(context),
  };
}
