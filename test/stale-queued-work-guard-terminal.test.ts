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

test("abortingTurn -> awaitingTerminalCleanup when user clears abort", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const plan = guard.planUserInputClearAbort();
  assert.deepEqual(effectTypes(plan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("awaitingTerminalCleanup: late aborted turn_end is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  guard.planUserInputClearAbort();

  const turnEndPlan = guard.planTurnEnd(1);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: late stale turn_end with stop is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  guard.planUserInputClearAbort();

  const turnEndPlan = guard.planTurnEnd(1);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("abortingTurn -> awaitingTerminalCleanup on agent_end when turn_end is still pending", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);

  const agentEndPlan = guard.planAgentEnd([abortedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("awaitingTerminalCleanup + mixed observation restores awaiting without abort", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  guard.noteStaleWorkStarted("goal-2");
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  assert.equal(guard.planContextAbort(1), null);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: late agent_end for pending stale goal is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
});

test("awaitingTerminalCleanup: late agent_end for pending stale goal with stop is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    stoppedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
});

test("awaitingTerminalCleanup: late id-less agent_end with aborted after abort release is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const agentEndPlan = guard.planAgentEnd([abortedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: late id-less agent_end with stop after abort release is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const agentEndPlan = guard.planAgentEnd([stoppedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: late id-less agent_end with error after abort release is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const agentEndPlan = guard.planAgentEnd([errorAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: goal-bearing agent_end clears obligation without leaving anonymous slot", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();

  const staleGoalEnd = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(staleGoalEnd.skip, true);
  assert.deepEqual(effectTypes(staleGoalEnd), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const currentIdLess = guard.planAgentEnd([stoppedAssistant]);
  assert.deepEqual(currentIdLess, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: current id-less agent_end is not swallowed without pending agent_end obligation", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.planTurnEnd(0);
  guard.planAgentEnd([abortedAssistant]);

  const plan = guard.planAgentEnd([stoppedAssistant]);
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "idle");
});

test("late stale turn_end after current follow-up turn index is ignored", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();

  const ignored = guard.planTurnEnd(2);
  assert.deepEqual(ignored, { skip: false, effects: [] });

  const stale = guard.planTurnEnd(0);
  assert.equal(stale.skip, true);
});

test("observingTurn with pending cleanup: late stale turn_end is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const turnEndPlan = guard.planTurnEnd(0);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: late stale turn_end with stop is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const turnEndPlan = guard.planTurnEnd(0);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: late stale agent_end is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    abortedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: late stale agent_end with stop is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const agentEndPlan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    stoppedAssistant,
  ]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: late id-less agent_end with aborted after abort release is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const agentEndPlan = guard.planAgentEnd([abortedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: late id-less agent_end with stop after abort release is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const agentEndPlan = guard.planAgentEnd([stoppedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: late id-less agent_end with error after abort release is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const agentEndPlan = guard.planAgentEnd([errorAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: current agent_end with continuation is not swallowed", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  guard.noteRunnableWorkStarted();
  guard.planAgentEnd([abortedAssistant]);

  const plan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-2" },
    },
    stoppedAssistant,
  ]);
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("observingTurn with pending cleanup: after current context accepted, id-less error agent_end is not swallowed", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.planContextAbort(1), null);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const plan = guard.planAgentEnd([errorAssistant]);
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("observingTurn with pending cleanup: after current context accepted, goal-bearing stale agent_end is still skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.planContextAbort(1), null);

  const plan = guard.planAgentEnd([
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      details: { kind: "continuation", goalId: "goal-1" },
    },
    errorAssistant,
  ]);
  assert.equal(plan.skip, true);
  assert.deepEqual(effectTypes(plan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: late id-less stale agent_end before current context is still consumed", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planTurnStart();
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");

  const plan = guard.planAgentEnd([errorAssistant]);
  assert.equal(plan.skip, true);
  assert.deepEqual(effectTypes(plan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("observingTurn with pending cleanup: turn_end without pending index is not consumed", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  guard.planTurnEnd(0);

  const plan = guard.planTurnEnd(2);
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("isAbortedAssistantMessage matches aborted assistant turns", () => {
  assert.equal(isAbortedAssistantMessage(abortedAssistant), true);
  assert.equal(isAbortedAssistantMessage(stoppedAssistant), false);
});
