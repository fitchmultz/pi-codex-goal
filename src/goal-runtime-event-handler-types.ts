import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionHandler,
  InputEvent,
  InputEventResult,
  MessageEndEventResult,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { GoalDeliveries } from "./goal-delivery.ts";
import type { GoalRuntimeState } from "./goal-runtime-state.ts";
import type { StatusContext } from "./goal-runtime-status.ts";
import type { GoalStateController } from "./goal-state-controller.ts";
import type { AssistantErrorMessage } from "./recovery.ts";
import type { GoalEntrySource, GoalResult } from "./types.ts";

export type { MessageEndEventResult };
export type MessageStartEvent = Extract<ExtensionEvent, { type: "message_start" }>;
export type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;
export type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;

export interface GoalRuntimeEventHandlers {
  onInput: ExtensionHandler<InputEvent, InputEventResult>;
  onContext: ExtensionHandler<ContextEvent, undefined>;
  onSessionStart: ExtensionHandler<SessionStartEvent>;
  onSessionTree: ExtensionHandler<SessionTreeEvent>;
  onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, undefined>;
  onAgentStart: ExtensionHandler<AgentStartEvent>;
  onMessageStart: ExtensionHandler<MessageStartEvent>;
  onMessageEnd: ExtensionHandler<MessageEndEvent, MessageEndEventResult | undefined>;
  onTurnStart: ExtensionHandler<TurnStartEvent>;
  onToolExecutionEnd: ExtensionHandler<ToolExecutionEndEvent>;
  onTurnEnd: ExtensionHandler<TurnEndEvent>;
  onAgentEnd: ExtensionHandler<AgentEndEvent>;
  onSessionBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent>;
  onSessionCompact: ExtensionHandler<SessionCompactEvent>;
  onSessionCompactFailed: ExtensionHandler<SessionCompactFailedEvent>;
  onSessionShutdown: ExtensionHandler<SessionShutdownEvent>;
}

export interface GoalRuntimeStatusPort {
  refreshUi: (ctx: ExtensionContext) => void;
  stopStatusRefresh: () => void;
}

export interface ProviderLimitAutoResumePort {
  clear: () => void;
}

export interface GoalRuntimeContinuationPort {
  clearContinuationState: () => void;
  clearContinuationStateFor: (goalId: string) => void;
  clearContinuationTimer: () => void;
  clearPostCompactContinuationFallback: () => void;
  markContinuationQueued: (goalId: string) => void;
  requireFullGoal: () => void;
  restoreCompactionRefresh: (branch: readonly SessionEntry[]) => void;
  fullPromptForDelivery: (goalId: string) => string | null;
  maybeContinue: (ctx: ExtensionContext, duringAgentEnd?: boolean) => void;
  maybeContinueAfterCurrentEvent: (ctx: ExtensionContext) => void;
  maybeContinueAfterPostCompactFallback: (
    ctx: ExtensionContext,
    options: {
      turnIndex: number | null;
      agentRunSequence: number;
      prepareContinuation?: () => boolean;
    },
  ) => void;
}

export interface GoalAccountingPort {
  accountProgress: (
    ctx: ExtensionContext,
    includeActiveElapsed: boolean,
    completedTurnTokens: number,
    forceFlush?: boolean,
  ) => void;
  beginAccounting: () => void;
}

export interface RecoveryRuntimePort {
  finishSuccessfulAssistantTurn: (
    message: TurnEndEvent["message"],
    ctx: ExtensionContext,
    options: { continueGoal: boolean },
  ) => void;
  handlePersistentAssistantError: (message: AssistantErrorMessage, ctx: ExtensionContext) => void;
  handleSilentContextOverflow: (ctx: ExtensionContext) => void;
  onSessionCompact: () => void;
  onUserInput: () => void;
}

export interface StaleQueuedWorkEffectContext {
  status: GoalRuntimeStatusPort;
  clearActiveAccounting: () => void;
  providerLimitAutoResume: ProviderLimitAutoResumePort;
}

