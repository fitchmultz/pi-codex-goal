import assert from "node:assert/strict";
import test from "node:test";

import { handleGoalCommand, type CommandHost, type GoalCommandContext, type GoalCommandPi } from "../src/commands.js";
import { applyUsage, updateGoalStatus } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "../src/types.js";

type SendMessage = GoalCommandPi["sendMessage"];

interface SentMessage {
  message: Parameters<SendMessage>[0];
  options: Parameters<SendMessage>[1];
}

function createHarness() {
  let goal: ThreadGoal | null = null;
  const sentMessages: SentMessage[] = [];
  const notifications: string[] = [];

  const pi: GoalCommandPi = {
    registerCommand() {},
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
      sentMessages.push({ message, options });
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

test("/goal resume restarts a hidden follow-up turn", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.pi, harness.host, "ship the feature", harness.ctx);
  const paused = updateGoalStatus(harness.goal, "paused").goal;
  assert.ok(paused);
  harness.sentMessages.length = 0;
  harness.setGoal(paused);

  await handleGoalCommand(harness.pi, harness.host, "resume", harness.ctx);

  assert.equal(harness.goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  const sentMessage = harness.sentMessages[0];
  assert.ok(sentMessage);
  assert.deepEqual(sentMessage.message.details, {
    kind: "command_resume",
    goalId: harness.goal?.goalId,
  });
  const content = sentMessage.message.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  assert.match(content, /<untrusted_objective>\nship the feature\n<\/untrusted_objective>/);
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

test("/goal resume rejects completed and active goals", async () => {
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
