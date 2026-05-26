import { isAbortedAssistantMessage, type AssistantTurnMessage } from "./goal-accounting.js";
import { pendingStaleQueuedGoalWorkIdsFromMessages } from "./queued-goal-work.js";

export type StaleQueuedWorkEffect =
  | { type: "clearAccounting" }
  | { type: "refreshUi" }
  | { type: "abort" };

type TrackingLifecycleState = {
  kind: "tracking";
  abortingTurn: boolean;
  turnIndex: number | null;
  turnEndSkipIndexes: Set<number>;
  agentEndGoalIds: Set<string>;
};

type StaleQueuedWorkLifecycleState = { kind: "idle" } | TrackingLifecycleState;

interface TurnObservation {
  staleGoalIds: Set<string>;
  hasRunnableWork: boolean;
}

export interface StaleQueuedWorkGuard {
  isBlockingContinuation(): boolean;
  resetTurnObservation(): void;
  noteRunnableWorkStarted(): void;
  noteStaleWorkStarted(goalId: string): void;
  planContextAbort(currentTurnIndex: number | null): StaleQueuedWorkEffect[] | null;
  clearAbortingTurn(): { cleared: boolean; effects: StaleQueuedWorkEffect[] };
  clearAllStaleState(): StaleQueuedWorkEffect[];
  planTurnStart(): StaleQueuedWorkEffect[];
  planToolExecutionEnd(): { skip: boolean; effects: StaleQueuedWorkEffect[] };
  planSessionBeforeCompact(): { skip: boolean; effects: StaleQueuedWorkEffect[] };
  planSessionCompact(): { skip: boolean; effects: StaleQueuedWorkEffect[] };
  planTurnEnd(
    turnIndex: number | null,
    message: AssistantTurnMessage,
  ): { skip: boolean; effects: StaleQueuedWorkEffect[] };
  planAgentEnd(
    messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
  ): { skip: boolean; effects: StaleQueuedWorkEffect[] };
  planSessionShutdown(): StaleQueuedWorkEffect[];
}

function noteTerminalEvents(
  lifecycle: TrackingLifecycleState,
  currentTurnIndex: number | null,
  staleGoalIds: ReadonlySet<string>,
): void {
  if (currentTurnIndex !== null) {
    lifecycle.turnIndex = currentTurnIndex;
    lifecycle.turnEndSkipIndexes.add(currentTurnIndex);
  }
  for (const goalId of staleGoalIds) {
    lifecycle.agentEndGoalIds.add(goalId);
  }
}

