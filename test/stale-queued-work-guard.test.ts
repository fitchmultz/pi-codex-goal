import assert from "node:assert/strict";
import { test } from "node:test";

import { isAbortedAssistantMessage } from "../src/goal-accounting.js";
import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

const abortedAssistant = { role: "assistant" as const, stopReason: "aborted" as const };
const stoppedAssistant = { role: "assistant" as const, stopReason: "stop" as const };

function effectTypes(plan: { effects: Array<{ type: string }> }): string[] {
  return plan.effects.map((effect) => effect.type);
}

test("idle: mixed stale and current work does not abort", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("stale-goal");
  guard.noteRunnableWorkStarted();

  assert.equal(guard.planContextAbort(0), null);
  assert.equal(guard.lifecycleKind(), "idle");
  assert.equal(guard.isBlockingContinuation(), false);
});

test("idle -> abortingTurn on context abort with stale-only work", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");

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

test("abortingTurn: active stale turn_end clears accounting and skips", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(3);

  const turnEndPlan = guard.planTurnEnd(3, abortedAssistant);
  assert.equal(turnEndPlan.skip, true);
  assert.deepEqual(effectTypes(turnEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "abortingTurn");
});

test("abortingTurn -> idle on agent_end finishes lifecycle", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);

  const agentEndPlan = guard.planAgentEnd([abortedAssistant]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(effectTypes(agentEndPlan), ["clearAccounting", "refreshUi"]);
  assert.equal(guard.lifecycleKind(), "idle");
  assert.equal(guard.isBlockingContinuation(), false);
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

test("isAbortedAssistantMessage matches aborted assistant turns", () => {
  assert.equal(isAbortedAssistantMessage(abortedAssistant), true);
  assert.equal(isAbortedAssistantMessage(stoppedAssistant), false);
});
