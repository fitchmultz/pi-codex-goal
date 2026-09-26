import {
  createInitialStaleQueuedWorkState,
  lifecycleKindFromState,
  reduceStaleQueuedWork,
  type AgentEndMessage,
  type StaleQueuedWorkEffect,
  type StaleQueuedWorkEvent,
  type StaleQueuedWorkLifecycleKind,
  type StaleQueuedWorkPlan,
  type StaleQueuedWorkState,
} from "./stale-queued-work-reducer.ts";

export type {
  AgentEndMessage,
  StaleQueuedWorkEffect,
  StaleQueuedWorkLifecycleKind,
  StaleQueuedWorkPlan,
} from "./stale-queued-work-reducer.ts";

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
  planTurnEnd(turnIndex: number | null): StaleQueuedWorkPlan;
  planAgentEnd(messages: AgentEndMessage[]): StaleQueuedWorkPlan;
  planSessionShutdown(): StaleQueuedWorkPlan;
}

function emptyPlan(): StaleQueuedWorkPlan {
  return { skip: false, effects: [] };
}

export function createStaleQueuedWorkGuard(): StaleQueuedWorkGuard {
  let state: StaleQueuedWorkState = createInitialStaleQueuedWorkState();

  const dispatch = (event: StaleQueuedWorkEvent): StaleQueuedWorkPlan | null => {
    const result = reduceStaleQueuedWork(state, event);
    state = result.state;
    return result.plan;
  };

  const plan = (event: StaleQueuedWorkEvent): StaleQueuedWorkPlan => dispatch(event) ?? emptyPlan();

  return {
    lifecycleKind(): StaleQueuedWorkLifecycleKind {
      return lifecycleKindFromState(state);
    },

    isBlockingContinuation(): boolean {
      return state.kind === "abortingTurn";
    },

    noteRunnableWorkStarted(): void {
      dispatch({ type: "runnableWorkStarted" });
    },

    noteStaleWorkStarted(goalId: string): void {
      dispatch({ type: "staleWorkStarted", goalId });
    },

    planContextAbort(currentTurnIndex: number | null): StaleQueuedWorkPlan | null {
      return dispatch({ type: "contextAbort", currentTurnIndex });
    },

    planUserInputClearAbort(): StaleQueuedWorkPlan {
      return plan({ type: "userInputClearAbort" });
    },

    planExtensionContinuationClearAbort(): StaleQueuedWorkPlan {
      return plan({ type: "extensionContinuationClearAbort" });
    },

    planBeforeAgentStartClearAbort(): StaleQueuedWorkPlan {
      return plan({ type: "beforeAgentStartClearAbort" });
    },

    planTurnStart(): StaleQueuedWorkPlan {
      return plan({ type: "turnStart" });
    },

    planToolExecutionEnd(): StaleQueuedWorkPlan {
      return plan({ type: "toolExecutionEnd" });
    },

    planSessionBeforeCompact(): StaleQueuedWorkPlan {
      return plan({ type: "sessionBeforeCompact" });
    },

    planSessionCompact(): StaleQueuedWorkPlan {
      return plan({ type: "sessionCompact" });
    },

    planTurnEnd(turnIndex: number | null): StaleQueuedWorkPlan {
      return plan({ type: "turnEnd", turnIndex });
    },

    planAgentEnd(messages: AgentEndMessage[]): StaleQueuedWorkPlan {
      return plan({ type: "agentEnd", messages });
    },

    planSessionShutdown(): StaleQueuedWorkPlan {
      return plan({ type: "sessionShutdown" });
    },
  };
}
