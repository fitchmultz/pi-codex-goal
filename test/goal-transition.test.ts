import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGoalTransitionEffects,
  planGoalTransition,
  type GoalTransitionEffect,
  type GoalTransitionPlan,
} from "../src/goal-transition.js";
import type { ThreadGoal } from "../src/types.js";
import { cloneGoal, createThreadGoal } from "../src/state.js";

function effectTypes(effects: readonly GoalTransitionEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

function assertNoDuplicateEffectTypes(
  effects: readonly GoalTransitionEffect[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const effect of effects) {
    assert.equal(
      seen.has(effect.type),
      false,
      `${label}: duplicate effect type ${effect.type}`,
    );
    seen.add(effect.type);
  }
}

function assertDisjointPrimitivePlan(plan: GoalTransitionPlan, label: string): void {
  assertNoDuplicateEffectTypes(plan.beforePersist, `${label} beforePersist`);
  assertNoDuplicateEffectTypes(plan.afterPersist, `${label} afterPersist`);
  const combined = [...plan.beforePersist, ...plan.afterPersist];
  assertNoDuplicateEffectTypes(combined, `${label} combined`);
}

type CommandSetTableCase = {
  label: string;
  build: () => { current: ThreadGoal; next: ThreadGoal };
  persist: GoalTransitionPlan["persist"];
  before: string[];
  after: string[];
};

const commandSetTable: CommandSetTableCase[] = [
  {
    label: "active skip unchanged",
    build: () => {
      const goal = createThreadGoal("ship it");
      return { current: goal, next: goal };
    },
    persist: "skip",
    before: [],
    after: ["markContinuationQueued"],
  },
  {
    label: "paused skip unchanged",
    build: () => {
      const goal = createThreadGoal("ship it");
      const paused = { ...cloneGoal(goal), status: "paused" as const };
      return { current: paused, next: paused };
    },
    persist: "skip",
    before: [],
    after: ["resetRecovery"],
  },
  {
    label: "active to same paused",
    build: () => {
      const goal = createThreadGoal("ship it");
      const paused = { ...cloneGoal(goal), status: "paused" as const };
      return { current: goal, next: paused };
    },
    persist: "set",
    before: ["clearContinuation", "clearActiveAccounting", "clearBudgetWarning"],
    after: ["resetRecovery"],
  },
  {
    label: "active to different paused",
    build: () => {
      const current = createThreadGoal("old objective");
      const next = { ...createThreadGoal("new objective"), status: "paused" as const };
      return { current, next };
    },
    persist: "set",
    before: [
      "clearContinuation",
      "clearActiveAccounting",
      "resetRecovery",
      "clearBudgetWarning",
    ],
    after: [],
  },
  {
    label: "paused to same active",
    build: () => {
      const goal = createThreadGoal("ship it");
      const paused = { ...cloneGoal(goal), status: "paused" as const };
      const active = { ...cloneGoal(goal), status: "active" as const };
      return { current: paused, next: active };
    },
    persist: "set",
    before: ["clearBudgetWarning"],
    after: ["markContinuationQueued", "resetRecovery"],
  },
  {
    label: "paused to different active",
    build: () => {
      const paused = { ...createThreadGoal("old objective"), status: "paused" as const };
      const next = createThreadGoal("new objective");
      return { current: paused, next };
    },
    persist: "set",
    before: [
      "clearContinuation",
      "clearActiveAccounting",
      "resetRecovery",
      "clearBudgetWarning",
    ],
    after: ["markContinuationQueued"],
  },
  {
    label: "active to different active",
    build: () => {
      const current = createThreadGoal("old objective");
      const next = createThreadGoal("new objective");
      return { current, next };
    },
    persist: "set",
    before: [
      "clearContinuation",
      "clearActiveAccounting",
      "resetRecovery",
      "clearBudgetWarning",
    ],
    after: ["markContinuationQueued"],
  },
  {
    label: "paused to different paused",
    build: () => {
      const current = { ...createThreadGoal("old objective"), status: "paused" as const };
      const next = { ...createThreadGoal("new objective"), status: "paused" as const };
      return { current, next };
    },
    persist: "set",
    before: [
      "clearContinuation",
      "clearActiveAccounting",
      "resetRecovery",
      "clearBudgetWarning",
    ],
    after: [],
  },
];

for (const tableCase of commandSetTable) {
  test(`planGoalTransition command set table: ${tableCase.label}`, () => {
    const { current, next } = tableCase.build();
    const plan = planGoalTransition(current, {
      kind: "set",
      nextGoal: next,
      source: "command",
    });

    assertDisjointPrimitivePlan(plan, tableCase.label);
    assert.equal(plan.persist, tableCase.persist);
    assert.deepEqual(effectTypes(plan.beforePersist), tableCase.before);
    assert.deepEqual(effectTypes(plan.afterPersist), tableCase.after);
  });
}

test("planGoalTransition command set with goal id change clears runtime memory before persist", () => {
  const previous = createThreadGoal("first");
  const next = createThreadGoal("second");

  const plan = planGoalTransition(previous, {
    kind: "set",
    nextGoal: next,
    source: "command",
  });

  assertDisjointPrimitivePlan(plan, "command goal id change");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["markContinuationQueued"]);
});

test("planGoalTransition command set replacing paused goal resets recovery only before persist", () => {
  const paused = createThreadGoal("old objective");
  const pausedCurrent = { ...cloneGoal(paused), status: "paused" as const };
  const nextActive = createThreadGoal("new objective");

  const plan = planGoalTransition(pausedCurrent, {
    kind: "set",
    nextGoal: nextActive,
    source: "command",
  });

  assertDisjointPrimitivePlan(plan, "command paused replacement");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["markContinuationQueued"]);
});