export function createStaleQueuedWorkGuard(): StaleQueuedWorkGuard {
  let lifecycle: StaleQueuedWorkLifecycleState = { kind: "idle" };
  let turnObservation: TurnObservation = {
    staleGoalIds: new Set(),
    hasRunnableWork: false,
  };

  const getTracking = (): TrackingLifecycleState | null =>
    lifecycle.kind === "tracking" ? lifecycle : null;

  const ensureTracking = (): TrackingLifecycleState => {
    const existing = getTracking();
    if (existing) {
      return existing;
    }
    const created: TrackingLifecycleState = {
      kind: "tracking",
      abortingTurn: false,
      turnIndex: null,
      turnEndSkipIndexes: new Set(),
      agentEndGoalIds: new Set(),
    };
    lifecycle = created;
    return created;
  };

  const clearTerminalEvents = (tracking: TrackingLifecycleState): void => {
    tracking.turnEndSkipIndexes.clear();
    tracking.agentEndGoalIds.clear();
    tracking.turnIndex = null;
  };

  const finishAbortingLifecycle = (): StaleQueuedWorkEffect[] => {
    const tracking = getTracking();
    if (!tracking?.abortingTurn) {
      return [];
    }
    tracking.abortingTurn = false;
    tracking.turnIndex = null;
    clearTerminalEvents(tracking);
    lifecycle = { kind: "idle" };
    return [{ type: "clearAccounting" }, { type: "refreshUi" }];
  };

  return {
    isBlockingContinuation(): boolean {
      return getTracking()?.abortingTurn === true;
    },

    resetTurnObservation(): void {
      turnObservation = {
        staleGoalIds: new Set(),
        hasRunnableWork: false,
      };
    },

    noteRunnableWorkStarted(): void {
      turnObservation.hasRunnableWork = true;
    },

    noteStaleWorkStarted(goalId: string): void {
      turnObservation.staleGoalIds.add(goalId);
    },

    planContextAbort(currentTurnIndex: number | null): StaleQueuedWorkEffect[] | null {
      if (turnObservation.staleGoalIds.size === 0 || turnObservation.hasRunnableWork) {
        return null;
      }

      const tracking = ensureTracking();
      if (!tracking.abortingTurn) {
        noteTerminalEvents(tracking, currentTurnIndex, turnObservation.staleGoalIds);
      }
      tracking.abortingTurn = true;
      return [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }];
    },

    clearAbortingTurn(): { cleared: boolean; effects: StaleQueuedWorkEffect[] } {
      const tracking = getTracking();
      if (!tracking?.abortingTurn) {
        return { cleared: false, effects: [] };
      }
      tracking.abortingTurn = false;
      tracking.turnIndex = null;
      return { cleared: true, effects: [{ type: "clearAccounting" }] };
    },

    clearAllStaleState(): StaleQueuedWorkEffect[] {
      const effects: StaleQueuedWorkEffect[] = [];
      if (getTracking()?.abortingTurn) {
        effects.push({ type: "clearAccounting" });
      }
      lifecycle = { kind: "idle" };
      return effects;
    },

    planTurnStart(): StaleQueuedWorkEffect[] {
      this.resetTurnObservation();
      const { effects } = this.clearAbortingTurn();
      return [...effects, { type: "refreshUi" }];
    },

    planToolExecutionEnd(): { skip: boolean; effects: StaleQueuedWorkEffect[] } {
      if (!getTracking()?.abortingTurn) {
        return { skip: false, effects: [] };
      }
      return { skip: true, effects: [{ type: "clearAccounting" }, { type: "refreshUi" }] };
    },

    planSessionBeforeCompact(): { skip: boolean; effects: StaleQueuedWorkEffect[] } {
      return this.planToolExecutionEnd();
    },

    planSessionCompact(): { skip: boolean; effects: StaleQueuedWorkEffect[] } {
      return this.planToolExecutionEnd();
    },

    planTurnEnd(
      turnIndex: number | null,
      message: AssistantTurnMessage,
    ): { skip: boolean; effects: StaleQueuedWorkEffect[] } {
      const tracking = getTracking();
      if (!tracking) {
        return { skip: false, effects: [] };
      }
      const isActiveStaleTurn =
        tracking.abortingTurn && turnIndex !== null && tracking.turnIndex === turnIndex;
      const isPendingStaleTurnEnd =
        turnIndex !== null && isAbortedAssistantMessage(message) && tracking.turnEndSkipIndexes.has(turnIndex);

      if (!isActiveStaleTurn && !isPendingStaleTurnEnd) {
        return { skip: false, effects: [] };
      }

      if (turnIndex !== null) {
        tracking.turnEndSkipIndexes.delete(turnIndex);
      }

      const effects: StaleQueuedWorkEffect[] = [{ type: "refreshUi" }];
      if (isActiveStaleTurn) {
        effects.unshift({ type: "clearAccounting" });
      }
      return { skip: true, effects };
    },

    planAgentEnd(
      messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown; stopReason?: string }>,
    ): { skip: boolean; effects: StaleQueuedWorkEffect[] } {
      const activeTracking = getTracking();
      if (activeTracking?.abortingTurn) {
        return { skip: true, effects: finishAbortingLifecycle() };
      }

      if (!messages.some(isAbortedAssistantMessage)) {
        return { skip: false, effects: [] };
      }

      const tracking = getTracking();
      if (!tracking) {
        return { skip: false, effects: [] };
      }
      const staleGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, tracking.agentEndGoalIds);
      if (staleGoalIds.length === 0) {
        return { skip: false, effects: [] };
      }

      for (const goalId of staleGoalIds) {
        tracking.agentEndGoalIds.delete(goalId);
      }
      return { skip: true, effects: [{ type: "refreshUi" }] };
    },

    planSessionShutdown(): StaleQueuedWorkEffect[] {
      return this.clearAllStaleState();
    },
  };
}
