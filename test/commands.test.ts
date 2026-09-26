import assert from "node:assert/strict";
import test from "node:test";

import {
  handleGoalCommand,
  registerGoalCommand,
  type CommandHost,
  type GoalCommandContext,
  type GoalCommandPi,
} from "../src/commands.ts";
import type { GoalStartTurnStrategy } from "../src/recovery-machine.ts";
import { compactContinuationPrompt } from "../src/prompts.ts";
import { applyUsage, updateGoalStatus } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "../src/types.ts";

type SendMessage = GoalCommandPi["sendMessage"];

interface SentMessage {
  message: Parameters<SendMessage>[0];
  options: Parameters<SendMessage>[1];
}

function createHarness() {
  let goal: ThreadGoal | null = null;
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: Array<{
    content: Parameters<GoalCommandPi["sendUserMessage"]>[0];
    options: Parameters<GoalCommandPi["sendUserMessage"]>[1];
  }> = [];
  const notifications: string[] = [];

  const pi: GoalCommandPi = {
    registerCommand() {},
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
  };

  const host: CommandHost = {
    getGoal: () => goal,
    setGoal(nextGoal: ThreadGoal, _source: GoalEntrySource) {
      goal = nextGoal;
    },
    clearGoal() {
      goal = null;
    },
    cancelProviderLimitAutoResume() {},
    getGoalStartTurnStrategy: () => "hiddenFollowUp",
    resumeGoalWithContinuation(goalId: string) {
      const result = updateGoalStatus(goal, "active");
      if (result.ok && result.goal?.goalId === goalId) {
        goal = result.goal;
        pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
      }
      return result;
    },
  };

  const ctx: GoalCommandContext = {
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      confirm: async () => true,
      setStatus: () => {},
    },
  };

  return {
    ctx,
    host,
    pi,
    setGoal(nextGoal: ThreadGoal | null) {
      goal = nextGoal;
    },
    get goal() {
      return goal;
    },
    notifications,
    sentMessages,
    sentUserMessages,
  };
}

test("/goal objective creates the goal and starts a hidden follow-up turn", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);

  assert.equal(harness.goal?.objective, "ship the feature");
  assert.equal(harness.notifications.at(-1), "Goal set.");
  assert.equal(harness.sentMessages.length, 1);
  const sentMessage = harness.sentMessages[0];
  assert.ok(sentMessage);
  assert.equal(sentMessage.message.customType, CUSTOM_ENTRY_TYPE);
  assert.equal(sentMessage.message.display, false);
  assert.deepEqual(sentMessage.message.details, {
    kind: "command_start",
    goalId: harness.goal?.goalId,
  });
  const content = sentMessage.message.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  assert.match(content, /<untrusted_objective>\nship the feature\n<\/untrusted_objective>/);
  assert.deepEqual(sentMessage.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("/goal completions include resume cancel", () => {
  const harness = createHarness();
  let getArgumentCompletions: ((argumentPrefix: string) => unknown) | undefined;
  const pi: GoalCommandPi = {
    ...harness.pi,
    registerCommand(_name, config) {
      getArgumentCompletions = config.getArgumentCompletions;
    },
  };

  registerGoalCommand(pi, harness.host);

  assert.deepEqual(getArgumentCompletions?.("resume c"), [
    {
      value: "resume cancel",
      label: "resume cancel",
      description: "goal resume cancel",
    },
  ]);
});

test("/goal copy copies the current goal objective", async () => {
  const harness = createHarness();
  const copied: string[] = [];

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  await handleGoalCommand(harness.pi, harness.host, "copy", harness.ctx, async (text) => {
    copied.push(text);
    return { ok: true };
  });

  assert.deepEqual(copied, ["ship the feature"]);
  assert.equal(harness.notifications.at(-1), "Goal objective copied.");
});

test("/goal copy works for completed goals", async () => {
  const harness = createHarness();
  const copied: string[] = [];

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);

  await handleGoalCommand(harness.pi, harness.host, "copy", harness.ctx, async (text) => {
    copied.push(text);
    return { ok: true };
  });

  assert.deepEqual(copied, ["ship the feature"]);
  assert.equal(harness.goal?.status, "complete");
  assert.equal(harness.notifications.at(-1), "Goal objective copied.");
});

test("/goal copy reports missing clipboard support", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  await handleGoalCommand(harness.pi, harness.host, "copy", harness.ctx, async () => ({
    ok: false,
    message: "clipboard unavailable",
  }));

  assert.match(harness.notifications.at(-1) ?? "", /Could not copy goal objective: clipboard unavailable/);
});

