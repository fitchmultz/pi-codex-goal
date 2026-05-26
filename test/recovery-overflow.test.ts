import assert from "node:assert/strict";
import { test } from "node:test";

import { formatFooterStatus } from "../src/format.js";
import {
  HOST_OVERFLOW_RECOVERY_REASON,
  recoveryAttentionMessage,
  recoveryPendingAttentionMessage,
} from "../src/recovery.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitPersistentAssistantError,
  queuedCustomMessage,
} from "./support/runtime-harness.js";
import { givenOverflowPausedGoal } from "./support/scenarios.js";

test("turn_end provider errors defer recovery to agent_end without hidden continuation or extension compaction", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 1, output: 1 }, "websocket closed");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("host overflow session compaction does not queue extension continuation before host retry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("host overflow retry success resumes goal continuation after clearing recovery flag", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "host retry",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
});

test("repeated context length errors pause after host default overflow recovery", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
  }

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("first overflow error stays active while host performs compact-and-retry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("context overflow recovery preserves compaction attempts across host session_compact", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(
      harness,
      attempt,
      `prompt is too long: ${(attempt + 1) * 100_000} tokens > 200000 maximum`,
    );
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("overflow after compaction and intervening transient error pauses with recoverable resume", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });
  assert.equal(harness.snapshot().goal?.status, "active");

  await emitPersistentAssistantError(harness, 1, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      { ...goal, status: "paused" },
      recoveryAttentionMessage("context window recovery failed after repeated compaction attempts"),
    ),
  );
});

test("repeated transient errors stay active with pending attention without hidden retries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.compactCalls.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("transient errors surface pending attention without pausing before host retry finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      recoveryPendingAttentionMessage("provider error (websocket closed)"),
    ),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("/goal pause after pending transient error clears recovery attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.runCommand("pause");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(harness.snapshot().goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal paused \(\/goal resume\)/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("/goal pause after pending overflow error clears recovery attention", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.runCommand("pause");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(harness.snapshot().goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal paused \(\/goal resume\)/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("successful turns reset transient error counters and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "keep going",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 1, output: 1 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);

  harness.sentMessages.length = 0;
  await emitPersistentAssistantError(harness, 2, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("exhausted context overflow retries show recoverable attention in footer", async () => {
  const { harness, goal } = await givenOverflowPausedGoal("ship it");
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      { ...goal, status: "paused" },
      recoveryAttentionMessage("context window recovery failed after repeated compaction attempts"),
    ),
  );
});

test("agent_end only counts recovered errors once per failed run", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 1, output: 1 }, "websocket closed");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.compactCalls.length, 0);
});

test("successful toolUse turns reset context overflow recovery counters", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.compactCalls.length, 0);
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("toolUse", { input: 1, output: 1 }),
    toolResults: [],
  });
  assert.equal(harness.sentMessages.length, 0);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("first overflow error shows recoverable attention while host recovery is pending", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("overflow without session_compact stays active with pending overflow attention", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});
