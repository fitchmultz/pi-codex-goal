import type { AssistantTurnMessage } from "./goal-accounting.js";
import {
  agentEndMessagesIncludeQueuedGoalWork,
  pendingStaleQueuedGoalWorkIdsFromMessages,
} from "./queued-goal-work.js";

export type StaleQueuedWorkEffect =
  | { type: "clearAccounting" }
  | { type: "refreshUi" }
  | { type: "abort" };

export type StaleQueuedWorkPlan = {
  skip: boolean;
  effects: StaleQueuedWorkEffect[];
};

export type StaleQueuedWorkLifecycleKind =
  | "idle"
  | "observingTurn"
  | "abortingTurn"
  | "awaitingTerminalCleanup";

/** One stale abort's pending agent_end: match goalIds, or id-less when acceptsAnonymous. */
type AgentEndObligation = {
  goalIds: Set<string>;
  acceptsAnonymous: boolean;
};

type TerminalCleanup = {
  pendingTurnEndIndexes: Set<number>;
  olderAgentEndObligations: AgentEndObligation[];
  activeAgentEndObligations: AgentEndObligation[];
};

type ObservingTurnState = {
  kind: "observingTurn";
  staleGoalIds: Set<string>;
  hasRunnableWork: boolean;
  terminalCleanup?: TerminalCleanup;
};

type AbortingTurnState = {
  kind: "abortingTurn";
  activeTurnIndex: number | null;
  terminalCleanup: TerminalCleanup;
};

type StaleQueuedWorkLifecycleState =
  | { kind: "idle" }
  | ObservingTurnState
  | AbortingTurnState
  | {
      kind: "awaitingTerminalCleanup";
      pendingTurnEndIndexes: Set<number>;
      pendingAgentEndObligations: AgentEndObligation[];
    };

export interface StaleQueuedWorkGuard {
  lifecycleKind(): StaleQueuedWorkLifecycleKind;
  isBlockingContinuation(): boolean;
  noteRunnableWorkStarted(): void;
  noteStaleWorkStarted(goalId: string): void;
  planContextAbort(currentTurnIndex: number | null): StaleQueuedWorkPlan | null;
  planUserInputClearAbort(): StaleQueuedWorkPlan;
  planExtensionContinuationClearAbort(): StaleQueuedWorkPlan;
  planBeforeAgentStartClearAbort(): StaleQueuedWorkPlan;
  planTurnStart(): StaleQueuedWorkPlan;
  planToolExecutionEnd(): StaleQueuedWorkPlan;
  planSessionBeforeCompact(): StaleQueuedWorkPlan;
  planSessionCompact(): StaleQueuedWorkPlan;
  planTurnEnd(
    turnIndex: number | null,
    message: AssistantTurnMessage,
  ): StaleQueuedWorkPlan;
  planAgentEnd(
    messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
  ): StaleQueuedWorkPlan;
  planSessionShutdown(): StaleQueuedWorkPlan;
}

function lifecycleKindFromState(state: StaleQueuedWorkLifecycleState): StaleQueuedWorkLifecycleKind {
  return state.kind;
}

function agentEndObligationsPending(cleanup: TerminalCleanup): boolean {
  return (
    cleanup.olderAgentEndObligations.length > 0 || cleanup.activeAgentEndObligations.length > 0
  );
}

function terminalCleanupHasPending(cleanup: TerminalCleanup): boolean {
  return cleanup.pendingTurnEndIndexes.size > 0 || agentEndObligationsPending(cleanup);
}

function isStaleTerminalAssistantMessage(message: {
  role: string;
  stopReason?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "aborted" ||
      message.stopReason === "stop" ||
      message.stopReason === "error")
  );
}

function obligationForStaleAbort(staleGoalIds: ReadonlySet<string>): AgentEndObligation {
  return { goalIds: new Set(staleGoalIds), acceptsAnonymous: true };
}

function obligationsForStaleAbort(staleGoalIds: ReadonlySet<string>): AgentEndObligation[] {
  if (staleGoalIds.size === 0) {
    return [];
  }
  return [obligationForStaleAbort(staleGoalIds)];
}

function closeAnonymousMatchingOnObligations(obligations: AgentEndObligation[]): void {
  for (const obligation of obligations) {
    obligation.acceptsAnonymous = false;
  }
}

function openAnonymousMatchingOnObligations(obligations: AgentEndObligation[]): void {
  for (const obligation of obligations) {
    obligation.acceptsAnonymous = true;
  }
}

