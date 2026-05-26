import assert from "node:assert/strict";
import { test } from "node:test";

import { toQueuedGoalContextCarrier, toQueuedGoalWorkSource, userContentFromUnknown } from "../src/queued-goal-messages.js";
import {
  applyQueuedGoalProviderContextRewrites,
  extensionQueuedGoalWorkMessageId,
  extensionQueuedGoalWorkMessageIdForRuntime,
} from "../src/queued-goal-work.js";
import { compactContinuationPrompt, continuationGoalIdFromPrompt, continuationPrompt } from "../src/prompts.js";
import type { ThreadGoal } from "../src/types.js";
import { goalCustomContextMessage, goalUserContextMessage } from "./support/runtime-harness.js";

const activeGoal: ThreadGoal = {
  goalId: "goal-1",
  objective: "ship it",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  createdAt: 0,
  updatedAt: 0,
};

const resolveStaleQueuedGoalWorkMessageId = (message: Parameters<typeof extensionQueuedGoalWorkMessageIdForRuntime>[0]) =>
  extensionQueuedGoalWorkMessageIdForRuntime(message, continuationGoalIdFromPrompt);

test("toQueuedGoalWorkSource ignores unrelated custom messages", () => {
  const unrelated = toQueuedGoalContextCarrier({
    role: "custom",
    customType: "other-extension",
    content: "ignored",
    timestamp: 1,
  });
  assert.ok(unrelated);
  assert.equal(toQueuedGoalWorkSource(unrelated), null);
});

test("applyQueuedGoalProviderContextRewrites rewrites stale custom and user queued messages", () => {
  const completedGoal = { ...activeGoal, status: "complete" as const };
  const staleCustom = goalCustomContextMessage({
    content: "old",
    details: { kind: "continuation", goalId: activeGoal.goalId },
    timestamp: 1,
  });
  const staleUser = goalUserContextMessage(continuationPrompt(activeGoal), 2);

  const customResult = applyQueuedGoalProviderContextRewrites([staleCustom], {
    goal: completedGoal,
    resolveStaleQueuedGoalWorkMessageId,
    resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
  });

  assert.equal(customResult.changed, true);
  assert.equal(customResult.messages[0]?.display, false);
  assert.match(String(customResult.messages[0]?.content), /queued hidden goal continuation was stale/);
  assert.deepEqual(customResult.messages[0]?.details, {
    kind: "stale_continuation",
    goalId: activeGoal.goalId,
    currentGoalId: activeGoal.goalId,
    currentStatus: "complete",
  });

  const userResult = applyQueuedGoalProviderContextRewrites([staleUser], {
    goal: completedGoal,
    resolveStaleQueuedGoalWorkMessageId,
    resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
  });

  assert.equal(userResult.changed, true);
  assert.match(String(userContentFromUnknown(userResult.messages[0]?.content)[0]?.text), /queued hidden goal continuation was stale/);
});

test("applyQueuedGoalProviderContextRewrites supersedes older custom continuations and refreshes the latest", () => {
  const older = goalCustomContextMessage({
    content: continuationPrompt(activeGoal),
    details: { kind: "continuation", goalId: activeGoal.goalId },
    timestamp: 1,
  });
  const latest = goalCustomContextMessage({
    content: compactContinuationPrompt({
      ...activeGoal,
      usage: { tokensUsed: 99, activeSeconds: 42 },
    }),
    details: { kind: "continuation", goalId: activeGoal.goalId },
    timestamp: 2,
  });

  const { messages, changed } = applyQueuedGoalProviderContextRewrites([older, latest], {
    goal: activeGoal,
    resolveStaleQueuedGoalWorkMessageId,
    resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
  });

  assert.equal(changed, true);
  assert.equal(messages.length, 2);
  assert.match(String(messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);
  assert.deepEqual(messages[0]?.details, {
    kind: "superseded_continuation",
    goalId: activeGoal.goalId,
  });
  assert.match(String(messages[1]?.content), /Tokens used: 0/);
});

test("applyQueuedGoalProviderContextRewrites marks stale continuations for completed goals", () => {
  const staleContinuation = goalCustomContextMessage({
    content: continuationPrompt(activeGoal),
    details: { kind: "continuation", goalId: activeGoal.goalId },
    timestamp: 1,
  });

  const { messages, changed } = applyQueuedGoalProviderContextRewrites([staleContinuation], {
    goal: { ...activeGoal, status: "complete" },
    resolveStaleQueuedGoalWorkMessageId,
    resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
  });

  assert.equal(changed, true);
  assert.match(String(messages[0]?.content), /queued hidden goal continuation was stale/);
  assert.deepEqual(messages[0]?.details, {
    kind: "stale_continuation",
    goalId: activeGoal.goalId,
    currentGoalId: activeGoal.goalId,
    currentStatus: "complete",
  });
});

test("applyQueuedGoalProviderContextRewrites leaves an active user marker verbatim", () => {
  const userMarker = goalUserContextMessage(continuationPrompt(activeGoal), 2);
  const olderHidden = goalCustomContextMessage({
    content: continuationPrompt({
      ...activeGoal,
      usage: { tokensUsed: 1, activeSeconds: 1 },
    }),
    details: { kind: "continuation", goalId: activeGoal.goalId },
    timestamp: 1,
  });
  const latestHidden = goalCustomContextMessage({
    content: compactContinuationPrompt(activeGoal),
    details: { kind: "continuation", goalId: activeGoal.goalId },
    timestamp: 3,
  });

  const { messages, changed } = applyQueuedGoalProviderContextRewrites(
    [olderHidden, userMarker, latestHidden],
    {
      goal: activeGoal,
      resolveStaleQueuedGoalWorkMessageId,
      resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId,
    },
  );

  assert.equal(changed, true);
  assert.deepEqual(messages[1]?.content, userMarker.content);
  assert.match(String(userContentFromUnknown(messages[1]?.content)[0]?.text), /<untrusted_objective>/);
});
