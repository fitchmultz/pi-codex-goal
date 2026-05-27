import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGoalMemoryEffects,
  applyGoalTransitionPostPersistEffects,
  planGoalTransition,
  planMemoryEffectsOnGoalChange,
} from "../src/goal-transition.js";
import { cloneGoal, createThreadGoal } from "../src/state.js";

test("planMemoryEffectsOnGoalChange clears stopped runtime primitives when goal id changes", () => {
  const previous = createThreadGoal("first");
  const next = createThreadGoal("second");

  const plan = planMemoryEffectsOnGoalChange(previous, next);
  assert.equal(plan.clearContinuation, true);
  assert.equal(plan.clearActiveAccounting, true);
  assert.equal(plan.resetRecovery, true);
  assert.equal(plan.clearBudgetWarning, true);
});

test("planMemoryEffectsOnGoalChange pauses clear continuation and accounting without recovery reset", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };

  const plan = planMemoryEffectsOnGoalChange(goal, paused);
  assert.equal(plan.clearContinuation, true);
  assert.equal(plan.clearActiveAccounting, true);
  assert.equal(plan.resetRecovery, false);
});

test("planGoalTransition command set marks continuation and defers recovery reset until after persist", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, {
    kind: "set",
    nextGoal: goal,
    source: "command",
    wasPausedBefore: true,
  });

  assert.equal(plan.persist, "skip");
  assert.equal("memory" in plan, false);
  assert.equal(plan.markContinuationQueued, true);
  assert.equal(plan.resetRecoveryAfterPersist, true);
  assert.equal(plan.resetRecoveryBeforePersist, false);
});

test("planGoalTransition abort pause clears stopped runtime primitives before paused memory effects", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };

  const plan = planGoalTransition(goal, { kind: "abort_pause", nextGoal: paused });
  assert.equal(plan.persist, "set");
  assert.equal(plan.clearContinuationBeforePersist, true);
  assert.equal(plan.clearActiveAccountingBeforePersist, true);
  assert.equal(plan.resetRecoveryBeforePersist, true);
  assert.equal(plan.memory.clearContinuation, true);
  assert.equal(plan.memory.resetRecovery, true);
});

test("planGoalTransition clear persists clear with full memory reset", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, { kind: "clear", source: "command" });

  assert.equal(plan.persist, "clear");
  assert.equal(plan.nextGoal, null);
  assert.equal(plan.memory.clearContinuation, true);
  assert.equal(plan.memory.resetRecovery, true);
});

test("planGoalTransition recovery pause owns continuation clear and reason", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(goal, {
    kind: "recovery_pause",
    nextGoal: paused,
    recoveryReason: "context_length_exceeded",
  });

  assert.equal(plan.persist, "set");
  assert.equal(plan.clearContinuationBeforePersist, true);
  assert.equal(plan.recoveryPausedReason, "context_length_exceeded");
  assert.equal(plan.memory.clearContinuation, true);
});

test("planGoalTransition recovery shutdown pause clears host overflow recovery", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(goal, {
    kind: "recovery_shutdown_pause",
    nextGoal: paused,
    recoveryReason: "shutdown",
  });

  assert.equal(plan.persist, "set");
  assert.equal(plan.clearHostOverflowRecovery, true);
  assert.equal(plan.recoveryPausedReason, "shutdown");
});

test("applyGoalMemoryEffects invokes every handler when all flags are true", () => {
  const calls: string[] = [];
  applyGoalMemoryEffects(
    {
      clearContinuation: true,
      clearActiveAccounting: true,
      resetRecovery: true,
      clearBudgetWarning: true,
    },
    {
      clearContinuation: () => {
        calls.push("clearContinuation");
      },
      clearActiveAccounting: () => {
        calls.push("clearActiveAccounting");
      },
      resetRecovery: () => {
        calls.push("resetRecovery");
      },
      clearBudgetWarning: () => {
        calls.push("clearBudgetWarning");
      },
    },
  );

  assert.deepEqual(calls, [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
});

test("applyGoalTransitionPostPersistEffects applies skip-plan command side effects", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, {
    kind: "set",
    nextGoal: goal,
    source: "command",
    wasPausedBefore: true,
  });
  assert.equal(plan.persist, "skip");
  assert.equal("memory" in plan, false);

  const calls: string[] = [];
  applyGoalTransitionPostPersistEffects(plan, {
    resetRecoveryAfterPersist: () => {
      calls.push("resetRecoveryAfterPersist");
    },
    markContinuationQueued: (goalId) => {
      calls.push(`markContinuationQueued:${goalId}`);
    },
  });

  assert.deepEqual(calls, [
    "resetRecoveryAfterPersist",
    `markContinuationQueued:${goal.goalId}`,
  ]);
});

test("planGoalTransition abort pause clears stopped runtime primitives before persist when persistence skips", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(paused, { kind: "abort_pause", nextGoal: paused });

  assert.equal(plan.persist, "skip");
  assert.equal("memory" in plan, false);
  assert.equal(plan.clearContinuationBeforePersist, true);
  assert.equal(plan.clearActiveAccountingBeforePersist, true);
  assert.equal(plan.resetRecoveryBeforePersist, true);
});

test("planGoalTransition runtime accounting defers persistence for ordinary usage updates", () => {
  const goal = createThreadGoal("ship it");
  const next = {
    ...cloneGoal(goal),
    usage: { tokensUsed: 5, activeSeconds: 3 },
    updatedAt: goal.updatedAt + 1,
  };

  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: next,
    crossedBudget: false,
  });

  assert.equal(plan.persist, "defer");
  assert.equal(plan.memory.clearBudgetWarning, true);
});

test("planGoalTransition runtime accounting persists immediately when budget is crossed", () => {
  const goal = createThreadGoal("ship it", 10);
  const limited = {
    ...cloneGoal(goal),
    status: "budgetLimited" as const,
    usage: { tokensUsed: 10, activeSeconds: 1 },
    updatedAt: goal.updatedAt + 1,
  };

  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: limited,
    crossedBudget: true,
  });

  assert.equal(plan.persist, "set");
  assert.equal(plan.memory.clearContinuation, true);
  assert.equal(plan.memory.resetRecovery, true);
});

test("planGoalTransition skip plans cannot carry memory", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: goal,
    crossedBudget: false,
  });

  assert.equal(plan.persist, "skip");
  assert.equal("memory" in plan, false);
});
