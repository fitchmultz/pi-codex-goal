import assert from "node:assert/strict";
import { test } from "node:test";

import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.ts";

function effectTypes(plan: { effects: Array<{ type: string }> }): string[] {
  return plan.effects.map((effect) => effect.type);
}

type GuardTransitionCase = {
  label: string;
  steps: Array<(guard: ReturnType<typeof createStaleQueuedWorkGuard>) => void>;
  act: (guard: ReturnType<typeof createStaleQueuedWorkGuard>) => { skip: boolean; effects: string[] } | null;
  lifecycle: string;
  result: { skip: boolean; effects: string[] } | null;
};

const guardTransitionCases: GuardTransitionCase[] = [
  {
    label: "idle context abort is ignored",
    steps: [],
    act: (guard) => {
      const plan = guard.planContextAbort(0);
      return plan === null ? null : { skip: plan.skip, effects: effectTypes(plan) };
    },
    lifecycle: "idle",
    result: null,
  },
  {
    label: "stale-only observation aborts and blocks continuation",
    steps: [(guard) => guard.noteStaleWorkStarted("goal-1")],
    act: (guard) => {
      const plan = guard.planContextAbort(1);
      return plan === null ? null : { skip: plan.skip, effects: effectTypes(plan) };
    },
    lifecycle: "abortingTurn",
    result: { skip: false, effects: ["clearAccounting", "abort", "refreshUi"] },
  },
  {
    label: "mixed stale and runnable observation returns to pending cleanup",
    steps: [
      (guard) => guard.noteStaleWorkStarted("goal-1"),
      (guard) => guard.planContextAbort(1),
      (guard) => guard.planUserInputClearAbort(),
      (guard) => guard.noteRunnableWorkStarted(),
    ],
    act: (guard) => {
      const plan = guard.planContextAbort(2);
      return plan === null ? null : { skip: plan.skip, effects: effectTypes(plan) };
    },
    lifecycle: "awaitingTerminalCleanup",
    result: null,
  },
  {
    label: "released stale turn_end consumes pending terminal cleanup",
    steps: [
      (guard) => guard.noteStaleWorkStarted("goal-1"),
      (guard) => guard.planContextAbort(1),
      (guard) => guard.planUserInputClearAbort(),
    ],
    act: (guard) => {
      const plan = guard.planTurnEnd(1);
      return { skip: plan.skip, effects: effectTypes(plan) };
    },
    lifecycle: "awaitingTerminalCleanup",
    result: { skip: true, effects: ["refreshUi"] },
  },
];

for (const testCase of guardTransitionCases) {
  test(`stale queued-work reducer transition: ${testCase.label}`, () => {
    const guard = createStaleQueuedWorkGuard();
    for (const step of testCase.steps) {
      step(guard);
    }

    assert.deepEqual(testCase.act(guard), testCase.result);
    assert.equal(guard.lifecycleKind(), testCase.lifecycle);
  });
}

test("idle -> observingTurn when stale work is noted", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");

  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("idle -> observingTurn when runnable work is noted", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteRunnableWorkStarted();

  assert.equal(guard.lifecycleKind(), "observingTurn");
  assert.equal(guard.planContextAbort(0), null);
});

test("observingTurn: mixed stale and current work does not abort", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("stale-goal");
  guard.noteRunnableWorkStarted();

  assert.equal(guard.planContextAbort(0), null);
  assert.equal(guard.lifecycleKind(), "observingTurn");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("observingTurn -> idle on turn_start clears observation", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.noteRunnableWorkStarted();

  const plan = guard.planTurnStart();
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "idle");
});

test("observingTurn -> abortingTurn on context abort with stale-only work", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const plan = guard.planContextAbort(2);
  assert.ok(plan !== null);
  assert.deepEqual(effectTypes(plan), ["clearAccounting", "abort", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
  assert.equal(guard.isBlockingContinuation(), true);
});

test("planTurnStart clears aborting turn without refreshUi", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(4);

  const plan = guard.planTurnStart();
  assert.deepEqual(effectTypes(plan), ["clearAccounting"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("planTurnStart is a no-op when idle", () => {
  const guard = createStaleQueuedWorkGuard();
  const plan = guard.planTurnStart();
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "idle");
});

test("abortingTurn skips tool execution and compaction handlers", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);

  for (const plan of [
    guard.planToolExecutionEnd(),
    guard.planSessionBeforeCompact(),
    guard.planSessionCompact(),
  ]) {
    assert.equal(plan.skip, true);
    assert.deepEqual(effectTypes(plan), ["clearAccounting", "refreshUi"]);
  }
});

test("planSessionShutdown clears aborting state", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);

  const plan = guard.planSessionShutdown();
  assert.deepEqual(effectTypes(plan), ["clearAccounting"]);
  assert.equal(guard.lifecycleKind(), "idle");
});

test("planExtensionContinuationClearAbort applies clearAccounting only", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(2);

  const plan = guard.planExtensionContinuationClearAbort();
  assert.deepEqual(effectTypes(plan), ["clearAccounting"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("planBeforeAgentStartClearAbort matches extension clear", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(2);

  const plan = guard.planBeforeAgentStartClearAbort();
  assert.deepEqual(effectTypes(plan), ["clearAccounting"]);
});
