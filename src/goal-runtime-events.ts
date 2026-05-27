import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GoalRuntimeController } from "./goal-runtime-controller.js";

export function registerGoalRuntimeEvents(
  pi: ExtensionAPI,
  controller: GoalRuntimeController,
): void {
  pi.on("input", (event, ctx) => controller.onInput(event, ctx));
  pi.on("context", (event, ctx) => controller.onContext(event, ctx));
  pi.on("session_start", (event, ctx) => controller.onSessionStart(event, ctx));
  pi.on("session_tree", (event, ctx) => controller.onSessionTree(event, ctx));
  pi.on("before_agent_start", (event, ctx) => controller.onBeforeAgentStart(event, ctx));
  pi.on("message_start", (event, ctx) => controller.onMessageStart(event, ctx));
  pi.on("turn_start", (event, ctx) => controller.onTurnStart(event, ctx));
  pi.on("tool_execution_end", (event, ctx) => controller.onToolExecutionEnd(event, ctx));
  pi.on("turn_end", (event, ctx) => controller.onTurnEnd(event, ctx));
  pi.on("agent_end", (event, ctx) => controller.onAgentEnd(event, ctx));
  pi.on("session_before_compact", (event, ctx) =>
    controller.onSessionBeforeCompact(event, ctx),
  );
  pi.on("session_compact", (event, ctx) => controller.onSessionCompact(event, ctx));
  pi.on("session_shutdown", (event, ctx) => controller.onSessionShutdown(event, ctx));
}
