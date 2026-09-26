import {
  appendGoalTransitionEffectOnce,
  mergeGoalTransitionEffects,
  type GoalTransitionEffect,
} from "./goal-transition-effects.ts";
import { cloneGoal, goalsEquivalent, statusAfterBudgetLimit, unixSeconds } from "./state.ts";
import type { GoalEntrySource, GoalStatus, ThreadGoal } from "./types.ts";

export {
  applyGoalTransitionEffects,
  type GoalTransitionEffect,
  type GoalTransitionEffectHandlers,
} from "./goal-transition-effects.ts";

export type GoalTransitionRequest =
  | {
      kind: "set";
      nextGoal: ThreadGoal;
      source: GoalEntrySource;
    }
  | { kind: "clear"; source: GoalEntrySource }
  | { kind: "abort_pause" }
  | { kind: "resume_active" }
  | {
      kind: "recovery_pause";
      recoveryReason: string;
    }
  | {
      kind: "recovery_shutdown_pause";
      recoveryReason: string;
    }
  | {
      kind: "runtime_accounting";
      nextGoal: ThreadGoal;
    };

type GoalTransitionPlanBase = {
  source: GoalEntrySource;
  beforePersist: GoalTransitionEffect[];
  afterPersist: GoalTransitionEffect[];
};

export type GoalTransitionPlan =
  | (GoalTransitionPlanBase & {
      persist: "skip" | "defer" | "set";
      nextGoal: ThreadGoal;
    })
  | (GoalTransitionPlanBase & {
      persist: "clear";
      nextGoal: null;
    });

export function reloadGoalRuntimeEffects(
  previousGoalId: string | null,
  reconstructed: ThreadGoal | null,
): GoalTransitionEffect[] {
  const effects: GoalTransitionEffect[] = [{ type: "clearContinuation" }];
  if (reconstructed?.status !== "active") {
    effects.push({ type: "clearActiveAccounting" });
  }
  if ((reconstructed?.goalId ?? null) !== previousGoalId) {
    effects.push({ type: "resetRecovery" });
  }
  return effects;
}

function memoryEffectsFromGoalChange(
  previous: ThreadGoal | null,
  next: ThreadGoal,
): GoalTransitionEffect[] {
  const effects: GoalTransitionEffect[] = [];
  const goalIdChanged = (previous?.goalId ?? null) !== next.goalId;

  if (goalIdChanged) {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
    appendGoalTransitionEffectOnce(effects, { type: "resetRecovery" });
    appendGoalTransitionEffectOnce(effects, { type: "clearBudgetWarning" });
  }
  if (next.status === "complete") {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
    appendGoalTransitionEffectOnce(effects, { type: "resetRecovery" });
  } else if (next.status === "paused") {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
  } else if (next.status === "budgetLimited") {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
    appendGoalTransitionEffectOnce(effects, { type: "resetRecovery" });
  }
  if (next.status !== "budgetLimited") {
    appendGoalTransitionEffectOnce(effects, { type: "clearBudgetWarning" });
  }
  return effects;
}

function crossedBudgetTransition(current: ThreadGoal | null, nextGoal: ThreadGoal): boolean {
  return current?.status !== "budgetLimited" && nextGoal.status === "budgetLimited";
}

function commandAfterPersistEffects(
  current: ThreadGoal | null,
  nextGoal: ThreadGoal,
  wasPausedBefore: boolean,
): GoalTransitionEffect[] {
  const goalIdChanged = (current?.goalId ?? null) !== nextGoal.goalId;
  const effects: GoalTransitionEffect[] = [];
  if (nextGoal.status === "active") {
    effects.push({ type: "markContinuationQueued", goalId: nextGoal.goalId });
  }
  if (nextGoal.status === "paused" && !goalIdChanged) {
    effects.push({ type: "resetRecovery" });
  } else if (nextGoal.status === "active" && wasPausedBefore && !goalIdChanged) {
    effects.push({ type: "resetRecovery" });
  }
  return effects;
}

const CLEAR_BEFORE_PERSIST: GoalTransitionEffect[] = [
  { type: "clearContinuation" },
  { type: "clearActiveAccounting" },
  { type: "resetRecovery" },
  { type: "clearBudgetWarning" },
];

const RUNTIME_ACCOUNTING_STATUSES = new Set<GoalStatus>(["active", "budgetLimited"]);