export interface GoalRuntimeInputContextHandlerContext extends StaleQueuedWorkEffectContext {
  deliveries: GoalDeliveries;
  runtimeState: Pick<
    GoalRuntimeState,
    "agentRunFromContinuation" | "currentTurnIndex" | "staleQueuedWorkGuard"
  >;
  stateController: Pick<
    GoalStateController,
    "getGoal" | "isCurrentActiveGoalId" | "persistHostOverflowUserReset" | "resumeWaitingGoal"
  >;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: Pick<GoalAccountingPort, "beginAccounting">;
  recoveryRuntime: Pick<RecoveryRuntimePort, "onUserInput">;
  resetErrorRecovery: () => void;
}

export interface GoalRuntimeTurnHandlerContext extends StaleQueuedWorkEffectContext {
  runtimeState: Pick<
    GoalRuntimeState,
    | "accounting"
    | "agentRunFromContinuation"
    | "agentRunToolNames"
    | "completionGoalId"
    | "currentTurnIndex"
    | "staleQueuedWorkGuard"
  >;
  stateController: Pick<
    GoalStateController,
    | "beginOverflowRecovery"
    | "flushGoalPersistence"
    | "getGoal"
    | "maybeFlushRuntimePersistence"
    | "pauseForAbort"
    | "persistHostOverflowUserReset"
  >;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: Pick<RecoveryRuntimePort, "finishSuccessfulAssistantTurn">;
}

export interface GoalRuntimeAgentHandlerContext extends StaleQueuedWorkEffectContext {
  deliveries: GoalDeliveries;
  runtimeState: Pick<
    GoalRuntimeState,
    | "agentRunFromContinuation"
    | "agentRunSequence"
    | "agentRunToolNames"
    | "staleQueuedWorkGuard"
  >;
  stateController: Pick<
    GoalStateController,
    "beginOverflowRecovery" | "flushGoalPersistence" | "pauseForAbort" | "pauseForRecovery"
  >;
  continuation: Pick<
    GoalRuntimeContinuationPort,
    "maybeContinue" | "clearContinuationState" | "maybeContinueAfterCurrentEvent" | "requireFullGoal"
  >;
  goalAccounting: Pick<GoalAccountingPort, "accountProgress">;
  recoveryRuntime: Pick<
    RecoveryRuntimePort,
    "handlePersistentAssistantError" | "handleSilentContextOverflow"
  >;
  resetErrorRecovery: () => void;
}

export interface GoalRuntimeSessionHandlerContext extends StaleQueuedWorkEffectContext {
  deliveries: GoalDeliveries;
  runtimeState: Pick<
    GoalRuntimeState,
    | "agentRunSequence"
    | "currentTurnIndex"
    | "recoveryState"
    | "staleQueuedWorkGuard"
  >;
  stateController: Pick<
    GoalStateController,
    "applyGoalTransition" | "flushGoalPersistence" | "getGoal" | "reloadFromSession" | "pauseForRecovery"
  >;
  continuation: Pick<
    GoalRuntimeContinuationPort,
    | "clearContinuationTimer"
    | "clearPostCompactContinuationFallback"
    | "maybeContinue"
    | "maybeContinueAfterCurrentEvent"
    | "maybeContinueAfterPostCompactFallback"
    | "requireFullGoal"
    | "restoreCompactionRefresh"
  >;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: Pick<RecoveryRuntimePort, "onSessionCompact">;
  resetErrorRecovery: () => void;
  resumeGoalWithContinuation: (goalId: string, source: GoalEntrySource, ctx: StatusContext) => GoalResult;
}

export interface GoalRuntimeOverflowRecoveryContext {
  stateController: Pick<GoalStateController, "beginOverflowRecovery">;
  recoveryRuntime: Pick<
    RecoveryRuntimePort,
    "handlePersistentAssistantError" | "handleSilentContextOverflow"
  >;
}

export interface GoalRuntimeEventContext {
  deliveries: GoalDeliveries;
  pi: ExtensionAPI;
  runtimeState: GoalRuntimeState;
  stateController: GoalStateController;
  continuation: GoalRuntimeContinuationPort;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: RecoveryRuntimePort;
  status: GoalRuntimeStatusPort;
  providerLimitAutoResume: ProviderLimitAutoResumePort;
  clearActiveAccounting: () => void;
  resetErrorRecovery: () => void;
  resumeGoalWithContinuation: (goalId: string, source: GoalEntrySource, ctx: StatusContext) => GoalResult;
}
