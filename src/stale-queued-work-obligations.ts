import {
  agentEndMessagesIncludeQueuedGoalWork,
  pendingStaleQueuedGoalWorkIdsFromMessages,
} from "./queued-goal-work.ts";
import type {
  AbortingTurnState,
  AgentEndMessage,
  AgentEndObligation,
  TerminalCleanup,
  TerminalObligationPhase,
} from "./stale-queued-work-types.ts";

export function obligationsForStaleAbort(
  staleGoalIds: ReadonlySet<string>,
  phase: TerminalObligationPhase,
): AgentEndObligation[] {
  if (staleGoalIds.size === 0) {
    return [];
  }
  return [{ goalIds: new Set(staleGoalIds), acceptsAnonymous: true, phase }];
}

export function setAnonymousMatching(
  obligations: AgentEndObligation[],
  acceptsAnonymous: boolean,
): void {
  for (const obligation of obligations) {
    obligation.acceptsAnonymous = acceptsAnonymous;
  }
}

export function markAllObligationsOlder(cleanup: TerminalCleanup): void {
  for (const obligation of cleanup.pendingAgentEndObligations) {
    obligation.phase = "older";
  }
}

export function dropActiveObligations(cleanup: TerminalCleanup): void {
  cleanup.pendingAgentEndObligations = cleanup.pendingAgentEndObligations.filter(
    (obligation) => obligation.phase !== "active",
  );
}

export function consumePendingStaleAgentEnd(
  cleanup: TerminalCleanup,
  messages: AgentEndMessage[],
): boolean {
  const pendingGoalIds = pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations);
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, pendingGoalIds);
  const goalMatch = consumeGoalBearingTerminal(
    cleanup.pendingAgentEndObligations,
    matchedGoalIds,
    ["older", "active"],
  );
  if (goalMatch.consumed) {
    return true;
  }
  if (!matchesAnonymousStaleAgentEnd(messages)) {
    return false;
  }
  return consumeAnonymousTerminal(
    cleanup.pendingAgentEndObligations,
    ["older", "active"],
  ).consumed;
}

export type AbortingAgentEndConsumption = {
  consumedActive: boolean;
  consumedOlder: boolean;
  activePending: boolean;
};

export function consumeAbortingAgentEnd(
  aborting: AbortingTurnState,
  messages: AgentEndMessage[],
): AbortingAgentEndConsumption {
  const { terminalCleanup } = aborting;
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(
    messages,
    allPendingGoalIds(terminalCleanup),
  );
  const preferActiveFirst =
    activeTurnEndConsumed(aborting) &&
    matchedGoalIds.length > 0 &&
    isSubsetOfSet(matchedGoalIds, pendingGoalIdsByPhase(terminalCleanup, "active"));

  const goalMatch = consumeGoalBearingTerminal(
    terminalCleanup.pendingAgentEndObligations,
    matchedGoalIds,
    preferActiveFirst ? ["active", "older"] : ["older", "active"],
  );

  let consumedActive = goalMatch.consumedActive;
  let consumedOlder = goalMatch.consumedOlder;
  if (matchesAnonymousStaleAgentEnd(messages)) {
    const preferActiveAnonymous =
      activeTurnEndConsumed(aborting) &&
      terminalCleanup.pendingAgentEndObligations.some(
        (obligation) => obligation.phase === "active" && obligation.acceptsAnonymous,
      );
    const anonymousMatch = consumeAnonymousTerminal(
      terminalCleanup.pendingAgentEndObligations,
      preferActiveAnonymous ? ["active", "older"] : ["older", "active"],
      { consumeFallbackPhase: true },
    );
    consumedActive ||= anonymousMatch.consumedActive;
    consumedOlder ||= anonymousMatch.consumedOlder;
  }

  return {
    consumedActive,
    consumedOlder,
    activePending: terminalCleanup.pendingAgentEndObligations.some(
      (obligation) => obligation.phase === "active",
    ),
  };
}

function isStaleTerminalAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "aborted" ||
      message.stopReason === "stop" ||
      message.stopReason === "error")
  );
}

function matchesAnonymousStaleAgentEnd(messages: AgentEndMessage[]): boolean {
  if (agentEndMessagesIncludeQueuedGoalWork(messages)) {
    return false;
  }
  return messages.some(isStaleTerminalAssistantMessage);
}

function activeTurnEndConsumed(aborting: AbortingTurnState): boolean {
  const { activeTurnIndex, terminalCleanup } = aborting;
  return activeTurnIndex !== null && !terminalCleanup.pendingTurnEndIndexes.has(activeTurnIndex);
}

function allPendingGoalIds(cleanup: TerminalCleanup): Set<string> {
  return pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations);
}

function pendingGoalIdsByPhase(
  cleanup: TerminalCleanup,
  phase: TerminalObligationPhase,
): Set<string> {
  return pendingGoalIdsFromObligations(
    cleanup.pendingAgentEndObligations.filter((obligation) => obligation.phase === phase),
  );
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

function isSubsetOfSet(values: readonly string[], superset: ReadonlySet<string>): boolean {
  for (const value of values) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
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

type ConsumptionResult = {
  consumed: boolean;
  consumedOlder: boolean;
  consumedActive: boolean;
};

function emptyConsumptionResult(): ConsumptionResult {
  return { consumed: false, consumedOlder: false, consumedActive: false };
}

function recordConsumedObligation(result: ConsumptionResult, obligation: AgentEndObligation): void {
  result.consumed = true;
  result.consumedOlder ||= obligation.phase === "older";
  result.consumedActive ||= obligation.phase === "active";
}

function consumeObligationAt(
  obligations: AgentEndObligation[],
  index: number,
): AgentEndObligation | null {
  const [obligation] = obligations.splice(index, 1);
  return obligation ?? null;
}

function consumeGoalBearingTerminal(
  obligations: AgentEndObligation[],
  matchedGoalIds: readonly string[],
  phaseOrder: readonly TerminalObligationPhase[],
): ConsumptionResult {
  const result = emptyConsumptionResult();
  const remainingGoalIds = new Set(matchedGoalIds);

  for (const phase of phaseOrder) {
    for (let index = 0; index < obligations.length; ) {
      const obligation = obligations[index]!;
      if (
        obligation.phase !== phase ||
        remainingGoalIds.size === 0 ||
        !obligationMatchesAnyGoal(obligation, remainingGoalIds)
      ) {
        index += 1;
        continue;
      }

      const consumed = consumeObligationAt(obligations, index);
      if (consumed) {
        recordConsumedObligation(result, consumed);
        for (const goalId of consumed.goalIds) {
          remainingGoalIds.delete(goalId);
        }
      }
      if (remainingGoalIds.size === 0) {
        return result;
      }
    }
  }

  return result;
}

function consumeAnonymousTerminal(
  obligations: AgentEndObligation[],
  phaseOrder: readonly TerminalObligationPhase[],
  options: { consumeFallbackPhase?: boolean } = {},
): ConsumptionResult {
  const result = emptyConsumptionResult();
  const fallbackPhase = options.consumeFallbackPhase ? phaseOrder.at(-1) : undefined;

  for (const phase of phaseOrder) {
    for (let index = 0; index < obligations.length; index += 1) {
      const obligation = obligations[index]!;
      const matchesAnonymous = obligation.acceptsAnonymous || phase === fallbackPhase;
      if (obligation.phase !== phase || !matchesAnonymous) {
        continue;
      }

      const consumed = consumeObligationAt(obligations, index);
      if (consumed) {
        recordConsumedObligation(result, consumed);
      }
      return result;
    }
  }

  return result;
}
