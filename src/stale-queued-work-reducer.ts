import {
  ABORTING_TURN_EVENT_DEFAULTS,
  AWAITING_TERMINAL_CLEANUP_EVENT_DEFAULTS,
  IDLE_EVENT_DEFAULTS,
  OBSERVING_TURN_EVENT_DEFAULTS,
  type LifecycleEventDefaults,
} from "./stale-queued-work-reducer-defaults.ts";
import {
  consumeAbortingAgentEnd,
  consumePendingStaleAgentEnd,
  dropActiveObligations,
  markAllObligationsOlder,
  obligationsForStaleAbort,
  setAnonymousMatching,
} from "./stale-queued-work-obligations.ts";
import {
  awaitingFromCleanup,
  cloneTerminalCleanup,
  consumePendingStaleTurnEnd,
  noteTerminalEvents,
  resolveLifecycleAfterTerminalCleanup,
  terminalCleanupHasPending,
} from "./stale-queued-work-terminal-cleanup.ts";
import type {
  AgentEndMessage,
  StaleQueuedWorkEvent,
  StaleQueuedWorkLifecycleKind,
  StaleQueuedWorkPlan,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
  TerminalCleanup,
} from "./stale-queued-work-types.ts";

export type {
  AgentEndMessage,
  StaleQueuedWorkEffect,
  StaleQueuedWorkEvent,
  StaleQueuedWorkLifecycleKind,
  StaleQueuedWorkPlan,
  StaleQueuedWorkState,
  StaleQueuedWorkTransitionResult,
} from "./stale-queued-work-types.ts";

function emptyPlan(): StaleQueuedWorkPlan {
  return { skip: false, effects: [] };
}

function clearAccountingAbortRefreshPlan(): StaleQueuedWorkPlan {
  return {
    skip: false,
    effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
  };
}

function skipClearAccountingRefreshPlan(): StaleQueuedWorkPlan {
  return {
    skip: true,
    effects: [{ type: "clearAccounting" }, { type: "refreshUi" }],
  };
}

function skipRefreshPlan(): StaleQueuedWorkPlan {
  return { skip: true, effects: [{ type: "refreshUi" }] };
}

function transition(
  state: StaleQueuedWorkState,
  plan: StaleQueuedWorkTransitionResult["plan"],
): StaleQueuedWorkTransitionResult {
  return { state, plan };
}

export function lifecycleKindFromState(
  state: StaleQueuedWorkState,
): StaleQueuedWorkLifecycleKind {
  return state.kind;
}

