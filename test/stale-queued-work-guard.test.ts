import assert from "node:assert/strict";
import { test } from "node:test";

import { isAbortedAssistantMessage } from "../src/goal-accounting.js";
import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

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

  const turnEndPlan = guard.planTurnEnd(1, abortedAssistant);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("awaitingTerminalCleanup: late stale turn_end with stop is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  guard.planUserInputClearAbort();

  const turnEndPlan = guard.planTurnEnd(1, stoppedAssistant);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});

test("abortingTurn: active stale turn_end clears accounting and skips", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(3);

  const turnEndPlan = guard.planTurnEnd(3, abortedAssistant);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn: active stale turn_end with stop clears accounting and skips", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(3);

  const turnEndPlan = guard.planTurnEnd(3, stoppedAssistant);
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

  const turnEndPlan = guard.planTurnEnd(0, stoppedAssistant);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
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

test("planTurnStart clears aborting turn without refreshUi", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(4);

  const plan = guard.planTurnStart();
  assert.deepEqual(effectTypes(plan), ["clearAccounting"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
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

test("awaitingTerminalCleanup: current id-less agent_end is not swallowed without pending anonymous obligation", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.planAgentEnd([abortedAssistant]);

  const plan = guard.planAgentEnd([stoppedAssistant]);
  assert.deepEqual(plan, { skip: false, effects: [] });
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

test("late stale turn_end after current follow-up turn index is ignored", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();

  const ignored = guard.planTurnEnd(2, abortedAssistant);
  assert.deepEqual(ignored, { skip: false, effects: [] });

  const stale = guard.planTurnEnd(0, abortedAssistant);
  assert.equal(stale.skip, true);
});

test("observingTurn with pending cleanup: late stale turn_end is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  assert.equal(guard.lifecycleKind(), "observingTurn");

  const turnEndPlan = guard.planTurnEnd(0, abortedAssistant);
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

  const turnEndPlan = guard.planTurnEnd(0, stoppedAssistant);
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

test("observingTurn with pending cleanup: turn_end without pending index is not consumed", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);
  guard.planUserInputClearAbort();
  guard.noteRunnableWorkStarted();
  guard.planTurnEnd(0, stoppedAssistant);

  const plan = guard.planTurnEnd(2, stoppedAssistant);
  assert.deepEqual(plan, { skip: false, effects: [] });
  assert.equal(guard.lifecycleKind(), "observingTurn");
});

test("isAbortedAssistantMessage matches aborted assistant turns", () => {
  assert.equal(isAbortedAssistantMessage(abortedAssistant), true);
  assert.equal(isAbortedAssistantMessage(stoppedAssistant), false);
});

test("abortingTurn: late stale turn 0 turn_end during turn 1 abort is skipped", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-0");
  guard.planContextAbort(0);
  guard.planTurnStart();

  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);
  assert.equal(guard.lifecycleKind(), "abortingTurn");

  const turnEndPlan = guard.planTurnEnd(0, abortedAssistant);
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

  const lateTurnEndPlan = guard.planTurnEnd(0, abortedAssistant);
  assert.equal(lateTurnEndPlan.skip, true);
  assert.deepEqual(effectTypes(lateTurnEndPlan), ["refreshUi"]);
  assert.equal(guard.lifecycleKind(), "awaitingTerminalCleanup");
});