test("planGoalTransition command pause schedules reset recovery after persist", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };

  const plan = planGoalTransition(goal, {
    kind: "set",
    nextGoal: paused,
    source: "command",
  });

  assertDisjointPrimitivePlan(plan, "command pause");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "clearBudgetWarning",
  ]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["resetRecovery"]);
});

test("planGoalTransition command resume schedules reset and continuation after persist", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const active = { ...cloneGoal(goal), status: "active" as const };

  const plan = planGoalTransition(paused, {
    kind: "set",
    nextGoal: active,
    source: "command",
  });

  assertDisjointPrimitivePlan(plan, "command resume");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), ["clearBudgetWarning"]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["markContinuationQueued", "resetRecovery"]);
});

test("planGoalTransition command set skip marks continuation for unchanged active goal", () => {
  const goal = createThreadGoal("ship it");

  const plan = planGoalTransition(goal, {
    kind: "set",
    nextGoal: goal,
    source: "command",
  });

  assertDisjointPrimitivePlan(plan, "command active skip");
  assert.equal(plan.persist, "skip");
  assert.deepEqual(plan.beforePersist, []);
  assert.deepEqual(effectTypes(plan.afterPersist), ["markContinuationQueued"]);
});

test("planGoalTransition abort pause uses disjoint primitive schedule", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };

  const plan = planGoalTransition(goal, { kind: "abort_pause", nextGoal: paused });
  assertDisjointPrimitivePlan(plan, "abort pause set");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
  assert.deepEqual(plan.afterPersist, []);
});

test("planGoalTransition clear persists clear with full memory reset", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, { kind: "clear", source: "command" });

  assertDisjointPrimitivePlan(plan, "clear");
  assert.equal(plan.persist, "clear");
  assert.equal(plan.nextGoal, null);
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
  assert.deepEqual(effectTypes(plan.afterPersist), ["stopStatusRefresh"]);
});

test("planGoalTransition recovery pause owns continuation clear and reason without duplicates", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(goal, {
    kind: "recovery_pause",
    nextGoal: paused,
    recoveryReason: "context_length_exceeded",
  });

  assertDisjointPrimitivePlan(plan, "recovery pause");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "setRecoveryPausedAttention",
    "clearActiveAccounting",
    "clearBudgetWarning",
  ]);
});

test("planGoalTransition recovery shutdown pause clears host overflow recovery", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(goal, {
    kind: "recovery_shutdown_pause",
    nextGoal: paused,
    recoveryReason: "shutdown",
  });

  assertDisjointPrimitivePlan(plan, "recovery shutdown pause");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearHostOverflowRecovery",
    "setRecoveryPausedAttention",
    "clearActiveAccounting",
    "clearBudgetWarning",
  ]);
});

test("applyGoalTransitionEffects invokes handlers in effect order", () => {
  const calls: string[] = [];
  applyGoalTransitionEffects(
    [
      { type: "clearContinuation" },
      { type: "clearActiveAccounting" },
      { type: "resetRecovery" },
      { type: "clearBudgetWarning" },
    ],
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
      clearHostOverflowRecovery: () => {
        calls.push("clearHostOverflowRecovery");
      },
      setRecoveryPausedAttention: () => {
        calls.push("setRecoveryPausedAttention");
      },
      markContinuationQueued: (goalId) => {
        calls.push(`markContinuationQueued:${goalId}`);
      },
      stopStatusRefresh: () => {
        calls.push("stopStatusRefresh");
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

test("planGoalTransition command skip applies post-persist effects only", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(paused, {
    kind: "set",
    nextGoal: paused,
    source: "command",
  });

  assertDisjointPrimitivePlan(plan, "command paused skip");
  assert.equal(plan.persist, "skip");
  assert.deepEqual(plan.beforePersist, []);
  assert.deepEqual(effectTypes(plan.afterPersist), ["resetRecovery"]);
});

test("planGoalTransition abort pause clears primitives before persist when persistence skips", () => {
  const goal = createThreadGoal("ship it");
  const paused = { ...cloneGoal(goal), status: "paused" as const };
  const plan = planGoalTransition(paused, { kind: "abort_pause", nextGoal: paused });

  assertDisjointPrimitivePlan(plan, "abort pause skip");
  assert.equal(plan.persist, "skip");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
  ]);
  assert.deepEqual(plan.afterPersist, []);
});

test("planGoalTransition runtime accounting defers persistence for active usage updates", () => {
  const goal = createThreadGoal("ship it");
  const next = {
    ...cloneGoal(goal),
    usage: { tokensUsed: 5, activeSeconds: 3 },
    updatedAt: goal.updatedAt + 1,
  };

  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: next,
  });

  assertDisjointPrimitivePlan(plan, "runtime defer");
  assert.equal(plan.persist, "defer");
  assert.deepEqual(effectTypes(plan.beforePersist), ["clearBudgetWarning"]);
  assert.deepEqual(plan.afterPersist, []);
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
  });

  assertDisjointPrimitivePlan(plan, "runtime budget cross");
  assert.equal(plan.persist, "set");
  assert.deepEqual(effectTypes(plan.beforePersist), [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
  ]);
});

test("planGoalTransition skip plans have empty beforePersist when unchanged", () => {
  const goal = createThreadGoal("ship it");
  const plan = planGoalTransition(goal, {
    kind: "runtime_accounting",
    nextGoal: goal,
  });

  assertDisjointPrimitivePlan(plan, "runtime skip");
  assert.equal(plan.persist, "skip");
  assert.deepEqual(plan.beforePersist, []);
  assert.deepEqual(plan.afterPersist, []);
});