test("/goal resume sends a user continuation turn", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  const paused = updateGoalStatus(harness.goal, "paused").goal;
  assert.ok(paused);
  harness.sentMessages.length = 0;
  harness.setGoal(paused);

  await handleGoalCommand(harness.pi, harness.host, "resume", harness.ctx);

  assert.equal(harness.goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const sentUserMessage = harness.sentUserMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { deliverAs: "followUp" });
  const content = sentUserMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued goal resume content to be a string.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /<pi_goal_continuation goal_id="/);
});

test("/goal objective after overflow recovery sends a user start turn", async () => {
  const harness = createHarness();
  let startTurnStrategy: GoalStartTurnStrategy = "userFollowUp";
  const host: CommandHost = {
    getGoal: () => harness.goal,
    setGoal(nextGoal: ThreadGoal) {
      harness.setGoal(nextGoal);
    },
    clearGoal() {
      harness.setGoal(null);
    },
    cancelProviderLimitAutoResume() {},
    getGoalStartTurnStrategy: () => startTurnStrategy,
    resumeGoalWithContinuation(goalId: string) {
      const result = updateGoalStatus(harness.goal, "active");
      if (result.ok && result.goal?.goalId === goalId) {
        harness.setGoal(result.goal);
        harness.pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
      }
      return result;
    },
  };

  await handleGoalCommand(harness.pi, host, "ship the feature", harness.ctx);

  assert.equal(harness.goal?.objective, "ship the feature");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const sentUserMessage = harness.sentUserMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { deliverAs: "followUp" });
  const content = sentUserMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued goal start content to be a string.");
  }
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);

  startTurnStrategy = "hiddenFollowUp";
  harness.sentUserMessages.length = 0;
  await handleGoalCommand(harness.pi, host, "another objective", harness.ctx);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("/goal pause rejects completed and paused goals", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);

  await handleGoalCommand(harness.pi, harness.host, "pause", harness.ctx);
  assert.equal(harness.goal?.status, "complete");
  assert.match(harness.notifications.at(-1) ?? "", /Completed goals are terminal/);

  const paused = updateGoalStatus(completed, "paused");
  assert.equal(paused.ok, false);
});

test("/goal resume rejects completed and ordinarily active goals", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);

  await handleGoalCommand(harness.pi, harness.host, "resume", harness.ctx);
  assert.equal(harness.goal?.status, "complete");
  assert.match(harness.notifications.at(-1) ?? "", /Completed goals are terminal/);

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  assert.equal(harness.goal?.status, "active");
  harness.sentMessages.length = 0;

  await handleGoalCommand(harness.pi, harness.host, "resume", harness.ctx);
  assert.equal(harness.goal?.status, "active");
  assert.match(harness.notifications.at(-1) ?? "", /Only paused goals can be resumed/);
});

test("/goal resume restarts an active goal waiting for user-start overflow recovery", async () => {
  const harness = createHarness();
  const host: CommandHost = {
    getGoal: () => harness.goal,
    setGoal(nextGoal: ThreadGoal) {
      harness.setGoal(nextGoal);
    },
    clearGoal() {
      harness.setGoal(null);
    },
    cancelProviderLimitAutoResume() {},
    getGoalStartTurnStrategy: () => "userFollowUp",
    resumeGoalWithContinuation(goalId: string) {
      const result = updateGoalStatus(harness.goal, "active");
      if (result.ok && result.goal?.goalId === goalId) {
        harness.setGoal(result.goal);
        harness.pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
      }
      return result;
    },
  };

  await handleGoalCommand(harness.pi, host, "ship the feature", harness.ctx);
  harness.sentUserMessages.length = 0;
  assert.equal(harness.goal?.status, "active");

  await handleGoalCommand(harness.pi, host, "resume", harness.ctx);

  assert.equal(harness.goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.match(harness.notifications.at(-1) ?? "", /queued a continuation/);
  const content = harness.sentUserMessages[0]?.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued active resume content to be a string.");
  }
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
});

test("/goal objective replaces a completed goal without confirmation", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "old objective", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);
  harness.sentMessages.length = 0;

  await handleGoalCommand(harness.pi, harness.host, "new objective", harness.ctx);

  assert.equal(harness.goal?.objective, "new objective");
  assert.equal(harness.goal?.status, "active");
  assert.notEqual(harness.goal?.goalId, completed.goalId);
  assert.equal(harness.sentMessages.length, 1);
});

test("/goal resume does not restart an over-budget budget-limited goal", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  const budgeted = { ...harness.goal, tokenBudget: 10 } as ThreadGoal;
  const limited = applyUsage(budgeted, 10, 0).goal;
  assert.ok(limited);
  harness.sentMessages.length = 0;
  harness.setGoal(limited);

  await handleGoalCommand(harness.pi, harness.host, "resume", harness.ctx);

  assert.equal(harness.goal?.status, "budgetLimited");
  assert.equal(harness.sentMessages.length, 0);
});
