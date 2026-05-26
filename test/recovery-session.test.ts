import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRuntimeHarness,
  emitPersistentAssistantError,
} from "./support/runtime-harness.js";
import {
  emitPendingRecoveryShutdown,
  givenPendingOverflowRecovery,
  givenPendingRecoveryWithStaleQueuedAbort,
  givenPendingTransientRecovery,
  replaceHarnessBranchWithGoal,
} from "./support/scenarios.js";

test("pending overflow shutdown persists paused goal with valid resume guidance", async () => {
  const harness = await givenPendingOverflowRecovery();
  await emitPendingRecoveryShutdown(harness, "overflow");
});

test("pending transient shutdown persists paused goal with valid resume guidance", async () => {
  const harness = await givenPendingTransientRecovery();
  await emitPendingRecoveryShutdown(harness, "transient");
});

test("session_start after pending transient shutdown does not auto-continue", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree with pending transient recovery does not auto-continue before shutdown", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree with pending overflow recovery does not auto-continue before compaction", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree after pending transient shutdown does not auto-continue", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_start after pending overflow shutdown does not auto-continue", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

for (const kind of ["transient", "overflow"] as const) {
  test(`pending ${kind} shutdown with stale queued abort pauses before session_tree`, async () => {
    const { harness } = await givenPendingRecoveryWithStaleQueuedAbort(kind);

    harness.sentMessages.length = 0;
    await harness.emit("session_tree", { type: "session_tree" });

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentMessages.length, 0);
  });
}

test("session_tree keeps same-goal pending transient recovery suppressed", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("goal A");
  const goalAId = harness.snapshot().goal?.goalId;
  assert.ok(goalAId);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree to a different active goal clears stale transient recovery and continues", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("goal A");
  const goalAId = harness.snapshot().goal?.goalId;
  assert.ok(goalAId);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  const goalB = replaceHarnessBranchWithGoal(harness, "goal B");
  assert.notEqual(goalB.goalId, goalAId);

  harness.footerStatuses.length = 0;
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, goalB.goalId);
  assert.equal(goal?.objective, "goal B");
  assert.equal(goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goalB.goalId,
  });
});

test("session_tree to a different active goal clears stale overflow recovery and continues", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("goal A");
  const goalAId = harness.snapshot().goal?.goalId;
  assert.ok(goalAId);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  const goalB = replaceHarnessBranchWithGoal(harness, "goal B");
  assert.notEqual(goalB.goalId, goalAId);

  harness.footerStatuses.length = 0;
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, goalB.goalId);
  assert.equal(goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goalB.goalId,
  });
});

test("delayed session_compact keeps goal active without premature pause or extension follow-up", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});
