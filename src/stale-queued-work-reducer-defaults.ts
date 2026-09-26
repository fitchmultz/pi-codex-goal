import type { StaleQueuedWorkEvent } from "./stale-queued-work-types.ts";

export type EventDefaultAction = "emptyPlan" | "noPlan" | "handled";
export type LifecycleEventDefaults = Record<StaleQueuedWorkEvent["type"], EventDefaultAction>;

export const IDLE_EVENT_DEFAULTS = {
  runnableWorkStarted: "handled",
  staleWorkStarted: "handled",
  contextAbort: "noPlan",
  userInputClearAbort: "emptyPlan",
  extensionContinuationClearAbort: "emptyPlan",
  beforeAgentStartClearAbort: "emptyPlan",
  turnStart: "emptyPlan",
  toolExecutionEnd: "emptyPlan",
  sessionBeforeCompact: "emptyPlan",
  sessionCompact: "emptyPlan",
  turnEnd: "emptyPlan",
  agentEnd: "emptyPlan",
  sessionShutdown: "emptyPlan",
} as const satisfies LifecycleEventDefaults;

export const OBSERVING_TURN_EVENT_DEFAULTS = {
  runnableWorkStarted: "handled",
  staleWorkStarted: "handled",
  contextAbort: "handled",
  userInputClearAbort: "emptyPlan",
  extensionContinuationClearAbort: "emptyPlan",
  beforeAgentStartClearAbort: "emptyPlan",
  turnStart: "handled",
  toolExecutionEnd: "emptyPlan",
  sessionBeforeCompact: "emptyPlan",
  sessionCompact: "emptyPlan",
  turnEnd: "handled",
  agentEnd: "handled",
  sessionShutdown: "handled",
} as const satisfies LifecycleEventDefaults;

export const ABORTING_TURN_EVENT_DEFAULTS = {
  runnableWorkStarted: "emptyPlan",
  staleWorkStarted: "emptyPlan",
  contextAbort: "handled",
  userInputClearAbort: "handled",
  extensionContinuationClearAbort: "handled",
  beforeAgentStartClearAbort: "handled",
  turnStart: "handled",
  toolExecutionEnd: "handled",
  sessionBeforeCompact: "handled",
  sessionCompact: "handled",
  turnEnd: "handled",
  agentEnd: "handled",
  sessionShutdown: "handled",
} as const satisfies LifecycleEventDefaults;

export const AWAITING_TERMINAL_CLEANUP_EVENT_DEFAULTS = {
  runnableWorkStarted: "handled",
  staleWorkStarted: "handled",
  contextAbort: "noPlan",
  userInputClearAbort: "emptyPlan",
  extensionContinuationClearAbort: "emptyPlan",
  beforeAgentStartClearAbort: "emptyPlan",
  turnStart: "emptyPlan",
  toolExecutionEnd: "emptyPlan",
  sessionBeforeCompact: "emptyPlan",
  sessionCompact: "emptyPlan",
  turnEnd: "handled",
  agentEnd: "handled",
  sessionShutdown: "handled",
} as const satisfies LifecycleEventDefaults;
