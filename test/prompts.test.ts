import assert from "node:assert/strict";
import test from "node:test";

import {
  GOAL_TOOL_NAME_GUIDANCE,
  TOOL_PROMPT_GUIDELINES,
  budgetLimitPrompt,
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  goalToolReference,
  supersededContinuationMessage,
} from "../src/prompts.js";
import { createGoal } from "../src/state.js";

test("tool prompt guidelines include exposed and namespaced goal tool guidance", () => {
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /available tool list/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__get_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__create_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__update_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /Do not assume display, history, or transcript tool names are callable/);

  assert.equal(goalToolReference("update_goal"), "update_goal (or the exposed namespaced equivalent, such as pi__update_goal)");

  const combined = TOOL_PROMPT_GUIDELINES.join("\n");
  assert.match(combined, /get_goal \(or the exposed namespaced equivalent, such as pi__get_goal\)/);
  assert.match(combined, /create_goal \(or the exposed namespaced equivalent, such as pi__create_goal\)/);
  assert.match(combined, /update_goal \(or the exposed namespaced equivalent, such as pi__update_goal\)/);
});

test("compact continuation keeps marker detection without repeating the full objective", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const compact = compactContinuationPrompt(created);
  const full = continuationPrompt(created);

  assert.equal(continuationGoalIdFromPrompt(compact), created.goalId);
  assert.match(compact, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(compact, /<untrusted_objective>/);
  assert.match(compact, /get_goal/);
  assert.ok(compact.length < full.length);
});

test("superseded continuation bookkeeping does not expose a runnable marker", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const superseded = supersededContinuationMessage(created.goalId);
  assert.equal(continuationGoalIdFromPrompt(superseded), null);
  assert.match(superseded, /Superseded hidden goal continuation bookkeeping/);
});

test("continuation and budget-limit prompts reference exposed goal-completion tool names", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  const budget = budgetLimitPrompt(created);

  for (const prompt of [continuation, budget]) {
    assert.match(prompt, /update_goal \(or the exposed namespaced equivalent, such as pi__update_goal\)/);
    assert.match(prompt, /pi__update_goal/);
    assert.match(prompt, /Do not assume display, history, or transcript tool names are callable/);
  }
});
