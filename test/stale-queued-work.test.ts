import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantMessage,
  createRuntimeHarness,
  emitProviderContext,
  emitQueuedTurnThroughContext,
  goalCustomContextMessage,
  goalUserContextMessage,
  providerContextMessageAt,
  queuedCustomMessage,
  requireProviderContextResult,
} from "./support/runtime-harness.js";

test("stale prompt continuation input is handled before agent start", async () => {
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

  assert.deepEqual(results[0], { action: "handled" });
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

    const beforeAgentStartResults = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt,
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    });
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
    requireProviderContextResult(laterContextResults);
    assert.equal(harness.abortCount, 1);
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

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base prompt",
    systemPromptOptions: {},
  });

  assert.equal(results[0], undefined);
  assert.equal(harness.abortCount, 0);

  const queuedMessage = goalUserContextMessage(prompt, 1);
  const contextResults = await emitQueuedTurnThroughContext(harness, [queuedMessage]);
  const contextResult = requireProviderContextResult(contextResults);
  assert.deepEqual(providerContextMessageAt(contextResult, 0).content, [
    {
      type: "text",
      text: [
        "A queued hidden goal continuation was stale and has been cancelled before running.",
        `Queued goal id: ${harness.snapshot().goal?.goalId}.`,
        `Current goal id: ${harness.snapshot().goal?.goalId}; current status: complete.`,
        "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
      ].join("\n"),
    },
  ]);

  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.abortCount, 1);
});

test("stale custom goal work messages are replaced before provider context", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);

  const contextMessage = queuedCustomMessage(queued, 1);
  const activeResults = await emitProviderContext(harness, [contextMessage]);
  assert.equal(activeResults[0], undefined);

  await harness.runTool("update_goal", { status: "complete" });
  const results = await emitProviderContext(harness, [contextMessage]);

  const result = requireProviderContextResult(results);
  const replacedMessage = providerContextMessageAt(result, 0);
  assert.equal(typeof replacedMessage?.content, "string");
  assert.match(String(replacedMessage?.content), /queued hidden goal continuation was stale and has been cancelled/);
  assert.deepEqual(replacedMessage?.details, {
    kind: "stale_continuation",
    goalId: harness.snapshot().goal?.goalId,
    currentGoalId: harness.snapshot().goal?.goalId,
    currentStatus: "complete",
  });
});

test("stale provider context replacement covers queued work kinds and prompt markers", async () => {
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

  await harness.runTool("update_goal", { status: "complete" });
  const staleMessages = [
    goalCustomContextMessage({
      content: "queued by details",
      details: { kind: "continuation", goalId: queuedGoalId },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: "queued by details",
      details: { kind: "command_start", goalId: queuedGoalId },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: "queued by details",
      details: { kind: "command_resume", goalId: queuedGoalId },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: prompt,
      details: { kind: "other", goalId: queuedGoalId },
      timestamp: 1,
    }),
    goalUserContextMessage(prompt, 1),
  ];

  const results = await emitProviderContext(harness, staleMessages);
  const result = requireProviderContextResult(results);
  assert.equal(result.messages.length, staleMessages.length);
  for (const [index, message] of result.messages.entries()) {
    if (message.role === "custom") {
      assert.equal(typeof message.content, "string", `custom message ${index} should use string content`);
      assert.match(String(message.content), /do not perform work for the queued goal id above/);
      assert.deepEqual(message.details, {
        kind: "stale_continuation",
        goalId: queuedGoalId,
        currentGoalId: queuedGoalId,
        currentStatus: "complete",
      });
    } else {
      assert.deepEqual(message.content, [
        {
          type: "text",
          text: [
            "A queued hidden goal continuation was stale and has been cancelled before running.",
            `Queued goal id: ${queuedGoalId}.`,
            `Current goal id: ${queuedGoalId}; current status: complete.`,
            "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
          ].join("\n"),
        },
      ]);
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
  const oldMessage = goalUserContextMessage(oldPrompt, 1);

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
  const oldMessage = goalUserContextMessage(oldPrompt, 1);

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
    await harness.emit("session_shutdown", { type: "session_shutdown" });

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
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
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

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});