function transitionInvariantError(kind: string, detail: string): Error {
  return new Error(`Invalid ${kind} transition: ${detail}`);
}

function requireCurrentGoal(
  current: ThreadGoal | null,
  kind: string,
): asserts current is ThreadGoal {
  if (!current) {
    throw transitionInvariantError(kind, "current goal is required");
  }
}

function requireStatus(current: ThreadGoal, expected: GoalStatus, kind: string): void {
  if (current.status !== expected) {
    throw transitionInvariantError(kind, `current status must be ${expected} (got ${current.status})`);
  }
}

function deriveGoalWithStatus(current: ThreadGoal, status: GoalStatus): ThreadGoal {
  const next = cloneGoal(current);
  next.status = statusAfterBudgetLimit(status, next.usage.tokensUsed, next.tokenBudget);
  next.updatedAt = unixSeconds();
  return next;
}

function requireSameGoalId(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.goalId !== nextGoal.goalId) {
    throw transitionInvariantError(
      kind,
      `goalId mismatch (current=${current.goalId}, next=${nextGoal.goalId})`,
    );
  }
}

function requireUnchangedObjective(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.objective !== nextGoal.objective) {
    throw transitionInvariantError(kind, "objective must be unchanged");
  }
}

function requireUnchangedTokenBudget(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.tokenBudget !== nextGoal.tokenBudget) {
    throw transitionInvariantError(kind, "tokenBudget must be unchanged");
  }
}

function requireUnchangedCreatedAt(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (current.createdAt !== nextGoal.createdAt) {
    throw transitionInvariantError(kind, "createdAt must be unchanged");
  }
}

function requireRuntimeAccountingChange(
  current: ThreadGoal,
  nextGoal: ThreadGoal,
  kind: string,
): void {
  const usageIncreased =
    nextGoal.usage.tokensUsed > current.usage.tokensUsed ||
    nextGoal.usage.activeSeconds > current.usage.activeSeconds;
  const statusChanged = current.status !== nextGoal.status;
  if (!usageIncreased && !statusChanged) {
    throw transitionInvariantError(
      kind,
      "runtime accounting must increase usage or change status",
    );
  }
}

function requireNonDecreasingUsage(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (nextGoal.usage.tokensUsed < current.usage.tokensUsed) {
    throw transitionInvariantError(kind, "usage.tokensUsed must not decrease");
  }
  if (nextGoal.usage.activeSeconds < current.usage.activeSeconds) {
    throw transitionInvariantError(kind, "usage.activeSeconds must not decrease");
  }
}

function requireBudgetLimitedUsageAtOrOverBudget(nextGoal: ThreadGoal, kind: string): void {
  if (nextGoal.tokenBudget === null) {
    throw transitionInvariantError(
      kind,
      "tokenBudget must be set when next status is budgetLimited",
    );
  }
  if (nextGoal.usage.tokensUsed < nextGoal.tokenBudget) {
    throw transitionInvariantError(
      kind,
      "usage.tokensUsed must be at or above tokenBudget when next status is budgetLimited",
    );
  }
}

function requireNonRewindingUpdatedAt(current: ThreadGoal, nextGoal: ThreadGoal, kind: string): void {
  if (nextGoal.updatedAt < current.updatedAt) {
    throw transitionInvariantError(kind, "updatedAt must not decrease");
  }
}

function planDerivedActiveToPausedTransition(
  kind: "abort_pause" | "recovery_pause" | "recovery_shutdown_pause",
  current: ThreadGoal | null,
  extraBefore: readonly GoalTransitionEffect[],
): GoalTransitionPlan {
  requireCurrentGoal(current, kind);
  requireStatus(current, "active", kind);
  const nextGoal = deriveGoalWithStatus(current, "paused");

  return {
    persist: "set",
    nextGoal,
    source: "runtime",
    beforePersist: mergeGoalTransitionEffects([...extraBefore], memoryEffectsFromGoalChange(current, nextGoal)),
    afterPersist: [],
  };
}

