import { isAbortedAssistantMessage, type AssistantTurnMessage } from "./goal-accounting.js";
import { pendingStaleQueuedGoalWorkIdsFromMessages } from "./queued-goal-work.js";

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

type ObservingTurnState = {
  kind: "observingTurn";
  staleGoalIds: Set<string>;
  hasRunnableWork: boolean;
  pendingTurnEndIndexes?: Set<number>;
  pendingAgentEndGoalIds?: Set<string>;
};

type StaleQueuedWorkLifecycleState =
  | { kind: "idle" }
  | ObservingTurnState
  | {
      kind: "abortingTurn";
      turnIndex: number | null;
      pendingTurnEndIndexes: Set<number>;
      pendingAgentEndGoalIds: Set<string>;
    }
  | {
      kind: "awaitingTerminalCleanup";
      pendingTurnEndIndexes: Set<number>;
      pendingAgentEndGoalIds: Set<string>;
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
        pendingTurnEndIndexes: lifecycle.pendingTurnEndIndexes,
        pendingAgentEndGoalIds: lifecycle.pendingAgentEndGoalIds,
      };
    default: {
      const _exhaustive: never = lifecycle;
      return _exhaustive;
    }
  }
}

function finishObservingTurn(observing: ObservingTurnState): StaleQueuedWorkLifecycleState {
  const pendingTurnEndIndexes = observing.pendingTurnEndIndexes;
  const pendingAgentEndGoalIds = observing.pendingAgentEndGoalIds;
  if (
    pendingTurnEndIndexes !== undefined &&
    pendingAgentEndGoalIds !== undefined &&
    (pendingTurnEndIndexes.size > 0 || pendingAgentEndGoalIds.size > 0)
  ) {
    return {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes,
      pendingAgentEndGoalIds,
    };
  }
  return { kind: "idle" };
}

export function createStaleQueuedWorkGuard(): StaleQueuedWorkGuard {
  let lifecycle: StaleQueuedWorkLifecycleState = { kind: "idle" };

  const transitionToAwaitingTerminalCleanup = (
    pendingTurnEndIndexes: Set<number>,
    pendingAgentEndGoalIds: Set<string>,
  ): StaleQueuedWorkEffect[] => {
    if (pendingTurnEndIndexes.size === 0 && pendingAgentEndGoalIds.size === 0) {
      lifecycle = { kind: "idle" };
      return [];
    }
    lifecycle = {
      kind: "awaitingTerminalCleanup",
      pendingTurnEndIndexes,
      pendingAgentEndGoalIds,
    };
    return [{ type: "clearAccounting" }];
  };

  const releaseAbortingTurn = (): StaleQueuedWorkPlan => {
    if (lifecycle.kind !== "abortingTurn") {
      return emptyPlan();
    }
    const effects = transitionToAwaitingTerminalCleanup(
      lifecycle.pendingTurnEndIndexes,
      lifecycle.pendingAgentEndGoalIds,
    );
    return { skip: false, effects };
  };

  const finishAbortingLifecycle = (): StaleQueuedWorkEffect[] => {
    if (lifecycle.kind !== "abortingTurn") {
      return [];
    }
    lifecycle = { kind: "idle" };
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
        if (
          observing.pendingTurnEndIndexes !== undefined &&
          observing.pendingAgentEndGoalIds !== undefined
        ) {
          lifecycle = {
            kind: "awaitingTerminalCleanup",
            pendingTurnEndIndexes: observing.pendingTurnEndIndexes,
            pendingAgentEndGoalIds: observing.pendingAgentEndGoalIds,
          };
        }
        return null;
      }

      const pendingTurnEndIndexes = new Set(observing.pendingTurnEndIndexes ?? []);
      const pendingAgentEndGoalIds = new Set(observing.pendingAgentEndGoalIds ?? []);
      noteTerminalEvents(
        pendingTurnEndIndexes,
        pendingAgentEndGoalIds,
        currentTurnIndex,
        observing.staleGoalIds,
      );

      lifecycle = {
        kind: "abortingTurn",
        turnIndex: currentTurnIndex,
        pendingTurnEndIndexes,
        pendingAgentEndGoalIds,
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
        const isActiveStaleTurn = turnIndex !== null && lifecycle.turnIndex === turnIndex;
        if (!isActiveStaleTurn) {
          return emptyPlan();
        }
        if (turnIndex !== null) {
          lifecycle.pendingTurnEndIndexes.delete(turnIndex);
        }
        return skipPlan({ type: "clearAccounting" }, { type: "refreshUi" });
      }

      if (lifecycle.kind !== "awaitingTerminalCleanup") {
        return emptyPlan();
      }

      const isPendingStaleTurnEnd =
        turnIndex !== null &&
        isAbortedAssistantMessage(message) &&
        lifecycle.pendingTurnEndIndexes.has(turnIndex);
      if (!isPendingStaleTurnEnd) {
        return emptyPlan();
      }

      lifecycle.pendingTurnEndIndexes.delete(turnIndex);
      if (
        lifecycle.pendingTurnEndIndexes.size === 0 &&
        lifecycle.pendingAgentEndGoalIds.size === 0
      ) {
        lifecycle = { kind: "idle" };
      }
      return skipPlan({ type: "refreshUi" });
    },

    planAgentEnd(messages): StaleQueuedWorkPlan {
      if (lifecycle.kind === "abortingTurn") {
        return skipPlan(...finishAbortingLifecycle());
      }

      if (!messages.some(isAbortedAssistantMessage)) {
        return emptyPlan();
      }

      if (lifecycle.kind !== "awaitingTerminalCleanup") {
        return emptyPlan();
      }

      const staleGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(
        messages,
        lifecycle.pendingAgentEndGoalIds,
      );
      if (staleGoalIds.length === 0) {
        return emptyPlan();
      }

      for (const goalId of staleGoalIds) {
        lifecycle.pendingAgentEndGoalIds.delete(goalId);
      }
      if (
        lifecycle.pendingTurnEndIndexes.size === 0 &&
        lifecycle.pendingAgentEndGoalIds.size === 0
      ) {
        lifecycle = { kind: "idle" };
      }
      return skipPlan({ type: "refreshUi" });
    },

    planSessionShutdown(): StaleQueuedWorkPlan {
      clearTurnObservation();
      return { skip: false, effects: clearAllStaleState() };
    },
  };
}
