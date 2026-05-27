import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RUNTIME_PERSIST_INTERVAL_MS } from "./runtime-config.js";
import { clearEntry, cloneGoal, goalsEquivalent, setEntry } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";

interface GoalPersistenceDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
}

export function createGoalPersistence(deps: GoalPersistenceDeps) {
  let goal: ThreadGoal | null = null;
  let lastPersistedGoal: ThreadGoal | null = null;
  let lastRuntimePersistAt: number | null = null;

  const getGoal = (): ThreadGoal | null => goal;

  const setGoalSnapshot = (nextGoal: ThreadGoal | null): void => {
    goal = nextGoal;
  };

  const syncPersistedSnapshot = (snapshot: ThreadGoal | null): void => {
    lastPersistedGoal = snapshot ? cloneGoal(snapshot) : null;
    lastRuntimePersistAt = null;
  };

  const flushGoalPersistence = (source: GoalEntrySource): boolean => {
    if (!goal) {
      return false;
    }
    if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) {
      return false;
    }

    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(goal, source));
    lastPersistedGoal = cloneGoal(goal);
    lastRuntimePersistAt = Date.now();
    return true;
  };

  const maybeFlushRuntimePersistence = (source: GoalEntrySource): void => {
    if (!goal || goal.status !== "active") {
      return;
    }
    const now = Date.now();
    if (lastRuntimePersistAt !== null && now - lastRuntimePersistAt < RUNTIME_PERSIST_INTERVAL_MS) {
      return;
    }
    flushGoalPersistence(source);
  };

  const clearGoalSnapshot = (): void => {
    goal = null;
    lastPersistedGoal = null;
    lastRuntimePersistAt = null;
  };

  const appendClearEntry = (clearedGoalId: string | null, source: GoalEntrySource): void => {
    clearGoalSnapshot();
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };

  return {
    appendClearEntry,
    flushGoalPersistence,
    getGoal,
    maybeFlushRuntimePersistence,
    setGoalSnapshot,
    syncPersistedSnapshot,
  };
}

export type GoalPersistence = ReturnType<typeof createGoalPersistence>;
