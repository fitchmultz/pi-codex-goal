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

type TerminalCleanup = {
  pendingTurnEndIndexes: Set<number>;
  pendingAgentEndGoalIds: Set<string>;
  pendingAnonymousAgentEnd: boolean;
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
  activeStaleGoalIds: Set<string>;
  terminalCleanup: TerminalCleanup;
};

type StaleQueuedWorkLifecycleState =
  | { kind: "idle" }
  | ObservingTurnState
  | AbortingTurnState
  | {
      kind: "awaitingTerminalCleanup";
      pendingTurnEndIndexes: Set<number>;
      pendingAgentEndGoalIds: Set<string>;
      pendingAnonymousAgentEnd: boolean;
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

function terminalCleanupHasPending(cleanup: TerminalCleanup): boolean {
  return (
    cleanup.pendingTurnEndIndexes.size > 0 ||
    cleanup.pendingAgentEndGoalIds.size > 0 ||
    cleanup.pendingAnonymousAgentEnd
  );
}

function isStaleTerminalAssistantMessage(message: {
  role: string;
  stopReason?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "aborted" || message.stopReason === "stop")
  );
}

function noteTerminalEvents(
  pendingTurnEndIndexes: Set<number>,
  pendingAgentEndGoalIds: Set<string>,
  currentTurnIndex: number | null,
  staleGoalIds: ReadonlySet<string>,
): void {
  if (currentTurnIndex !== null) {
    pendingTurnEndIndexes.add(currentTurnIndex);
  }
  for (const goalId of staleGoalIds) {
    pendingAgentEndGoalIds.add(goalId);
  }
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
          pendingAgentEndGoalIds: lifecycle.pendingAgentEndGoalIds,
          pendingAnonymousAgentEnd: lifecycle.pendingAnonymousAgentEnd,
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
      pendingAgentEndGoalIds: cleanup.pendingAgentEndGoalIds,
      pendingAnonymousAgentEnd: cleanup.pendingAnonymousAgentEnd,
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
          pendingAgentEndGoalIds: lifecycle.pendingAgentEndGoalIds,
          pendingAnonymousAgentEnd: lifecycle.pendingAnonymousAgentEnd,
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
      pendingAgentEndGoalIds: cleanup.pendingAgentEndGoalIds,
      pendingAnonymousAgentEnd: cleanup.pendingAnonymousAgentEnd,
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
): string[] {
  return pendingStaleQueuedGoalWorkIdsFromMessages(messages, cleanup.pendingAgentEndGoalIds);
}

function consumePendingAnonymousStaleAgentEnd(
  cleanup: TerminalCleanup,
  messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
): boolean {
  if (!cleanup.pendingAnonymousAgentEnd) {
    return false;
  }
  if (agentEndMessagesIncludeQueuedGoalWork(messages)) {
    return false;
  }
  if (!messages.some(isStaleTerminalAssistantMessage)) {
    return false;
  }
  cleanup.pendingAnonymousAgentEnd = false;
  return true;
}

