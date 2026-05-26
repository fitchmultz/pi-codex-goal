import assert from "node:assert/strict";
import { test } from "node:test";

import { isAbortedAssistantMessage } from "../src/goal-accounting.js";
import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.js";

test("planContextAbort enters aborting turn and requests abort effects", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");

  const effects = guard.planContextAbort(2);
  assert.ok(effects !== null);
  assert.deepEqual(
    effects?.map((effect) => effect.type),
    ["clearAccounting", "abort", "refreshUi"],
  );
  assert.equal(guard.isBlockingContinuation(), true);
});

test("clearAbortingTurn keeps terminal tracking without blocking continuation", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(1);

  const { cleared, effects } = guard.clearAbortingTurn();
  assert.equal(cleared, true);
  assert.deepEqual(effects, [{ type: "clearAccounting" }]);
  assert.equal(guard.isBlockingContinuation(), false);

  const turnEndPlan = guard.planTurnEnd(1, { role: "assistant", stopReason: "aborted" });
  assert.equal(turnEndPlan.skip, true);
});

test("planAgentEnd finishes aborting lifecycle", () => {
  const guard = createStaleQueuedWorkGuard();
  guard.noteStaleWorkStarted("goal-1");
  guard.planContextAbort(0);

  const agentEndPlan = guard.planAgentEnd([{ role: "assistant", stopReason: "aborted" }]);
  assert.equal(agentEndPlan.skip, true);
  assert.deepEqual(
    agentEndPlan.effects.map((effect) => effect.type),
    ["clearAccounting", "refreshUi"],
  );
  assert.equal(guard.isBlockingContinuation(), false);
});

test("isAbortedAssistantMessage matches aborted assistant turns", () => {
  assert.equal(isAbortedAssistantMessage({ role: "assistant", stopReason: "aborted" }), true);
  assert.equal(isAbortedAssistantMessage({ role: "assistant", stopReason: "stop" }), false);
});