function pendingGoalIdsFromObligations(obligations: readonly AgentEndObligation[]): Set<string> {
  const goalIds = new Set<string>();
  for (const obligation of obligations) {
    for (const goalId of obligation.goalIds) {
      goalIds.add(goalId);
    }
  }
  return goalIds;
}

function allPendingGoalIds(cleanup: TerminalCleanup): Set<string> {
  return pendingGoalIdsFromObligations([
    ...cleanup.olderAgentEndObligations,
    ...cleanup.activeAgentEndObligations,
  ]);
}

function obligationMatchesAnyGoal(
  obligation: AgentEndObligation,
  matchedGoalIds: ReadonlySet<string>,
): boolean {
  for (const goalId of obligation.goalIds) {
    if (matchedGoalIds.has(goalId)) {
      return true;
    }
  }
  return false;
}

function consumeObligationsForMatchedGoals(
  obligations: AgentEndObligation[],
  matchedGoalIds: readonly string[],
): boolean {
  if (matchedGoalIds.length === 0) {
    return false;
  }
  const remaining = new Set(matchedGoalIds);
  let consumed = false;

  for (let index = 0; index < obligations.length && remaining.size > 0; ) {
    const obligation = obligations[index]!;
    if (!obligationMatchesAnyGoal(obligation, remaining)) {
      index += 1;
      continue;
    }
    for (const goalId of obligation.goalIds) {
      remaining.delete(goalId);
    }
    obligations.splice(index, 1);
    consumed = true;
  }

  return consumed;
}

function removeFirstObligation(obligations: AgentEndObligation[]): boolean {
  if (obligations.length === 0) {
    return false;
  }
  obligations.shift();
  return true;
}

function removeFirstAnonymousEligibleObligation(obligations: AgentEndObligation[]): boolean {
  const index = obligations.findIndex((obligation) => obligation.acceptsAnonymous);
  if (index === -1) {
    return false;
  }
  obligations.splice(index, 1);
  return true;
}

function isSubsetOfSet(values: readonly string[], superset: ReadonlySet<string>): boolean {
  for (const value of values) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

function activeTurnEndConsumed(
  aborting: AbortingTurnState,
  terminalCleanup: TerminalCleanup,
): boolean {
  const { activeTurnIndex } = aborting;
  return activeTurnIndex !== null && !terminalCleanup.pendingTurnEndIndexes.has(activeTurnIndex);
}

function consumeMatchedAbortingTurnObligations(
  obligations: AgentEndObligation[],
  remaining: Set<string>,
): boolean {
  let consumed = false;

  for (let index = 0; index < obligations.length && remaining.size > 0; ) {
    const obligation = obligations[index]!;
    if (!obligationMatchesAnyGoal(obligation, remaining)) {
      index += 1;
      continue;
    }
    for (const goalId of obligation.goalIds) {
      remaining.delete(goalId);
    }
    obligations.splice(index, 1);
    consumed = true;
  }

  return consumed;
}

function consumeAbortingTurnObligationsForMatchedGoals(
  older: AgentEndObligation[],
  active: AgentEndObligation[],
  matchedGoalIds: readonly string[],
  preferActiveFirst: boolean,
): { consumedOlder: boolean; consumedActiveGoalMatch: boolean } {
  if (matchedGoalIds.length === 0) {
    return { consumedOlder: false, consumedActiveGoalMatch: false };
  }

  const remaining = new Set(matchedGoalIds);
  let consumedOlder = false;
  let consumedActiveGoalMatch = false;

  if (preferActiveFirst) {
    consumedActiveGoalMatch = consumeMatchedAbortingTurnObligations(active, remaining);
    consumedOlder = consumeMatchedAbortingTurnObligations(older, remaining);
  } else {
    consumedOlder = consumeMatchedAbortingTurnObligations(older, remaining);
    consumedActiveGoalMatch = consumeMatchedAbortingTurnObligations(active, remaining);
  }

  return { consumedOlder, consumedActiveGoalMatch };
}

function matchesAnonymousStaleAgentEnd(
  messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
): boolean {
  if (agentEndMessagesIncludeQueuedGoalWork(messages)) {
    return false;
  }
  return messages.some(isStaleTerminalAssistantMessage);
}

function noteTerminalEvents(
  pendingTurnEndIndexes: Set<number>,
  currentTurnIndex: number | null,
): void {
  if (currentTurnIndex !== null) {
    pendingTurnEndIndexes.add(currentTurnIndex);
  }
}

function cloneTerminalCleanup(cleanup: TerminalCleanup): TerminalCleanup {
  return {
    pendingTurnEndIndexes: new Set(cleanup.pendingTurnEndIndexes),
    olderAgentEndObligations: [...cleanup.olderAgentEndObligations],
    activeAgentEndObligations: [...cleanup.activeAgentEndObligations],
  };
}

function mergeActiveIntoOlder(cleanup: TerminalCleanup): void {
  cleanup.olderAgentEndObligations.push(...cleanup.activeAgentEndObligations);
  cleanup.activeAgentEndObligations = [];
}

function emptyPlan(): StaleQueuedWorkPlan {
  return { skip: false, effects: [] };
}

function skipPlan(...effects: StaleQueuedWorkEffect[]): StaleQueuedWorkPlan {
  return { skip: true, effects };
}

function beginObservingTurn(
  lifecycle: Exclude<StaleQueuedWorkLifecycleState, { kind: "abortingTurn" }>,
): ObservingTurnState {
  switch (lifecycle.kind) {
    case "observingTurn":
      return lifecycle;
    case "idle":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(),
        hasRunnableWork: false,
      };
    case "awaitingTerminalCleanup":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(),
        hasRunnableWork: false,
        terminalCleanup: {
          pendingTurnEndIndexes: lifecycle.pendingTurnEndIndexes,
          olderAgentEndObligations: lifecycle.pendingAgentEndObligations,
          activeAgentEndObligations: [],
        },
      };
    default: {
      const _exhaustive: never = lifecycle;
      return _exhaustive;
    }
  }
}