export function createStaleQueuedWorkGuard(): StaleQueuedWorkGuard {
  let lifecycle: StaleQueuedWorkLifecycleState = { kind: "idle" };

  const transitionToAwaitingTerminalCleanup = (
    terminalCleanup: TerminalCleanup,
  ): StaleQueuedWorkEffect[] => {
    if (!terminalCleanupHasPending(terminalCleanup)) {
      lifecycle = { kind: "idle" };
      return [];
    }
    lifecycle = {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes: terminalCleanup.pendingTurnEndIndexes,
      pendingAgentEndGoalIds: terminalCleanup.pendingAgentEndGoalIds,
      pendingAnonymousAgentEnd: terminalCleanup.pendingAnonymousAgentEnd,
    };
    return [{ type: "clearAccounting" }];
  };

  const releaseAbortingTurn = (): StaleQueuedWorkPlan => {
    if (lifecycle.kind !== "abortingTurn") {
      return emptyPlan();
    }
    const aborting = lifecycle;
    const terminalCleanup: TerminalCleanup = {
      pendingTurnEndIndexes: aborting.terminalCleanup.pendingTurnEndIndexes,
      pendingAgentEndGoalIds: aborting.terminalCleanup.pendingAgentEndGoalIds,
      pendingAnonymousAgentEnd:
        aborting.activeStaleGoalIds.size > 0 ||
        aborting.terminalCleanup.pendingAnonymousAgentEnd,
    };
    const effects = transitionToAwaitingTerminalCleanup(terminalCleanup);
    return { skip: false, effects };
  };

  const finishActiveAbortingLifecycle = (
    aborting: AbortingTurnState,
  ): StaleQueuedWorkEffect[] => {
    const { terminalCleanup } = aborting;
    for (const goalId of aborting.activeStaleGoalIds) {
      terminalCleanup.pendingAgentEndGoalIds.delete(goalId);
    }
    terminalCleanup.pendingAnonymousAgentEnd = false;
    if (terminalCleanupHasPending(terminalCleanup)) {
      lifecycle = {
        kind: "awaitingTerminalCleanup",
        pendingTurnEndIndexes: terminalCleanup.pendingTurnEndIndexes,
        pendingAgentEndGoalIds: terminalCleanup.pendingAgentEndGoalIds,
        pendingAnonymousAgentEnd: terminalCleanup.pendingAnonymousAgentEnd,
      };
    } else {
      lifecycle = { kind: "idle" };
    }
    return [{ type: "clearAccounting" }, { type: "refreshUi" }];
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
          lifecycle = {
            kind: "awaitingTerminalCleanup",
            pendingTurnEndIndexes: observing.terminalCleanup.pendingTurnEndIndexes,
            pendingAgentEndGoalIds: observing.terminalCleanup.pendingAgentEndGoalIds,
            pendingAnonymousAgentEnd: observing.terminalCleanup.pendingAnonymousAgentEnd,
          };
        }
        return null;
      }

      const pendingTurnEndIndexes = new Set(observing.terminalCleanup?.pendingTurnEndIndexes ?? []);
      const pendingAgentEndGoalIds = new Set(observing.terminalCleanup?.pendingAgentEndGoalIds ?? []);
      const pendingAnonymousAgentEnd = observing.terminalCleanup?.pendingAnonymousAgentEnd ?? false;
      noteTerminalEvents(
        pendingTurnEndIndexes,
        pendingAgentEndGoalIds,
        currentTurnIndex,
        observing.staleGoalIds,
      );

      lifecycle = {
        kind: "abortingTurn",
        activeTurnIndex: currentTurnIndex,
        activeStaleGoalIds: new Set(observing.staleGoalIds),
        terminalCleanup: {
          pendingTurnEndIndexes,
          pendingAgentEndGoalIds,
          pendingAnonymousAgentEnd,
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
        const aborting = lifecycle;

        const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(
          messages,
          aborting.terminalCleanup.pendingAgentEndGoalIds,
        );
        const activeGoalIds = matchedGoalIds.filter((goalId) =>
          aborting.activeStaleGoalIds.has(goalId),
        );
        const olderGoalIds = matchedGoalIds.filter(
          (goalId) => !aborting.activeStaleGoalIds.has(goalId),
        );

        if (activeGoalIds.length > 0) {
          for (const goalId of olderGoalIds) {
            aborting.terminalCleanup.pendingAgentEndGoalIds.delete(goalId);
          }
          return skipPlan(...finishActiveAbortingLifecycle(aborting));
        }

        if (olderGoalIds.length > 0) {
          for (const goalId of olderGoalIds) {
            aborting.terminalCleanup.pendingAgentEndGoalIds.delete(goalId);
          }
          return skipPlan({ type: "refreshUi" });
        }

        return skipPlan(...finishActiveAbortingLifecycle(aborting));
      }

      const pending = terminalCleanupFromLifecycle(lifecycle);
      if (pending === null) {
        return emptyPlan();
      }

      const staleGoalIds = consumePendingStaleAgentEnd(pending.cleanup, messages);
      if (staleGoalIds.length > 0) {
        for (const goalId of staleGoalIds) {
          pending.cleanup.pendingAgentEndGoalIds.delete(goalId);
        }
        lifecycle = resolveLifecycleAfterTerminalCleanup(pending.cleanup, pending.observing);
        return skipPlan({ type: "refreshUi" });
      }

      if (!consumePendingAnonymousStaleAgentEnd(pending.cleanup, messages)) {
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
