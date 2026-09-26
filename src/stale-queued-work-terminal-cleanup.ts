import { markAllObligationsOlder } from "./stale-queued-work-obligations.ts";
import type {
  ObservingTurnState,
  StaleQueuedWorkState,
  TerminalCleanup,
} from "./stale-queued-work-types.ts";

export function terminalCleanupHasPending(cleanup: TerminalCleanup): boolean {
  return cleanup.pendingTurnEndIndexes.size > 0 || cleanup.pendingAgentEndObligations.length > 0;
}

export function cloneTerminalCleanup(cleanup: TerminalCleanup): TerminalCleanup {
  return {
    pendingTurnEndIndexes: new Set(cleanup.pendingTurnEndIndexes),
    pendingAgentEndObligations: cleanup.pendingAgentEndObligations.map((obligation) => ({
      goalIds: new Set(obligation.goalIds),
      acceptsAnonymous: obligation.acceptsAnonymous,
      phase: obligation.phase,
    })),
  };
}

export function noteTerminalEvents(
  pendingTurnEndIndexes: Set<number>,
  currentTurnIndex: number | null,
): void {
  if (currentTurnIndex !== null) {
    pendingTurnEndIndexes.add(currentTurnIndex);
  }
}

export function resolveLifecycleAfterTerminalCleanup(
  cleanup: TerminalCleanup,
  observing: ObservingTurnState | null,
): StaleQueuedWorkState {
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
      terminalCleanup: cleanup,
    };
  }
  return { kind: "idle" };
}

export function awaitingFromCleanup(cleanup: TerminalCleanup): StaleQueuedWorkState {
  markAllObligationsOlder(cleanup);
  if (!terminalCleanupHasPending(cleanup)) {
    return { kind: "idle" };
  }
  return {
    kind: "awaitingTerminalCleanup",
    terminalCleanup: cleanup,
  };
}

export function consumePendingStaleTurnEnd(
  cleanup: TerminalCleanup,
  turnIndex: number | null,
): boolean {
  if (turnIndex === null || !cleanup.pendingTurnEndIndexes.has(turnIndex)) {
    return false;
  }
  cleanup.pendingTurnEndIndexes.delete(turnIndex);
  return true;
}