function cloneState(state: StaleQueuedWorkState): StaleQueuedWorkState {
  switch (state.kind) {
    case "idle":
      return { kind: "idle" };
    case "observingTurn":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(state.staleGoalIds),
        hasRunnableWork: state.hasRunnableWork,
        ...(state.terminalCleanup
          ? { terminalCleanup: cloneTerminalCleanup(state.terminalCleanup) }
          : {}),
      };
    case "abortingTurn":
      return {
        kind: "abortingTurn",
        activeTurnIndex: state.activeTurnIndex,
        terminalCleanup: cloneTerminalCleanup(state.terminalCleanup),
      };
    case "awaitingTerminalCleanup":
      return {
        kind: "awaitingTerminalCleanup",
        terminalCleanup: cloneTerminalCleanup(state.terminalCleanup),
      };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function beginObservingFromIdleOrAwaiting(
  state: Extract<StaleQueuedWorkState, { kind: "idle" | "awaitingTerminalCleanup" }>,
): Extract<StaleQueuedWorkState, { kind: "observingTurn" }> {
  return {
    kind: "observingTurn",
    staleGoalIds: new Set(),
    hasRunnableWork: false,
    ...(state.kind === "awaitingTerminalCleanup"
      ? { terminalCleanup: state.terminalCleanup }
      : {}),
  };
}

function finishObservingTurn(
  state: Extract<StaleQueuedWorkState, { kind: "observingTurn" }>,
): StaleQueuedWorkState {
  if (state.terminalCleanup && terminalCleanupHasPending(state.terminalCleanup)) {
    return {
      kind: "awaitingTerminalCleanup",
      terminalCleanup: state.terminalCleanup,
    };
  }
  return { kind: "idle" };
}

function resolveCleanupAfterTerminalEvent(
  cleanup: TerminalCleanup,
  observing: Extract<StaleQueuedWorkState, { kind: "observingTurn" }> | null,
): StaleQueuedWorkState {
  return resolveLifecycleAfterTerminalCleanup(cleanup, observing);
}

function reduceObservingContextAbort(
  state: Extract<StaleQueuedWorkState, { kind: "observingTurn" }>,
  currentTurnIndex: number | null,
): StaleQueuedWorkTransitionResult {
  if (state.staleGoalIds.size === 0 || state.hasRunnableWork) {
    if (!state.terminalCleanup) {
      return transition(state, null);
    }

    setAnonymousMatching(state.terminalCleanup.pendingAgentEndObligations, false);
    return transition(
      {
        kind: "awaitingTerminalCleanup",
        terminalCleanup: state.terminalCleanup,
      },
      null,
    );
  }

  const pendingTurnEndIndexes = new Set(state.terminalCleanup?.pendingTurnEndIndexes ?? []);
  const pendingAgentEndObligations = [
    ...(state.terminalCleanup?.pendingAgentEndObligations ?? []),
  ];
  markAllObligationsOlder({ pendingTurnEndIndexes, pendingAgentEndObligations });
  setAnonymousMatching(pendingAgentEndObligations, true);
  noteTerminalEvents(pendingTurnEndIndexes, currentTurnIndex);

  return transition(
    {
      kind: "abortingTurn",
      activeTurnIndex: currentTurnIndex,
      terminalCleanup: {
        pendingTurnEndIndexes,
        pendingAgentEndObligations: [
          ...pendingAgentEndObligations,
          ...obligationsForStaleAbort(state.staleGoalIds, "active"),
        ],
      },
    },
    clearAccountingAbortRefreshPlan(),
  );
}

function consumeCleanupTurnEnd(
  cleanup: TerminalCleanup,
  turnIndex: number | null,
): boolean {
  return consumePendingStaleTurnEnd(cleanup, turnIndex);
}

function consumeCleanupAgentEnd(
  cleanup: TerminalCleanup,
  messages: AgentEndMessage[],
): boolean {
  return consumePendingStaleAgentEnd(cleanup, messages);
}

function releaseAbortingTurn(
  state: Extract<StaleQueuedWorkState, { kind: "abortingTurn" }>,
  includeRefresh: boolean,
): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  const nextState = awaitingFromCleanup(cleanup);
  const effects: StaleQueuedWorkPlan["effects"] = terminalCleanupHasPending(cleanup)
    ? includeRefresh
      ? [{ type: "clearAccounting" }, { type: "refreshUi" }]
      : [{ type: "clearAccounting" }]
    : includeRefresh
      ? [{ type: "refreshUi" }]
      : [];
  return transition(nextState, { skip: false, effects });
}

function finishActiveAbortingLifecycle(
  state: Extract<StaleQueuedWorkState, { kind: "abortingTurn" }>,
): StaleQueuedWorkTransitionResult {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  dropActiveObligations(cleanup);
  const nextState: StaleQueuedWorkState = terminalCleanupHasPending(cleanup)
    ? { kind: "awaitingTerminalCleanup", terminalCleanup: cleanup }
    : { kind: "idle" };
  return transition(nextState, skipClearAccountingRefreshPlan());
}

function applyDefaultTransition(
  state: StaleQueuedWorkState,
  event: StaleQueuedWorkEvent,
  defaults: LifecycleEventDefaults,
  lifecycle: StaleQueuedWorkLifecycleKind,
): StaleQueuedWorkTransitionResult {
  switch (defaults[event.type]) {
    case "emptyPlan":
      return transition(state, emptyPlan());
    case "noPlan":
      return transition(state, null);
    case "handled":
      throw new Error(
        `Missing stale queued-work reducer handler for ${event.type} in ${lifecycle}`,
      );
    default:
      throw new Error(
        `Unknown stale queued-work default action for ${event.type} in ${lifecycle}`,
      );
  }
}

function reduceStartWorkFromIdleOrAwaiting(
  draft: Extract<StaleQueuedWorkState, { kind: "idle" | "awaitingTerminalCleanup" }>,
  event: Extract<StaleQueuedWorkEvent, { type: "runnableWorkStarted" | "staleWorkStarted" }>,
): StaleQueuedWorkTransitionResult {
  const next = beginObservingFromIdleOrAwaiting(draft);
  if (event.type === "runnableWorkStarted") {
    next.hasRunnableWork = true;
  } else {
    next.staleGoalIds.add(event.goalId);
  }
  return transition(next, emptyPlan());
}

function reduceIdleState(
  draft: Extract<StaleQueuedWorkState, { kind: "idle" }>,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
    case "staleWorkStarted":
      return reduceStartWorkFromIdleOrAwaiting(draft, event);
    default:
      return applyDefaultTransition(draft, event, IDLE_EVENT_DEFAULTS, draft.kind);
  }
}

