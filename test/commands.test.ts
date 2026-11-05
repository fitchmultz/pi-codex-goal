import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { testUi } from "./support/sdk-fixture.ts";
import { goalDeliveryDetails, createGoalDeliveries } from "../src/goal-delivery.ts";

import {
  handleGoalCommand,
  registerGoalCommand,
  type CommandHost,
  type GoalCommandContext,
  type GoalCommandPi,
} from "../src/commands.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyUsage, updateGoalStatus } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "../src/types.ts";

type SendMessage = ExtensionAPI["sendMessage"];

interface SentMessage {
  message: Parameters<SendMessage>[0];
  options: Parameters<SendMessage>[1];
}

function createHarness() {
  let goal: ThreadGoal | null = null;
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: Array<{
    content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
    options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
  }> = [];
  const notifications: string[] = [];

  const pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "sendUserMessage"> = {
    registerCommand() {
      /* Commands are exercised through handleGoalCommand in this fixture. */
    },
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
  };

  const deliveries = createGoalDeliveries(pi, () => goal);
  const host: CommandHost = {
    getGoal: () => goal,
    setGoal(nextGoal: ThreadGoal, _source: GoalEntrySource) {
      goal = nextGoal;
    },
    clearGoal() {
      goal = null;
    },
    cancelProviderLimitAutoResume() {
      /* This command fixture owns no provider timer. */
    },
    queueGoalTurn(current, kind) {
      deliveries.send(current, kind);
      return { ok: true, message: "Goal follow-up queued.", goal: current };
    },
    resumeGoalWithContinuation(goalId: string) {
      const result = updateGoalStatus(goal, "active");
      if (result.ok && result.goal?.goalId === goalId) {
        goal = result.goal;
        deliveries.send(result.goal, "command_resume");
      }
      return result;
    },
  };

  const ctx: GoalCommandContext = {
    mode: "tui",
    hasUI: true,
    ui: {
      ...testUi(),
      notify(message: string) {
        notifications.push(message);
      },
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

nodeTest("/goal objective creates the goal and starts a hidden follow-up turn", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);

  assert.equal(harness.goal?.objective, "ship the feature");
  assert.equal(harness.notifications.at(-1), "Goal set.");
  assert.equal(harness.sentMessages.length, 1);
  const sentMessage = harness.sentMessages[0];
  assert.ok(sentMessage);
  assert.equal(sentMessage.message.customType, CUSTOM_ENTRY_TYPE);
  assert.equal(sentMessage.message.display, false);
  assert.equal(
    goalDeliveryDetails({ role: "custom", ...sentMessage.message })?.kind,
    "command_start",
  );
  const content = sentMessage.message.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  assert.match(content, /<untrusted_objective>\nship the feature\n<\/untrusted_objective>/);
  assert.deepEqual(sentMessage.options, { triggerTurn: true, deliverAs: "followUp" });
});

nodeTest("/goal completions include resume cancel", () => {
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

nodeTest("/goal copy copies the current goal objective", async () => {
  const harness = createHarness();
  const copied: string[] = [];

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  await handleGoalCommand(harness.host, "copy", harness.ctx, async (text) => {
    copied.push(text);
    return { ok: true };
  });

  assert.deepEqual(copied, ["ship the feature"]);
  assert.equal(harness.notifications.at(-1), "Goal objective copied.");
});

nodeTest("/goal copy works for completed goals", async () => {
  const harness = createHarness();
  const copied: string[] = [];

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);

  await handleGoalCommand(harness.host, "copy", harness.ctx, async (text) => {
    copied.push(text);
    return { ok: true };
  });

  assert.deepEqual(copied, ["ship the feature"]);
  assert.equal(harness.goal?.status, "complete");
  assert.equal(harness.notifications.at(-1), "Goal objective copied.");
});

nodeTest("/goal copy reports missing clipboard support", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  await handleGoalCommand(harness.host, "copy", harness.ctx, async () => ({
    ok: false,
    message: "clipboard unavailable",
  }));

  assert.match(
    harness.notifications.at(-1) ?? "",
    /Could not copy goal objective: clipboard unavailable/,
  );
});

nodeTest("/goal resume queues an automated custom follow-up", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  const paused = updateGoalStatus(harness.goal, "paused").goal;
  assert.ok(paused);
  harness.sentMessages.length = 0;
  harness.setGoal(paused);

  await handleGoalCommand(harness.host, "resume", harness.ctx);

  assert.equal(harness.goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentUserMessages.length, 0);
  const sent = harness.sentMessages[0];
  assert.ok(sent);
  assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "followUp" });
  const content = sent.message.content;
  if (typeof content !== "string") {
    assert.fail("Expected queued goal resume content to be a string.");
  }
  assert.match(content, /<untrusted_objective>/);
  assert.doesNotMatch(content, /pi_goal_delivery|pi_goal_continuation/);
});

nodeTest("/goal pause rejects completed and paused goals", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);

  await handleGoalCommand(harness.host, "pause", harness.ctx);
  assert.equal(harness.goal?.status, "complete");
  assert.match(harness.notifications.at(-1) ?? "", /Completed goals are terminal/);

  const paused = updateGoalStatus(completed, "paused");
  assert.equal(paused.ok, false);
});

nodeTest("/goal resume rejects completed and ordinarily active goals", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);

  await handleGoalCommand(harness.host, "resume", harness.ctx);
  assert.equal(harness.goal?.status, "complete");
  assert.match(harness.notifications.at(-1) ?? "", /Completed goals are terminal/);

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  assert.equal(harness.goal.status, "active");
  harness.sentMessages.length = 0;

  await handleGoalCommand(harness.host, "resume", harness.ctx);
  assert.equal(harness.goal.status, "active");
  assert.match(
    harness.notifications.at(-1) ?? "",
    /Only paused, blocked, or waiting goals can be resumed/,
  );
});

nodeTest("/goal objective replaces a completed goal without confirmation", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "old objective", harness.ctx);
  const completed = updateGoalStatus(harness.goal, "complete").goal;
  assert.ok(completed);
  harness.setGoal(completed);
  harness.sentMessages.length = 0;

  await handleGoalCommand(harness.host, "new objective", harness.ctx);

  assert.equal(harness.goal?.objective, "new objective");
  assert.equal(harness.goal.status, "active");
  assert.notEqual(harness.goal.goalId, completed.goalId);
  assert.equal(harness.sentMessages.length, 1);
});

nodeTest("/goal resume does not restart an over-budget budget-limited goal", async () => {
  const harness = createHarness();

  await handleGoalCommand(harness.host, "ship the feature", harness.ctx);
  const goal = harness.goal;
  assert.ok(goal);
  const budgeted: ThreadGoal = { ...goal, tokenBudget: 10 };
  const limited = applyUsage(budgeted, 10, 0).goal;
  assert.ok(limited);
  harness.sentMessages.length = 0;
  harness.setGoal(limited);

  await handleGoalCommand(harness.host, "resume", harness.ctx);

  assert.equal(harness.goal.status, "budgetLimited");
  assert.equal(harness.sentMessages.length, 0);
});
