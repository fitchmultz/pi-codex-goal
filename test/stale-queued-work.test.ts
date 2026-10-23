import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantMessage,
  createRuntimeHarness,
  userBeforeAgentStartEvent,
  emitProviderContext,
  emitQueuedTurnThroughContext,
  goalCustomContextMessage,
  goalUserContextMessage,
  queuedCustomMessage,
  sessionShutdownEvent,
} from "./support/runtime-harness.ts";
import { userContentFromUnknown } from "./support/context-messages.ts";

test("extension user text is never swallowed as Goal automation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("input", {
    type: "input",
    text: prompt,
    source: "extension",
  });

  assert.equal(results[0], undefined);
  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.abortCount, 0);
});

for (const source of ["interactive", "rpc"] as const) {
  test(`pasted continuation marker input from ${source} is not swallowed`, async () => {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const prompt = queued.message.content;
    if (typeof prompt !== "string") {
      assert.fail("Expected queued goal message content to be a string.");
    }

    await harness.runTool("update_goal", { status: "complete" });
    const inputResults = await harness.emit("input", {
      type: "input",
      text: prompt,
      source,
    });
    assert.equal(inputResults[0], undefined);

    const beforeAgentStartResults = await harness.emit("before_agent_start", userBeforeAgentStartEvent(prompt, "base prompt"));
    assert.equal(beforeAgentStartResults[0], undefined);

    const userMessage = goalUserContextMessage(prompt, 1);
    const contextResults = await emitQueuedTurnThroughContext(harness, [userMessage], 0);
    const secondContextResults = await emitProviderContext(harness, [userMessage]);

    assert.equal(contextResults[0], undefined);
    assert.equal(secondContextResults[0], undefined);
    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.abortCount, 0);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 1, output: 1 }),
      toolResults: [],
    });

    const laterUserMessage = goalUserContextMessage(prompt, 2);
    const laterContextResults = await emitQueuedTurnThroughContext(harness, [laterUserMessage], 1);
    assert.equal(laterContextResults[0], undefined);
    assert.equal(userContentFromUnknown(laterUserMessage.content)[0]?.text, prompt);
    assert.equal(harness.abortCount, 0, "genuine user ownership never expires based on text or turn index");
  });
}

test("stale queued continuation aborts if the goal became complete before launch", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }

  const queuedMessage = queuedCustomMessage(queued, 1);
  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("before_agent_start", userBeforeAgentStartEvent(String(userContentFromUnknown(queuedMessage.content)[0]?.text), "base prompt"));

  assert.equal(results[0], undefined);
  assert.equal(harness.abortCount, 0);

  const contextResults = await emitQueuedTurnThroughContext(harness, [queuedMessage]);
  assert.equal(contextResults[0], undefined);
  assert.partialDeepStrictEqual(queuedMessage.details, { kind: "stale_continuation", lifecycle: "cancelled" });

  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.abortCount, 1);
});

test("goal work delivered while active stays verbatim; work delivered after completion is cancelled", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);

  const answered = queuedCustomMessage(queued, 1);
  assert.deepEqual(await emitQueuedTurnThroughContext(harness, [answered]), [undefined]);
  const verbatim = structuredClone(answered);

  await harness.runTool("update_goal", { status: "complete" });
  assert.deepEqual(await emitProviderContext(harness, [answered, assistantMessage("stop", { input: 1, output: 1 })]), [undefined]);
  assert.deepEqual(answered, verbatim);

  const late = queuedCustomMessage(queued, 2);
  assert.deepEqual(await emitQueuedTurnThroughContext(harness, [late], 1), [undefined]);
  assert.equal(late.display, false);
  assert.equal(typeof late.content, "string");
  assert.match(String(late.content), /queued Goal follow-up was cancelled/);
  assert.partialDeepStrictEqual(late.details, {
    kind: "stale_continuation",
    goalId: harness.snapshot().goal?.goalId,
    lifecycle: "cancelled",
  });
});

test("delivery cancellation covers metadata-owned custom controls, not text-only controls or user messages", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedGoalId = harness.snapshot().goal?.goalId;
  assert.ok(queuedGoalId);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }

  const queuedUser = goalUserContextMessage(prompt, 1);
  await harness.runTool("update_goal", { status: "complete" });
  const staleMessages = [
    goalCustomContextMessage({
      content: "queued by details",
      details: { ...queued.message.details as Record<string, unknown>, kind: "continuation" },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: "queued by details",
      details: { ...queued.message.details as Record<string, unknown>, kind: "command_start" },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: "queued by details",
      details: { ...queued.message.details as Record<string, unknown>, kind: "command_resume" },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: prompt,
      details: { kind: "other", goalId: queuedGoalId },
      timestamp: 1,
    }),
    queuedUser,
  ];

  const results = await emitQueuedTurnThroughContext(harness, staleMessages);
  assert.equal(results[0], undefined);
  for (const [index, message] of staleMessages.entries()) {
    if (index < 3) {
      assert.equal(typeof message.content, "string", `custom message ${index} should use string content`);
      assert.match(String(message.content), /do not perform its work/);
      assert.partialDeepStrictEqual(message.details, {
        kind: "stale_continuation",
        goalId: queuedGoalId,
        lifecycle: "cancelled",
      });
    } else if (message.role === "custom") {
      assert.equal(message.content, prompt);
      assert.partialDeepStrictEqual(message.details, { kind: "other", goalId: queuedGoalId });
    } else {
      assert.deepEqual(message, goalUserContextMessage(prompt, 1));
    }
  }
});

test("stale prompt-based queued work does not pause or charge a replacement goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  const oldQueued = harness.sentMessages[0];
  assert.ok(oldQueued);
  const oldPrompt = oldQueued.message.content;
  if (typeof oldPrompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  const oldMessage = queuedCustomMessage(oldQueued, 1);

  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");
  harness.sentMessages.length = 0;

  await emitQueuedTurnThroughContext(harness, [oldMessage]);
  assert.equal(harness.abortCount, 1);

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 20, output: 5 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("aborted", { input: 20, output: 5 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal(harness.abortCount, 1);
  assert.equal(harness.sentMessages.length, 0);
});

test("stale prompt-based queued work with stop terminal does not corrupt replacement goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  const oldQueued = harness.sentMessages[0];
  assert.ok(oldQueued);
  const oldPrompt = oldQueued.message.content;
  if (typeof oldPrompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  const oldMessage = queuedCustomMessage(oldQueued, 1);

  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");
  harness.sentMessages.length = 0;

  await emitQueuedTurnThroughContext(harness, [oldMessage]);
  assert.equal(harness.abortCount, 1);

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 20, output: 5 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 20, output: 5 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal(harness.abortCount, 1);
  assert.equal(harness.sentMessages.length, 0);
});

test("stale custom queued work aborts without pausing, charging, or requeueing a replacement goal", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage]);
    assert.equal(harness.abortCount, 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("aborted", { input: 20, output: 5 })],
    });

    now = 5_000;
    await harness.emit("session_shutdown", sessionShutdownEvent());

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 0);
    assert.equal(goal?.usage.activeSeconds, 0);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("stale custom abort without agent_end does not suppress the next current follow-up", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 2_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);
    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("goal follow-up guard resets when the queued prompt-based agent turn starts", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  assert.equal(harness.sentMessages.length, 1);
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  harness.sentMessages.length = 0;

  await harness.emit("before_agent_start", userBeforeAgentStartEvent(prompt));
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});