function finishObservingTurn(observing: ObservingTurnState): StaleQueuedWorkLifecycleState {
  const cleanup = observing.terminalCleanup;
  if (cleanup !== undefined && terminalCleanupHasPending(cleanup)) {
    return {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes: cleanup.pendingTurnEndIndexes,
      pendingAgentEndObligations: cleanup.olderAgentEndObligations,
    };
  }
  return { kind: "idle" };
}

function terminalCleanupFromLifecycle(
  lifecycle: StaleQueuedWorkLifecycleState,
): { cleanup: TerminalCleanup; observing: ObservingTurnState | null } | null {
  switch (lifecycle.kind) {
    case "awaitingTerminalCleanup":
      return {
        cleanup: {
          pendingTurnEndIndexes: lifecycle.pendingTurnEndIndexes,
          olderAgentEndObligations: lifecycle.pendingAgentEndObligations,
          activeAgentEndObligations: [],
        },
        observing: null,
      };
    case "observingTurn":
      if (lifecycle.terminalCleanup === undefined) {
        return null;
      }
      return { cleanup: lifecycle.terminalCleanup, observing: lifecycle };
    default:
      return null;
  }
}

function resolveLifecycleAfterTerminalCleanup(
  cleanup: TerminalCleanup,
  observing: ObservingTurnState | null,
): StaleQueuedWorkLifecycleState {
  const hasPending = terminalCleanupHasPending(cleanup);

  if (observing) {
    if (hasPending) {
      return { ...observing, terminalCleanup: cleanup };
    }
    const { terminalCleanup: _removed, ...withoutCleanup } = observing;
    return withoutCleanup;
  }

  if (hasPending) {
    return {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes: cleanup.pendingTurnEndIndexes,
      pendingAgentEndObligations: cleanup.olderAgentEndObligations,
    };
  }
  return { kind: "idle" };
}

function consumePendingStaleTurnEnd(
  cleanup: TerminalCleanup,
  turnIndex: number | null,
  _message: AssistantTurnMessage,
): boolean {
  if (turnIndex === null || !cleanup.pendingTurnEndIndexes.has(turnIndex)) {
    return false;
  }
  cleanup.pendingTurnEndIndexes.delete(turnIndex);
  return true;
}

function consumePendingStaleAgentEnd(
  cleanup: TerminalCleanup,
  messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
): boolean {
  const pendingGoalIds = pendingGoalIdsFromObligations(cleanup.olderAgentEndObligations);
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, pendingGoalIds);
  if (consumeObligationsForMatchedGoals(cleanup.olderAgentEndObligations, matchedGoalIds)) {
    return true;
  }
  return matchesAnonymousStaleAgentEnd(messages)
    ? removeFirstAnonymousEligibleObligation(cleanup.olderAgentEndObligations)
    : false;
}

