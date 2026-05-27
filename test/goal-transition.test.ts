import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGoalMemoryEffects,
  applyGoalTransitionPostPersistEffects,
  planGoalTransition,
  planMemoryEffectsOnGoalChange,
} from "../src/goal-transition.js";
import { cloneGoal, createThreadGoal } from "../src/state.js";

test("planMemoryEffectsOnGoalChange clears stopped runtime when goal id changes", () => {
  const previous = createThreadGoal("first");
  const next = createThreadGoal("second");

  const plan = planMemoryEffectsOnGoalChange(previous, next);
  assert.equal(plan.resetStoppedRuntime, true);
  assert.equal(plan.clearBudgetWarning, true);
});

test("planMemoryEffectsOnGoalChange pauses clear continuation and accounting without full reset", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };

  const plan = planMemoryEffectsOnGoalChange(goal, paused);
  assert.equal(plan.resetStoppedRuntime, false);
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

  assert.ok(plan);
  assert.equal(plan.persist, "skip");
  assert.equal(plan.markContinuationQueued, true);
  assert.equal(plan.resetRecoveryAfterPersist, true);
  assert.equal(plan.resetRecoveryBeforePersist, false);
});

test("planGoalTransition abort pause resets stopped runtime before paused memory effects", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };

  const plan = planGoalTransition(goal, { kind: "abort_pause", nextGoal: paused });
  assert.ok(plan);
  assert.equal(plan.memory.resetStoppedRuntime, true);
  assert.equal(plan.persist, "set");
});

test("planGoalTransition clear stops status refresh and persists clear", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, { kind: "clear", source: "command" });

  assert.ok(plan);
  assert.equal(plan.persist, "clear");
  assert.equal(plan.stopStatusRefresh, true);
  assert.equal(plan.nextGoal, null);
});

test("applyGoalMemoryEffects invokes every handler when all flags are true", () => {
  const calls: string[] = [];
  applyGoalMemoryEffects(
    {
      resetStoppedRuntime: true,
      clearContinuation: true,
      clearActiveAccounting: true,
      resetRecovery: true,
      clearBudgetWarning: true,
    },
    {
      resetStoppedRuntime: () => {
        calls.push("resetStoppedRuntime");
      },
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
    "resetStoppedRuntime",
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
  assert.ok(plan);
  assert.equal(plan.persist, "skip");

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

test("planGoalTransition abort pause clears stopped runtime before persist when persistence skips", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(paused, { kind: "abort_pause", nextGoal: paused });

  assert.ok(plan);
  assert.equal(plan.persist, "skip");
  assert.equal(plan.resetStoppedRuntimeBeforePersist, true);
});
