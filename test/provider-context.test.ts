import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactContinuationPrompt,
  continuationPrompt,
} from "../src/prompts.ts";
import { type QueuedGoalContextCarrier, userContentFromUnknown } from "./support/context-messages.ts";
import {
  assistantMessage,
  createRuntimeHarness,
  userBeforeAgentStartEvent,
  emitProviderContext,
  emitQueuedTurnThroughContext,
  goalCustomContextMessage,
  goalUserContextMessage,
  queuedCustomMessage,
} from "./support/runtime-harness.ts";

test("provider context leaves every active-goal continuation verbatim", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const messages = [
    goalCustomContextMessage({
      content: continuationPrompt(goal),
      details: { kind: "command_start", goalId: goal.goalId },
      timestamp: 1,
    }),
    goalCustomContextMessage({
      content: compactContinuationPrompt({ ...goal, usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 } }),
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 2,
    }),
    goalCustomContextMessage({
      content: compactContinuationPrompt({ ...goal, usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 } }),
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    }),
  ];

  const results = await emitProviderContext(harness, messages);
  assert.deepEqual(results, [undefined]);
});

test("answered goal work stays verbatim as its goal pauses, resumes, completes and is replaced", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const pastedMarker = goalUserContextMessage(continuationPrompt(goal), 5);
  const transcript: QueuedGoalContextCarrier[] = [
    goalCustomContextMessage({
      content: continuationPrompt(goal),
      details: { kind: "command_start", goalId: goal.goalId },
      timestamp: 1,
    }),
    assistantMessage("stop", { input: 1, output: 1 }),
    goalCustomContextMessage({
      content: compactContinuationPrompt(goal),
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    }),
    assistantMessage("stop", { input: 1, output: 1 }),
    pastedMarker,
    assistantMessage("stop", { input: 1, output: 1 }),
  ];

  // Prompt caches match the request prefix exactly, so no goal transition may change sent messages.
  for (const transition of ["pause", "resume", "complete", "replace"] as const) {
    if (transition === "complete") {
      await harness.runTool("update_goal", { status: "complete" });
    } else if (transition === "replace") {
      await harness.runCommand("ship something else");
    } else {
      await harness.runCommand(transition);
    }
    assert.deepEqual(await emitProviderContext(harness, transcript), [undefined], `after ${transition}`);
  }
  assert.equal(harness.snapshot().goal?.objective, "ship something else");
});

test("active provider-context user marker without passthrough binding remains verbatim", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const userPrompt = continuationPrompt(goal);
  const userMessage = goalUserContextMessage(userPrompt, 1);

  const contextResults = await emitProviderContext(harness, [userMessage]);

  assert.equal(contextResults[0], undefined);
  assert.match(userPrompt, /<untrusted_objective>/);
});

for (const source of ["interactive", "rpc"] as const) {
  test(`active goal pasted continuation marker from ${source} survives provider context`, async () => {
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

    const userMessage = goalUserContextMessage(prompt, 1);
    const contextResults = await emitQueuedTurnThroughContext(harness, [userMessage], 0);

    assert.equal(contextResults[0], undefined);
    assert.deepEqual(userMessage, goalUserContextMessage(prompt, 1));
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.match(prompt, /<untrusted_objective>/);
  });
}

test("active goal provider context leaves pasted marker input mixed with hidden continuations verbatim", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const pastedPrompt = continuationPrompt(goal);
  await harness.emit("input", {
    type: "input",
    text: pastedPrompt,
    source: "interactive",
  });

  const userMessage = goalUserContextMessage(pastedPrompt, 2);
  const messages = [
    goalCustomContextMessage({
      content: compactContinuationPrompt(goal),
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 1,
    }),
    userMessage,
    goalCustomContextMessage({
      content: compactContinuationPrompt({ ...goal, usage: { ...goal.usage, tokensUsed: 99 } }),
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    }),
  ];

  const contextResults = await emitQueuedTurnThroughContext(harness, messages, 0);

  assert.equal(contextResults[0], undefined);
  assert.match(String(userContentFromUnknown(userMessage.content)[0]?.text), /<untrusted_objective>/);
});

test("latest active continuation remains runnable", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const latest = queuedCustomMessage(queued, 2);
  const contextResults = await emitQueuedTurnThroughContext(harness, [latest], 0);
  assert.equal(contextResults[0], undefined);
  const latestContent = String(latest.content);
  assert.match(latestContent, /<untrusted_objective>/);

  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", userBeforeAgentStartEvent(latestContent));
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});

test("queued work delivered after its goal completed is cancelled at delivery", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  await harness.runTool("update_goal", { status: "complete" });
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const delivered = [1, 2].map((timestamp) => queuedCustomMessage(queued, timestamp));
  const contextResults = await emitQueuedTurnThroughContext(harness, delivered, 0);

  assert.equal(contextResults[0], undefined);
  for (const message of delivered) {
    assert.match(String(message.content), /queued Goal follow-up was cancelled/);
    assert.partialDeepStrictEqual(message.details, { kind: "stale_continuation", lifecycle: "cancelled", goalId: goal.goalId });
  }
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("a cancellation recorded while the goal was paused is kept after it resumes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  await harness.runCommand("pause");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const delivered = queuedCustomMessage(queued);
  await emitQueuedTurnThroughContext(harness, [delivered], 0);
  assert.equal(harness.abortCount, 1);
  assert.match(String(delivered.content), /cancelled before running/);
  const cancelled = structuredClone(delivered);

  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.deepEqual(await emitProviderContext(harness, [delivered, assistantMessage("aborted", { input: 1, output: 1 })]), [undefined]);
  assert.deepEqual(delivered, cancelled);
});
