import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  continuationPrompt,
} from "../src/prompts.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitQueuedTurnThroughContext,
} from "./support/runtime-harness.js";

test("provider context dedupes many active continuations to one refreshed prompt", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const fullStart = continuationPrompt(goal);
  const olderContinuation = continuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 },
  });
  const latestContinuation = compactContinuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 },
  });

  const messages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: fullStart,
      display: false,
      details: { kind: "command_start", goalId: goal.goalId },
      timestamp: 1,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: olderContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 2,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: latestContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    },
  ];

  const results = await harness.emit("context", {
    type: "context",
    messages,
  });
  const result = results[0] as { messages?: Array<{ content?: unknown; details?: unknown }> } | undefined;
  assert.ok(result?.messages);
  assert.equal(result.messages.length, 3);

  assert.match(String(result.messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);
  assert.deepEqual(result.messages[0]?.details, {
    kind: "superseded_continuation",
    goalId: goal.goalId,
  });
  assert.match(String(result.messages[1]?.content), /Superseded hidden goal continuation bookkeeping/);

  const latestContent = String(result.messages[2]?.content);
  assert.match(latestContent, /Tokens used: 0/);
  assert.match(latestContent, /Time spent pursuing goal: 0s/);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);
  assert.doesNotMatch(latestContent, /<untrusted_objective>/);
});

test("active provider-context user marker without passthrough binding remains verbatim", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const userPrompt = continuationPrompt(goal);
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: 1,
  };

  const contextResults = await harness.emit("context", {
    type: "context",
    messages: [userMessage],
  });

  assert.equal(contextResults[0], undefined);
  assert.match(userPrompt, /<untrusted_objective>/);
});

test("active provider-context dedupe preserves historical user marker mixed with hidden continuations", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const userPrompt = continuationPrompt(goal);
  const olderContinuation = continuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 },
  });
  const latestContinuation = compactContinuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 },
  });

  const userMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: 2,
  };
  const messages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: olderContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 1,
    },
    userMessage,
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: latestContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    },
  ];

  const contextResults = await harness.emit("context", {
    type: "context",
    messages,
  });
  const result = contextResults[0] as { messages?: Array<{ role: string; content?: unknown; details?: unknown }> } | undefined;
  assert.ok(result?.messages);
  assert.equal(result.messages.length, 3);

  assert.match(String(result.messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);
  assert.deepEqual(result.messages[1]?.content, userMessage.content);
  assert.match(String((result.messages[1]?.content as Array<{ text?: string }> | undefined)?.[0]?.text), /<untrusted_objective>/);

  const latestContent = String(result.messages[2]?.content);
  assert.match(latestContent, /Tokens used: 0/);
  assert.doesNotMatch(latestContent, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);
});

for (const source of ["interactive", "rpc"] as const) {
  test(`active goal pasted continuation marker from ${source} survives provider-context dedupe`, async () => {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goal = harness.snapshot().goal;
    assert.ok(goal);
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const prompt = queued.message.content;
    if (typeof prompt !== "string") {
      assert.fail("Expected queued goal message content to be a string.");
    }

    await harness.emit("input", {
      type: "input",
      text: prompt,
      source,
    });

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 1,
    };
    const contextResults = await emitQueuedTurnThroughContext(harness, [userMessage], 0);

    assert.equal(contextResults[0], undefined);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.match(prompt, /<untrusted_objective>/);
  });
}

test("active goal provider-context dedupe preserves pasted marker input mixed with hidden continuations", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const pastedPrompt = continuationPrompt(goal);
  const olderContinuation = continuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 },
  });
  const latestContinuation = compactContinuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 },
  });

  await harness.emit("input", {
    type: "input",
    text: pastedPrompt,
    source: "interactive",
  });

  const userMessage = {
    role: "user",
    content: [{ type: "text", text: pastedPrompt }],
    timestamp: 2,
  };
  const messages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: olderContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 1,
    },
    userMessage,
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: latestContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    },
  ];

  const contextResults = await emitQueuedTurnThroughContext(harness, messages, 0);
  const result = contextResults[0] as { messages?: Array<{ role: string; content?: unknown; details?: unknown }> } | undefined;
  assert.ok(result?.messages);
  assert.equal(result.messages.length, 3);

  assert.deepEqual(result.messages[1]?.content, userMessage.content);
  assert.match(String((result.messages[1]?.content as Array<{ text?: string }> | undefined)?.[0]?.text), /<untrusted_objective>/);
  assert.match(String(result.messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);

  const latestContent = String(result.messages[2]?.content);
  assert.match(latestContent, /Tokens used: 0/);
  assert.doesNotMatch(latestContent, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);
});

test("latest active continuation remains runnable after provider-context dedupe", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const staleInBranch = continuationPrompt(goal);
  const latestInBranch = compactContinuationPrompt(goal);
  const contextResults = await harness.emit("context", {
    type: "context",
    messages: [
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: staleInBranch,
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
        timestamp: 1,
      },
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: latestInBranch,
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
        timestamp: 2,
      },
    ],
  });
  const contextResult = contextResults[0] as { messages?: Array<{ content?: unknown }> } | undefined;
  const latestContent = String(contextResult?.messages?.[1]?.content);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);

  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: latestContent,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});

test("completed goals are not treated as active during continuation dedupe", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  const prompt = continuationPrompt(harness.snapshot().goal!);

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("context", {
    type: "context",
    messages: [
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: prompt,
        display: false,
        details: { kind: "continuation", goalId },
        timestamp: 1,
      },
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: prompt,
        display: false,
        details: { kind: "continuation", goalId },
        timestamp: 2,
      },
    ],
  });

  const result = results[0] as { messages?: Array<{ content?: unknown; details?: unknown }> } | undefined;
  assert.match(String(result?.messages?.[0]?.content), /queued hidden goal continuation was stale/);
  assert.match(String(result?.messages?.[1]?.content), /queued hidden goal continuation was stale/);
  assert.equal(harness.snapshot().goal?.status, "complete");
});
