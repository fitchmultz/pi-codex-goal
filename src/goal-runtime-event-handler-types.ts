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
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { GoalRuntimeState } from "./goal-runtime-state.js";
import type { StatusContext } from "./goal-runtime-status.js";
import type { GoalStateController } from "./goal-state-controller.js";
import type { AssistantErrorMessage } from "./recovery.js";
import type { GoalEntrySource, GoalResult } from "./types.js";

export type ContextEventResult = { messages?: ContextEvent["messages"] };
export type MessageStartEvent = Extract<ExtensionEvent, { type: "message_start" }>;
export type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;

export interface GoalRuntimeEventHandlers {
  onInput: ExtensionHandler<InputEvent, InputEventResult>;
  onContext: ExtensionHandler<ContextEvent, ContextEventResult | undefined>;
  onSessionStart: ExtensionHandler<SessionStartEvent>;
  onSessionTree: ExtensionHandler<SessionTreeEvent>;
  onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, undefined>;
  onAgentStart: ExtensionHandler<AgentStartEvent>;
  onMessageStart: ExtensionHandler<MessageStartEvent>;
  onTurnStart: ExtensionHandler<TurnStartEvent>;
  onToolExecutionEnd: ExtensionHandler<ToolExecutionEndEvent>;
  onTurnEnd: ExtensionHandler<TurnEndEvent>;
  onAgentEnd: ExtensionHandler<AgentEndEvent>;
  onSessionBeforeCompact: ExtensionHandler<SessionBeforeCompactEvent>;
  onSessionCompact: ExtensionHandler<SessionCompactEvent>;
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
  bindPassthroughContinuationInputToTurn: (turnIndex: number) => void;
  clearContinuationState: () => void;
  clearContinuationStateFor: (goalId: string) => void;
  clearContinuationTimer: () => void;
  clearPostCompactContinuationFallback: () => void;
  clearPassthroughContinuationInput: () => void;
  continuationGoalIdFromRuntimePrompt: (prompt: string) => string | null;
  markContinuationQueued: (goalId: string) => void;
  maybeContinue: (ctx: ExtensionContext) => void;
  maybeContinueAfterCurrentEvent: (ctx: ExtensionContext) => void;
  maybeContinueAfterPostCompactFallback: (
    ctx: ExtensionContext,
    options: {
      turnIndex: number | null;
      agentRunSequence: number;
      prepareContinuation?: () => boolean;
    },
  ) => void;
  notePassthroughContinuationInput: (input: string) => void;
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
  runtimeState: Pick<GoalRuntimeState, "currentTurnIndex" | "staleQueuedWorkGuard">;
  stateController: Pick<
    GoalStateController,
    "getGoal" | "isCurrentActiveGoalId" | "persistHostOverflowUserReset"
  >;
  continuation: GoalRuntimeContinuationPort;
  recoveryRuntime: Pick<RecoveryRuntimePort, "onUserInput">;
  resetErrorRecovery: () => void;
}

export interface GoalRuntimeTurnHandlerContext extends StaleQueuedWorkEffectContext {
  runtimeState: Pick<GoalRuntimeState, "currentTurnIndex" | "staleQueuedWorkGuard">;
  stateController: Pick<
    GoalStateController,
    | "beginOverflowRecovery"
    | "flushGoalPersistence"
    | "maybeFlushRuntimePersistence"
    | "pauseForAbort"
  >;
  continuation: Pick<GoalRuntimeContinuationPort, "bindPassthroughContinuationInputToTurn">;
  goalAccounting: GoalAccountingPort;
  recoveryRuntime: Pick<RecoveryRuntimePort, "finishSuccessfulAssistantTurn">;
}

export interface GoalRuntimeAgentHandlerContext extends StaleQueuedWorkEffectContext {
  runtimeState: Pick<GoalRuntimeState, "agentRunSequence" | "staleQueuedWorkGuard">;
  stateController: Pick<
    GoalStateController,
    "applyGoalTransition" | "beginOverflowRecovery" | "flushGoalPersistence" | "pauseForAbort"
  >;
  continuation: Pick<
    GoalRuntimeContinuationPort,
    "clearPassthroughContinuationInput" | "maybeContinue"
  >;
  goalAccounting: Pick<GoalAccountingPort, "accountProgress">;
  recoveryRuntime: Pick<
    RecoveryRuntimePort,
    "handlePersistentAssistantError" | "handleSilentContextOverflow"
  >;
  resetErrorRecovery: () => void;
}

export interface GoalRuntimeSessionHandlerContext extends StaleQueuedWorkEffectContext {
  runtimeState: Pick<
    GoalRuntimeState,
    | "agentRunSequence"
    | "currentTurnIndex"
    | "recoveryState"
    | "staleQueuedWorkGuard"
  >;
  stateController: Pick<
    GoalStateController,
    "applyGoalTransition" | "flushGoalPersistence" | "getGoal" | "reloadFromSession"
  >;
  continuation: Pick<
    GoalRuntimeContinuationPort,
    | "clearContinuationTimer"
    | "clearPostCompactContinuationFallback"
    | "clearPassthroughContinuationInput"
    | "maybeContinue"
    | "maybeContinueAfterCurrentEvent"
    | "maybeContinueAfterPostCompactFallback"
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

export type QueuedGoalWorkMessage = {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
};

export type QueuedGoalWorkMessageIdResolver = (message: QueuedGoalWorkMessage) => string | null;