export function createStaleQueuedWorkGuard(): StaleQueuedWorkGuard {
  let lifecycle: StaleQueuedWorkLifecycleState = { kind: "idle" };

  const applyAwaitingFromCleanup = (terminalCleanup: TerminalCleanup): StaleQueuedWorkEffect[] => {
    mergeActiveIntoOlder(terminalCleanup);
    if (!terminalCleanupHasPending(terminalCleanup)) {
      lifecycle = { kind: "idle" };
      return [];
    }
    lifecycle = {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes: terminalCleanup.pendingTurnEndIndexes,
      pendingAgentEndObligations: terminalCleanup.olderAgentEndObligations,
    };
    return [{ type: "clearAccounting" }];
  };

  const releaseAbortingTurn = (): StaleQueuedWorkPlan => {
    if (lifecycle.kind !== "abortingTurn") {
      return emptyPlan();
    }
    const effects = applyAwaitingFromCleanup(cloneTerminalCleanup(lifecycle.terminalCleanup));
    return { skip: false, effects };
  };

  const finishActiveAbortingLifecycle = (aborting: AbortingTurnState): StaleQueuedWorkEffect[] => {
    const terminalCleanup = cloneTerminalCleanup(aborting.terminalCleanup);
    terminalCleanup.activeAgentEndObligations = [];
    const effects: StaleQueuedWorkEffect[] = [{ type: "clearAccounting" }, { type: "refreshUi" }];
    if (terminalCleanupHasPending(terminalCleanup)) {
      lifecycle = {
        kind: "awaitingTerminalCleanup",
        pendingTurnEndIndexes: terminalCleanup.pendingTurnEndIndexes,
        pendingAgentEndObligations: terminalCleanup.olderAgentEndObligations,
      };
    } else {
      lifecycle = { kind: "idle" };
    }
    return effects;
  };

  const planAbortingTurnAgentEnd = (
    aborting: AbortingTurnState,
    messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
  ): StaleQueuedWorkPlan => {
    const { terminalCleanup } = aborting;
    const { olderAgentEndObligations: older, activeAgentEndObligations: active } = terminalCleanup;

    const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(
      messages,
      allPendingGoalIds(terminalCleanup),
    );
    const activeGoalIds = pendingGoalIdsFromObligations(active);
    const preferActiveFirst =
      activeTurnEndConsumed(aborting, terminalCleanup) &&
      matchedGoalIds.length > 0 &&
      isSubsetOfSet(matchedGoalIds, activeGoalIds);

    let { consumedOlder, consumedActiveGoalMatch } = consumeAbortingTurnObligationsForMatchedGoals(
      older,
      active,
      matchedGoalIds,
      preferActiveFirst,
    );

    let finishActive = consumedActiveGoalMatch;
    if (matchesAnonymousStaleAgentEnd(messages)) {
      const preferActiveAnonymous =
        activeTurnEndConsumed(aborting, terminalCleanup) &&
        active.some((obligation) => obligation.acceptsAnonymous);

      if (preferActiveAnonymous) {
        if (removeFirstAnonymousEligibleObligation(active)) {
          finishActive = true;
        }
      } else if (removeFirstAnonymousEligibleObligation(older)) {
        consumedOlder = true;
      } else if (removeFirstObligation(active)) {
        finishActive = true;
      }
    }

    if (finishActive) {
      return skipPlan(...finishActiveAbortingLifecycle(aborting));
    }
    if (consumedOlder) {
      return skipPlan({ type: "refreshUi" });
    }
    if (active.length > 0) {
      return emptyPlan();
    }
    return skipPlan(...finishActiveAbortingLifecycle(aborting));
  };

  const clearAllStaleState = (): StaleQueuedWorkEffect[] => {
    const effects: StaleQueuedWorkEffect[] =
      lifecycle.kind === "abortingTurn" ? [{ type: "clearAccounting" }] : [];
    lifecycle = { kind: "idle" };
    return effects;
  };

  const skipWhileAbortingTurn = (): StaleQueuedWorkPlan => {
    if (lifecycle.kind !== "abortingTurn") {
      return emptyPlan();
    }
    return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
  };

  const clearTurnObservation = (): void => {
    if (lifecycle.kind !== "observingTurn") {
      return;
    }
    lifecycle = finishObservingTurn(lifecycle);
  };

  return {
    lifecycleKind(): StaleQueuedWorkLifecycleKind {
      return lifecycleKindFromState(lifecycle);
    },

    isBlockingContinuation(): boolean {
      return lifecycle.kind === "abortingTurn";
    },

    noteRunnableWorkStarted(): void {
      if (lifecycle.kind === "abortingTurn") {
        return;
      }
      lifecycle = { ...beginObservingTurn(lifecycle), hasRunnableWork: true };
    },

    noteStaleWorkStarted(goalId: string): void {
      if (lifecycle.kind === "abortingTurn") {
        return;
      }
      const observing = beginObservingTurn(lifecycle);
      observing.staleGoalIds.add(goalId);
      lifecycle = observing;
    },

    planContextAbort(currentTurnIndex: number | null): StaleQueuedWorkPlan | null {
      if (lifecycle.kind === "abortingTurn") {
        return {
          skip: false,
          effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
        };
      }

      if (lifecycle.kind !== "observingTurn") {
        return null;
      }

      const observing = lifecycle;
      if (observing.staleGoalIds.size === 0 || observing.hasRunnableWork) {
        if (observing.terminalCleanup !== undefined) {
          closeAnonymousMatchingOnObligations(observing.terminalCleanup.olderAgentEndObligations);
          lifecycle = {
            kind: "awaitingTerminalCleanup",
            pendingTurnEndIndexes: observing.terminalCleanup.pendingTurnEndIndexes,
            pendingAgentEndObligations: observing.terminalCleanup.olderAgentEndObligations,
          };
        }
        return null;
      }

      const pendingTurnEndIndexes = new Set(observing.terminalCleanup?.pendingTurnEndIndexes ?? []);
      const olderAgentEndObligations = [
        ...(observing.terminalCleanup?.olderAgentEndObligations ?? []),
        ...(observing.terminalCleanup?.activeAgentEndObligations ?? []),
      ];
      openAnonymousMatchingOnObligations(olderAgentEndObligations);
      noteTerminalEvents(pendingTurnEndIndexes, currentTurnIndex);

      lifecycle = {
        kind: "abortingTurn",
        activeTurnIndex: currentTurnIndex,
        terminalCleanup: {
          pendingTurnEndIndexes,
          olderAgentEndObligations,
          activeAgentEndObligations: obligationsForStaleAbort(observing.staleGoalIds),
        },
      };
      return {
        skip: false,
        effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
      };
    },

    planUserInputClearAbort(): StaleQueuedWorkPlan {
      const plan = releaseAbortingTurn();
      if (plan.effects.length > 0) {
        return { skip: false, effects: [...plan.effects, { type: "refreshUi" }] };
      }
      return plan;
    },

    planExtensionContinuationClearAbort(): StaleQueuedWorkPlan {
      return releaseAbortingTurn();
    },

    planBeforeAgentStartClearAbort(): StaleQueuedWorkPlan {
      return releaseAbortingTurn();
    },

    planTurnStart(): StaleQueuedWorkPlan {
      clearTurnObservation();
      return releaseAbortingTurn();
    },

    planToolExecutionEnd(): StaleQueuedWorkPlan {
      return skipWhileAbortingTurn();
    },

    planSessionBeforeCompact(): StaleQueuedWorkPlan {
      return skipWhileAbortingTurn();
    },

    planSessionCompact(): StaleQueuedWorkPlan {
      return skipWhileAbortingTurn();
    },

    planTurnEnd(turnIndex: number | null, message: AssistantTurnMessage): StaleQueuedWorkPlan {
      if (lifecycle.kind === "abortingTurn") {
        const aborting = lifecycle;
        const { activeTurnIndex, terminalCleanup } = aborting;
        const isActiveStaleTurn = turnIndex !== null && activeTurnIndex === turnIndex;

        if (isActiveStaleTurn) {
          terminalCleanup.pendingTurnEndIndexes.delete(turnIndex);
          return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
        }

        if (consumePendingStaleTurnEnd(terminalCleanup, turnIndex, message)) {
          return skipPlan({ type: "refreshUi" });
        }

        return emptyPlan();
      }

      const pending = terminalCleanupFromLifecycle(lifecycle);
      if (pending === null || !consumePendingStaleTurnEnd(pending.cleanup, turnIndex, message)) {
        return emptyPlan();
      }

      lifecycle = resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing);
      return skipPlan({ type: "refreshUi" });
    },

    planAgentEnd(messages): StaleQueuedWorkPlan {
      if (lifecycle.kind === "abortingTurn") {
        return planAbortingTurnAgentEnd(lifecycle, messages);
      }

      const pending = terminalCleanupFromLifecycle(lifecycle);
      if (pending === null) {
        return emptyPlan();
      }

      if (!consumePendingStaleAgentEnd(pending.cleanup, messages)) {
        return emptyPlan();
      }

      lifecycle = resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing);
      return skipPlan({ type: "refreshUi" });
    },

    planSessionShutdown(): StaleQueuedWorkPlan {
      clearTurnObservation();
      return { skip: false, effects: clearAllStaleState() };
    },
  };
}
