import assert from "node:assert/strict";
import { test } from "node:test";

import { toQueuedGoalWorkSource, userContentFromUnknown } from "../src/queued-goal-messages.js";
import {
  applyQueuedGoalProviderContextRewrites,
  dedupeActiveGoalContinuations,
  extensionQueuedGoalWorkMessageId,
  queuedGoalWorkMessageId,
  staleGoalContinuationContextMessage,
} from "../src/queued-goal-work.js";
import { compactContinuationPrompt, continuationPrompt } from "../src/prompts.js";
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

test("staleGoalContinuationContextMessage rewrites custom and user queued messages", () => {
  const customSource = toQueuedGoalWorkSource(
    goalCustomContextMessage({
      content: "old",
      details: { kind: "continuation", goalId: "goal-1" },
      timestamp: 1,
    }),
  );
  assert.ok(customSource);
  const staleCustom = staleGoalContinuationContextMessage(
    customSource,
    "goal-1",
    { ...activeGoal, status: "complete" },
  );

  assert.equal(staleCustom.role, "custom");
  assert.equal(staleCustom.display, false);
  assert.equal(staleCustom.details.kind, "stale_continuation");
  assert.match(String(staleCustom.content), /queued hidden goal continuation was stale/);

  const userSource = toQueuedGoalWorkSource(goalUserContextMessage(continuationPrompt(activeGoal)));
  assert.ok(userSource);
  const staleUser = staleGoalContinuationContextMessage(
    userSource,
    "goal-1",
    { ...activeGoal, status: "complete" },
  );

  assert.equal(staleUser.role, "user");
  assert.match(String(staleUser.content[0]?.text), /queued hidden goal continuation was stale/);
});

test("dedupeActiveGoalContinuations supersedes older custom continuations and refreshes the latest", () => {
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

  const { messages, changed } = dedupeActiveGoalContinuations(
    [older, latest],
    activeGoal,
    extensionQueuedGoalWorkMessageId,
  );

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
    resolveStaleQueuedGoalWorkMessageId: queuedGoalWorkMessageId,
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

test("dedupeActiveGoalContinuations leaves an active user marker verbatim", () => {
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

  const { messages, changed } = dedupeActiveGoalContinuations(
    [olderHidden, userMarker, latestHidden],
    activeGoal,
    extensionQueuedGoalWorkMessageId,
  );

  assert.equal(changed, true);
  assert.deepEqual(messages[1]?.content, userMarker.content);
  assert.match(String(userContentFromUnknown(messages[1]?.content)[0]?.text), /<untrusted_objective>/);
});
