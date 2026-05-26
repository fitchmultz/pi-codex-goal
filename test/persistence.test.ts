import assert from "node:assert/strict";
import { test } from "node:test";

import { __testHooks } from "../src/index.js";
import { isGoalCustomEntry, reconstructGoal, createThreadGoal, setEntry } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import {
  assistantMessage,
  countGoalSetEntries,
  createRuntimeHarness,
  emitToolExecutionEnd,
} from "./support/runtime-harness.js";

test("duplicate update_goal complete appends only one complete entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await harness.runTool("update_goal", { status: "complete" });
  await harness.runTool("update_goal", { status: "complete" });

  const completeSetEntries = harness.entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      entry.data.goal.status === "complete"
    );
  });
  assert.equal(completeSetEntries.length, 1);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("compaction after complete does not append duplicate runtime entries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("update_goal", { status: "complete" });
  const entryCountAfterComplete = harness.entries.length;

  await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  await harness.emit("session_compact", {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: false,
  });

  assert.equal(harness.entries.length, entryCountAfterComplete);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("repeated tool_execution_end events coalesce runtime persistence when usage is unchanged", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);
    const initialSetEntries = countGoalSetEntries(harness.entries, goalId);
    assert.equal(initialSetEntries, 1);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

    for (let index = 0; index < 5; index += 1) {
      now += 2_000;
      await emitToolExecutionEnd(harness);
    }

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.match(harness.footerStatuses.at(-1) ?? "", /Pursuing goal/);
  } finally {
    Date.now = originalNow;
  }
});

test("turn_end flushes coalesced runtime usage to session entries", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 5_000;
    await emitToolExecutionEnd(harness);
    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 2 }),
      toolResults: [],
    });

    assert.equal(countGoalSetEntries(harness.entries, goalId), 2);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.tokensUsed, 12);
    assert.equal(goal?.usage.activeSeconds, 5);
  } finally {
    Date.now = originalNow;
  }
});

test("session_shutdown flushes pending runtime usage", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 4_000;
    await emitToolExecutionEnd(harness);
    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);

    await harness.emit("session_shutdown", { type: "session_shutdown" });

    assert.equal(countGoalSetEntries(harness.entries, goalId), 2);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.activeSeconds, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("runtime persistence interval flush appends one entry then coalesces until turn_end", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);
    const initialSetEntries = countGoalSetEntries(harness.entries, goalId);
    assert.equal(initialSetEntries, 1);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

    now += __testHooks.runtimePersistIntervalMs + 1_000;
    await emitToolExecutionEnd(harness);

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries + 1);
    const afterIntervalFlush = harness.snapshot().goal;
    assert.equal(
      afterIntervalFlush?.usage.activeSeconds,
      Math.floor((__testHooks.runtimePersistIntervalMs + 1_000) / 1_000),
    );

    for (let index = 0; index < 3; index += 1) {
      now += 2_000;
      await emitToolExecutionEnd(harness);
    }

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries + 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 2 }),
      toolResults: [],
    });

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries + 2);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.tokensUsed, 12);
    assert.equal(
      goal?.usage.activeSeconds,
      Math.floor((__testHooks.runtimePersistIntervalMs + 1_000 + 6_000) / 1_000),
    );
  } finally {
    Date.now = originalNow;
  }
});

test("reconstructGoal uses the latest snapshot across dense legacy and coalesced entries", () => {
  const goal = createThreadGoal("ship it", 100);
  const denseEntries = Array.from({ length: 20 }, (_, index) => ({
    type: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...goal,
        usage: { tokensUsed: index + 1, activeSeconds: index },
        updatedAt: goal.updatedAt + index,
      },
      "runtime",
      goal.updatedAt + index,
    ),
  }));
  const coalescedEntry = {
    type: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...goal,
        usage: { tokensUsed: 99, activeSeconds: 42 },
        status: "active",
        updatedAt: goal.updatedAt + 100,
      },
      "runtime",
      goal.updatedAt + 100,
    ),
  };

  const reconstructed = reconstructGoal([...denseEntries, coalescedEntry]).goal;
  assert.ok(reconstructed);
  assert.equal(reconstructed.usage.tokensUsed, 99);
  assert.equal(reconstructed.usage.activeSeconds, 42);
});

test("compaction with unchanged paused goal appends no new entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runCommand("pause");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  const entryCountAfterPause = harness.entries.length;

  await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  await harness.emit("session_compact", {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: false,
  });

  assert.equal(harness.entries.length, entryCountAfterPause);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(countGoalSetEntries(harness.entries, goalId), 2);
});

test("compaction with unchanged budgetLimited goal appends no new entry", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "budgetLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    const activeSecondsAtBudgetLimit = goal?.usage.activeSeconds ?? 0;
    const entryCountAfterBudgetLimit = harness.entries.length;
    const setEntriesAfterBudgetLimit = countGoalSetEntries(harness.entries, goalId);
    assert.equal(setEntriesAfterBudgetLimit, 2);

    now += 60_000;

    await harness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    });
    await harness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: {},
      fromExtension: false,
    });

    assert.equal(harness.entries.length, entryCountAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(countGoalSetEntries(harness.entries, goalId), setEntriesAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 11);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, activeSecondsAtBudgetLimit);
  } finally {
    Date.now = originalNow;
  }
});

test("session_shutdown with unchanged budgetLimited goal appends no new entry", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "budgetLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    const activeSecondsAtBudgetLimit = goal?.usage.activeSeconds ?? 0;
    const entryCountAfterBudgetLimit = harness.entries.length;
    const setEntriesAfterBudgetLimit = countGoalSetEntries(harness.entries, goalId);
    assert.equal(setEntriesAfterBudgetLimit, 2);

    now += 60_000;

    await harness.emit("session_shutdown", { type: "session_shutdown" });

    assert.equal(harness.entries.length, entryCountAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(countGoalSetEntries(harness.entries, goalId), setEntriesAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 11);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, activeSecondsAtBudgetLimit);
  } finally {
    Date.now = originalNow;
  }
});

test("create_goal replaces a completed goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const completedGoalId = harness.snapshot().goal?.goalId;
  await harness.runTool("update_goal", { status: "complete" });

  const created = (await harness.runTool("create_goal", { objective: "next objective" })) as {
    details: Record<string, unknown>;
  };

  assert.equal((created.details.goal as { objective?: string }).objective, "next objective");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.notEqual(harness.snapshot().goal?.goalId, completedGoalId);
});

test("failed create_goal throws so pi marks the tool result as an error", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await assert.rejects(() => harness.runTool("create_goal", { objective: "duplicate" }), /already has a non-complete goal/);
});
