import assert from "node:assert/strict";
import { test } from "node:test";

import { isAbortedAssistantMessage } from "../src/goal-accounting.ts";
import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

const abortedAssistant = { role: "assistant" as const, stopReason: "aborted" as const };
const stoppedAssistant = { role: "assistant" as const, stopReason: "stop" as const };
const errorAssistant = {
  role: "assistant" as const,
  stopReason: "error" as const,
  errorMessage: "provider error",
};

function effectTypes(plan: { effects: Array<{ type: string }> }): string[] {
  return plan.effects.map((effect) => effect.type);
}

test("abortingTurn: active stale turn_end clears accounting and skips", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(3);

  const turnEndPlan = guard.planTurnEnd(3);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn: active stale turn_end with stop clears accounting and skips", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(3);

  const turnEndPlan = guard.planTurnEnd(3);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn: active stale agent_end with stop finishes aborting lifecycle", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);

  const agentEndPlan = guard.planAgentEnd([stoppedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: late stale turn_end with stop during active abort is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const turnEndPlan = guard.planTurnEnd(0);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn: late stale turn 0 turn_end during turn 1 abort is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const turnEndPlan = guard.planTurnEnd(0);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn: late stale turn 0 agent_end during turn 1 abort is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-0" },
    },
    abortedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn: combined older and active agent_end with aborted finishes active lifecycle", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-0" },
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: combined older and active agent_end with stop finishes active lifecycle", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-0" },
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    stoppedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: active id-less agent_end after active turn_end finishes active when older obligation pending", () => {
  for (const terminal of [errorAssistant, stoppedAssistant, abortedAssistant] as const) {
    const guard = createStaleQueuedWorkGuard();
    guard.noteStaleWorkStarted("goal-0");
    guard.planContextAbort(0);
    guard.planTurnStart();

    guard.noteStaleWorkStarted("goal-1");
    guard.planContextAbort(1);
    assert.equal(guard.lifecycleKind(), "abortingTurn");

    const activeTurnEndPlan = guard.planTurnEnd(1);
    assert.equal(activeTurnEndPlan.skip, true);
    assert.deepEqual(effectTypes(activeTurnEndPlan), ["clearAccounting", "refreshUi"]);
    assert.equal(guard.lifecycleKind(), "abortingTurn");
    assert.equal(guard.isBlockingContinuation(), true);

    const activeAnonymousPlan = guard.planAgentEnd([terminal]);
    assert.equal(activeAnonymousPlan.skip, true);
    assert.deepEqual(effectTypes(activeAnonymousPlan), ["clearAccounting", "refreshUi"]);
    assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
    assert.equal(guard.isBlockingContinuation(), false);

    const lateOlderPlan = guard.planAgentEnd([terminal]);
    assert.equal(lateOlderPlan.skip, true);
    assert.deepEqual(effectTypes(lateOlderPlan), ["refreshUi"]);
    assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
    assert.equal(guard.isBlockingContinuation(), false);
  }
});

test("abortingTurn: older id-less agent_end error during newer active abort stays aborting until active terminal", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const olderAnonymousPlan = guard.planAgentEnd([errorAssistant]);
  assert.equal(olderAnonymousPlan.skip, true);
  assert.deepEqual(effectTypes(olderAnonymousPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
  assert.equal(guard.isBlockingContinuation(), true);

  const activePlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(activePlan.skip, true);
  assert.deepEqual(effectTypes(activePlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: older multi-goal obligation with active overlap stays aborting until active terminal", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const olderPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-0" },
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(olderPlan.skip, true);
  assert.deepEqual(effectTypes(olderPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
  assert.equal(guard.isBlockingContinuation(), true);

  const activePlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(activePlan.skip, true);
  assert.deepEqual(effectTypes(activePlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: duplicate same-goal stale aborts consume older agent_end first", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-shared");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-shared");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const olderPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-shared" },
    },
    abortedAssistant,
  ]);
  assert.equal(olderPlan.skip, true);
  assert.deepEqual(effectTypes(olderPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
  assert.equal(guard.isBlockingContinuation(), true);

  const activePlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-shared" },
    },
    abortedAssistant,
  ]);
  assert.equal(activePlan.skip, true);
  assert.deepEqual(effectTypes(activePlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: duplicate same-goal matches in one active agent_end consume only one obligation", () => {
  const guard = createStaleQueuedWorkGuard();
  const sharedGoalMessage = {
    role: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    details: { kind: "continuation" as const, goalId: "goal-shared" },
  };

  guard.noteStaleWorkStarted("goal-shared");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-shared");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const activeDuplicatePlan = guard.planAgentEnd([
    sharedGoalMessage,
    { ...sharedGoalMessage },
    abortedAssistant,
  ]);
  assert.equal(activeDuplicatePlan.skip, true);
  assert.deepEqual(effectTypes(activeDuplicatePlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
  assert.equal(guard.isBlockingContinuation(), true);

  const olderPlan = guard.planAgentEnd([sharedGoalMessage, abortedAssistant]);
  assert.equal(olderPlan.skip, true);
  assert.deepEqual(effectTypes(olderPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: same-goal active agent_end after active turn_end finishes without older terminal", () => {
  const guard = createStaleQueuedWorkGuard();
  const sharedGoalMessage = {
    role: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    details: { kind: "continuation" as const, goalId: "goal-shared" },
  };

  guard.noteStaleWorkStarted("goal-shared");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-shared");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const activeTurnEndPlan = guard.planTurnEnd(1);
  assert.equal(activeTurnEndPlan.skip, true);
  assert.deepEqual(effectTypes(activeTurnEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
  assert.equal(guard.isBlockingContinuation(), true);

  const activeDuplicatePlan = guard.planAgentEnd([
    sharedGoalMessage,
    { ...sharedGoalMessage },
    abortedAssistant,
  ]);
  assert.equal(activeDuplicatePlan.skip, true);
  assert.deepEqual(effectTypes(activeDuplicatePlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);

  const lateOlderPlan = guard.planAgentEnd([sharedGoalMessage, abortedAssistant]);
  assert.equal(lateOlderPlan.skip, true);
  assert.deepEqual(effectTypes(lateOlderPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);

  const lateOlderTurnEndPlan = guard.planTurnEnd(0);
  assert.equal(lateOlderTurnEndPlan.skip, true);
  assert.deepEqual(effectTypes(lateOlderTurnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "idle");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("abortingTurn: goal-bearing agent_end clears active obligation without anonymous remainder", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const staleGoalEnd = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(staleGoalEnd.skip, true);
  assert.deepEqual(effectTypes(staleGoalEnd), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const currentIdLess = guard.planAgentEnd([errorAssistant]);
  assert.deepEqual(currentIdLess, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("abortingTurn: active turn 1 agent_end preserves awaiting cleanup for turn 0", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);

  const lateTurnEndPlan = guard.planTurnEnd(0);
  assert.equal(lateTurnEndPlan.skip, true);
  assert.deepEqual(effectTypes(lateTurnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});