function planDerivedResumeActiveTransition(
  current: ThreadGoal | null,
): GoalTransitionPlan {
  const kind = "resume_active";
  requireCurrentGoal(current, kind);
  requireStatus(current, "paused", kind);
  const nextGoal = deriveGoalWithStatus(current, "active");

  return {
    persist: "set",
    nextGoal,
    source: "runtime",
    beforePersist: mergeGoalTransitionEffects(
      [{ type: "clearContinuation" }, { type: "resetRecovery" }],
      memoryEffectsFromGoalChange(current, nextGoal),
    ),
    afterPersist: [],
  };
}

function validateRuntimeAccounting(current: ThreadGoal | null, nextGoal: ThreadGoal): void {
  const kind = "runtime_accounting";
  requireCurrentGoal(current, kind);
  requireSameGoalId(current, nextGoal, kind);
  if (!RUNTIME_ACCOUNTING_STATUSES.has(current.status)) {
    throw transitionInvariantError(
      kind,
      `current status must be active or budgetLimited (got ${current.status})`,
    );
  }
  if (!RUNTIME_ACCOUNTING_STATUSES.has(nextGoal.status)) {
    throw transitionInvariantError(
      kind,
      `next status must be active or budgetLimited (got ${nextGoal.status})`,
    );
  }
  if (current.status === "budgetLimited" && nextGoal.status === "active") {
    throw transitionInvariantError(
      kind,
      "budgetLimited goals cannot transition to active via runtime accounting",
    );
  }
  requireUnchangedObjective(current, nextGoal, kind);
  requireUnchangedTokenBudget(current, nextGoal, kind);
  requireUnchangedCreatedAt(current, nextGoal, kind);
  requireNonRewindingUpdatedAt(current, nextGoal, kind);
  requireNonDecreasingUsage(current, nextGoal, kind);
  requireRuntimeAccountingChange(current, nextGoal, kind);
  if (nextGoal.status === "budgetLimited") {
    requireBudgetLimitedUsageAtOrOverBudget(nextGoal, kind);
  }
}

export function planGoalTransition(
  current: ThreadGoal | null,
  request: GoalTransitionRequest,
): GoalTransitionPlan {
  switch (request.kind) {
    case "clear":
      return {
        persist: "clear",
        nextGoal: null,
        source: request.source,
        beforePersist: [...CLEAR_BEFORE_PERSIST],
        afterPersist: [{ type: "stopStatusRefresh" }],
      };

    case "abort_pause":
      return planDerivedActiveToPausedTransition(
        "abort_pause",
        current,
        [
          { type: "clearContinuation" },
          { type: "clearActiveAccounting" },
          { type: "resetRecovery" },
          { type: "clearBudgetWarning" },
        ],
      );

    case "resume_active":
      return planDerivedResumeActiveTransition(current);

    case "recovery_pause":
      return planDerivedActiveToPausedTransition(
        "recovery_pause",
        current,
        [
          { type: "clearContinuation" },
          { type: "setRecoveryPausedAttention", reason: request.recoveryReason },
        ],
      );

    case "recovery_shutdown_pause":
      return planDerivedActiveToPausedTransition(
        "recovery_shutdown_pause",
        current,
        [
          { type: "clearContinuation" },
          { type: "clearHostOverflowRecovery" },
          { type: "setRecoveryPausedAttention", reason: request.recoveryReason },
        ],
      );

    case "runtime_accounting": {
      const { nextGoal } = request;
      validateRuntimeAccounting(current, nextGoal);
      const beforePersist = memoryEffectsFromGoalChange(current, nextGoal);
      if (crossedBudgetTransition(current, nextGoal)) {
        return {
          persist: "set",
          nextGoal,
          source: "runtime",
          beforePersist,
          afterPersist: [],
        };
      }
      return {
        persist: "defer",
        nextGoal,
        source: "runtime",
        beforePersist,
        afterPersist: [],
      };
    }

    case "set": {
      const { nextGoal, source } = request;
      const wasPausedBefore = current?.status === "paused";
      const afterPersist =
        source === "command"
          ? commandAfterPersistEffects(current, nextGoal, wasPausedBefore)
          : [];
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source,
          beforePersist: [],
          afterPersist,
        };
      }
      return {
        persist: "set",
        nextGoal,
        source,
        beforePersist: memoryEffectsFromGoalChange(current, nextGoal),
        afterPersist,
      };
    }

    default: {
      const _exhaustive: never = request;
      throw new Error(`Unhandled goal transition request: ${String(_exhaustive)}`);
    }
  }
}