function reduceTerminalCleanupEvent(
  draft: Extract<StaleQueuedWorkState, { kind: "observingTurn" | "awaitingTerminalCleanup" }>,
  event: Extract<StaleQueuedWorkEvent, { type: "turnEnd" | "agentEnd" }>,
): StaleQueuedWorkTransitionResult {
  const cleanup = draft.terminalCleanup;
  if (cleanup === undefined) {
    return transition(draft, emptyPlan());
  }

  const consumed =
    event.type === "turnEnd"
      ? consumeCleanupTurnEnd(cleanup, event.turnIndex)
      : consumeCleanupAgentEnd(cleanup, event.messages);

  if (!consumed) {
    return transition(draft, emptyPlan());
  }

  return transition(
    resolveCleanupAfterTerminalEvent(cleanup, draft.kind === "observingTurn" ? draft : null),
    skipRefreshPlan(),
  );
}

function reduceObservingTurnState(
  draft: Extract<StaleQueuedWorkState, { kind: "observingTurn" }>,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
      return transition({ ...draft, hasRunnableWork: true }, emptyPlan());
    case "staleWorkStarted":
      draft.staleGoalIds.add(event.goalId);
      return transition(draft, emptyPlan());
    case "contextAbort":
      return reduceObservingContextAbort(draft, event.currentTurnIndex);
    case "turnStart":
      return transition(finishObservingTurn(draft), emptyPlan());
    case "turnEnd":
    case "agentEnd":
      return reduceTerminalCleanupEvent(draft, event);
    case "sessionShutdown":
      return transition({ kind: "idle" }, emptyPlan());
    default:
      return applyDefaultTransition(draft, event, OBSERVING_TURN_EVENT_DEFAULTS, draft.kind);
  }
}

function reduceAbortingTurnState(
  draft: Extract<StaleQueuedWorkState, { kind: "abortingTurn" }>,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "contextAbort":
      return transition(draft, clearAccountingAbortRefreshPlan());
    case "userInputClearAbort":
      return releaseAbortingTurn(draft, true);
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
    case "turnStart":
      return releaseAbortingTurn(draft, false);
    case "toolExecutionEnd":
    case "sessionBeforeCompact":
    case "sessionCompact":
      return transition(draft, skipClearAccountingRefreshPlan());
    case "turnEnd": {
      if (event.turnIndex !== null && draft.activeTurnIndex === event.turnIndex) {
        draft.terminalCleanup.pendingTurnEndIndexes.delete(event.turnIndex);
        return transition(draft, skipClearAccountingRefreshPlan());
      }
      if (consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
        return transition(draft, skipRefreshPlan());
      }
      return transition(draft, emptyPlan());
    }
    case "agentEnd": {
      const result = consumeAbortingAgentEnd(draft, event.messages);
      if (result.consumedActive) {
        return finishActiveAbortingLifecycle(draft);
      }
      if (result.consumedOlder) {
        return transition(draft, skipRefreshPlan());
      }
      if (result.activePending) {
        return transition(draft, emptyPlan());
      }
      return finishActiveAbortingLifecycle(draft);
    }
    case "sessionShutdown":
      return transition({ kind: "idle" }, { skip: false, effects: [{ type: "clearAccounting" }] });
    default:
      return applyDefaultTransition(draft, event, ABORTING_TURN_EVENT_DEFAULTS, draft.kind);
  }
}

function reduceAwaitingTerminalCleanupState(
  draft: Extract<StaleQueuedWorkState, { kind: "awaitingTerminalCleanup" }>,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  switch (event.type) {
    case "runnableWorkStarted":
    case "staleWorkStarted":
      return reduceStartWorkFromIdleOrAwaiting(draft, event);
    case "turnEnd":
    case "agentEnd":
      return reduceTerminalCleanupEvent(draft, event);
    case "sessionShutdown":
      return transition({ kind: "idle" }, emptyPlan());
    default:
      return applyDefaultTransition(
        draft,
        event,
        AWAITING_TERMINAL_CLEANUP_EVENT_DEFAULTS,
        draft.kind,
      );
  }
}

export function reduceStaleQueuedWork(
  state: StaleQueuedWorkState,
  event: StaleQueuedWorkEvent,
): StaleQueuedWorkTransitionResult {
  const draft = cloneState(state);

  switch (draft.kind) {
    case "idle":
      return reduceIdleState(draft, event);
    case "observingTurn":
      return reduceObservingTurnState(draft, event);
    case "abortingTurn":
      return reduceAbortingTurnState(draft, event);
    case "awaitingTerminalCleanup":
      return reduceAwaitingTerminalCleanupState(draft, event);
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

export function createInitialStaleQueuedWorkState(): StaleQueuedWorkState {
  return { kind: "idle" };
}
