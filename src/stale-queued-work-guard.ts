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
  | "abortingTurn"
  | "awaitingTerminalCleanup";

type StaleQueuedWorkLifecycleState =
  | { kind: "idle" }
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

interface TurnObservation {
  staleGoalIds: Set<string>;
  hasRunnableWork: boolean;
}

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

export function createStaleQueuedWorkGuard(): StaleQueuedWorkGuard {
  let lifecycle: StaleQueuedWorkLifecycleState = { kind: "idle" };
  let turnObservation: TurnObservation = {
    staleGoalIds: new Set(),
    hasRunnableWork: false,
  };

  const resetTurnObservation = (): void => {
    turnObservation = {
      staleGoalIds: new Set(),
      hasRunnableWork: false,
    };
  };

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

  return {
    lifecycleKind(): StaleQueuedWorkLifecycleKind {
      return lifecycleKindFromState(lifecycle);
    },

    isBlockingContinuation(): boolean {
      return lifecycle.kind === "abortingTurn";
    },

    noteRunnableWorkStarted(): void {
      turnObservation.hasRunnableWork = true;
    },

    noteStaleWorkStarted(goalId: string): void {
      turnObservation.staleGoalIds.add(goalId);
    },

    planContextAbort(currentTurnIndex: number | null): StaleQueuedWorkPlan | null {
      if (turnObservation.staleGoalIds.size === 0 || turnObservation.hasRunnableWork) {
        return null;
      }

      if (lifecycle.kind === "abortingTurn") {
        return {
          skip: false,
          effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }],
        };
      }

      const pendingTurnEndIndexes = new Set<number>();
      const pendingAgentEndGoalIds = new Set<string>();
      if (lifecycle.kind === "awaitingTerminalCleanup") {
        for (const turnIndex of lifecycle.pendingTurnEndIndexes) {
          pendingTurnEndIndexes.add(turnIndex);
        }
        for (const goalId of lifecycle.pendingAgentEndGoalIds) {
          pendingAgentEndGoalIds.add(goalId);
        }
      }
      noteTerminalEvents(
        pendingTurnEndIndexes,
        pendingAgentEndGoalIds,
        currentTurnIndex,
        turnObservation.staleGoalIds,
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
      resetTurnObservation();
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
      resetTurnObservation();
      return { skip: false, effects: clearAllStaleState() };
    },
  };
}
