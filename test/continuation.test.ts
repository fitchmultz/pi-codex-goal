import assert from "node:assert/strict";
import { isRecord } from "../src/validation.ts";
import { mock, test as nodeTest } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { formatFooterStatus } from "../src/format.ts";
import { isGoalCustomEntry, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import {
  assistantMessage,
  createRuntimeHarness,
  deliverQueuedMessage,
  emitMessageEnd,
  userBeforeAgentStartEvent,
  emitPersistentAssistantError,
  emitToolExecutionEnd,
  fireProviderLimitAutoResume,
  flushContinuationScheduler,
  goalUserContextMessage,
  queuedCustomMessage,
  sessionCompactEvent,
  sessionShutdownEvent,
} from "./support/runtime-harness.ts";

function assistantToolUseMessage(
  input: number,
  output: number,
  toolCalls: ReadonlyArray<{ id: string; name: string }>,
): AssistantMessage {
  return {
    ...assistantMessage("toolUse", { input, output }),
    content: toolCalls.map((toolCall) => ({
      type: "toolCall" as const,
      id: toolCall.id,
      name: toolCall.name,
      arguments: {},
    })),
  };
}

nodeTest("aborted turns pause goals and do not queue continuation", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.clearSentMessages();

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", {
      input: 40,
      output: 2,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "paused");
  assert.equal(goal.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

nodeTest(
  "resuming between aborted turn_end and agent_end does not count the response twice",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it" });
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    const message = assistantMessage("aborted", { input: 40, output: 2 });
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 42);
    await harness.runCommand("resume");
    await harness.emit("agent_end", { type: "agent_end", messages: [message] });

    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 42);
  },
);

nodeTest("a new user-driven agent start leaves a paused goal paused", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });

  await harness.emit("before_agent_start", userBeforeAgentStartEvent("continue"));

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 10);
});

nodeTest(
  "session resume of a saved over-budget paused goal stays budgetLimited without follow-up turn",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it" });
    await harness.runCommand("pause");
    const paused = harness.snapshot().goal;
    assert.ok(paused);
    assert.equal(paused.status, "paused");

    harness.entries.push({
      type: "custom",
      id: "entry-over-budget-paused",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: CUSTOM_ENTRY_TYPE,
      data: setEntry(
        {
          ...paused,
          tokenBudget: 10,
          usage: { tokensUsed: 10, activeSeconds: paused.usage.activeSeconds },
        },
        "runtime",
      ),
    });
    harness.clearSentUserMessages();

    await harness.emit("session_start", { type: "session_start", reason: "resume" });

    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(harness.sentUserMessages.length, 0);
  },
);

nodeTest("session resume prompt can reactivate a paused goal", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });
  harness.clearSentMessages();

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentUserMessages.length, 0);
  const sentUserMessage = harness.sentMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { triggerTurn: true, deliverAs: "followUp" });
  const content = sentUserMessage.message.content;
  if (typeof content !== "string") {
    assert.fail("Expected session resume to send a user continuation prompt.");
  }
  assert.match(content, /<untrusted_objective>/);
  assert.doesNotMatch(content, /pi_goal_delivery|pi_goal_continuation/);
});

nodeTest("completed turns count input plus output and continue active goals", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.clearSentMessages();

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await emitMessageEnd(harness, queuedMessage);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", {
      input: 30,
      output: 12,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.message.customType, CUSTOM_ENTRY_TYPE);
  assert.partialDeepStrictEqual(harness.sentMessages[0].message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});

nodeTest(
  "tool-use turn ends do not queue continuation before tool execution finishes",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 3 }),
      toolResults: [],
    });

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
  },
);

nodeTest("update_goal accounts its calling turn", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });

  const message = assistantToolUseMessage(100, 20, [{ id: "update-call", name: "update_goal" }]);
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  harness.appendMessage(message);
  await harness.runTool("update_goal", { status: "complete" }, "update-call");
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message,
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 120);
  assert.equal(harness.sentMessages.length, 0);
});

nodeTest(
  "update_goal charges the current assistant message when a historical call reuses its ID",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it" });

    harness.appendMessage(assistantToolUseMessage(7, 3, [{ id: "", name: "update_goal" }]));
    const message = assistantToolUseMessage(100, 20, [{ id: "", name: "update_goal" }]);
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    harness.appendMessage(message);
    await harness.runTool("update_goal", { status: "complete" }, "");
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message,
      toolResults: [],
    });

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 120);
    assert.equal(harness.sentMessages.length, 0);
  },
);

nodeTest(
  "direct update_goal execution does not charge a historical call with the same ID",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it" });

    harness.appendMessage(assistantToolUseMessage(7, 3, [{ id: "", name: "update_goal" }]));
    harness.appendMessage(assistantToolUseMessage(100, 20, [{ id: "bash-call", name: "bash" }]));
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.runTool("update_goal", { status: "complete" }, "");

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);
  },
);

nodeTest("duplicate update_goal completion does not double count its calling turn", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });

  const message = assistantToolUseMessage(100, 20, [{ id: "update-call", name: "update_goal" }]);
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  harness.appendMessage(message);
  await harness.runTool("update_goal", { status: "complete" }, "update-call");
  await harness.runTool("update_goal", { status: "complete" }, "update-call");
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message,
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "complete");
  assert.equal(goal.usage.tokensUsed, 120);
  assert.equal(
    harness.entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        isGoalCustomEntry(entry.data) &&
        entry.data.kind === "set" &&
        entry.data.goal.status === "complete",
    ).length,
    1,
  );
  assert.equal(harness.sentMessages.length, 0);
});

nodeTest("update_goal counts a multi-tool assistant message once", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });

  const message = assistantToolUseMessage(100, 20, [
    { id: "bash-call", name: "bash" },
    { id: "update-call", name: "update_goal" },
  ]);
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  harness.appendMessage(message);
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "bash-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
  harness.appendMessage({
    role: "toolResult",
    toolCallId: "bash-call",
    toolName: "bash",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 1,
  });
  await harness.runTool("update_goal", { status: "complete" }, "update-call");
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message,
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 120);
  assert.equal(harness.sentMessages.length, 0);
});

nodeTest("update_goal preserves completion when its calling turn crosses the budget", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 500_000 });

  const message = assistantToolUseMessage(499_999, 2, [{ id: "update-call", name: "update_goal" }]);
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  harness.appendMessage(message);
  const result = await harness.runTool("update_goal", { status: "complete" }, "update-call");
  assert.match(JSON.stringify(result), /tokens used: 500,001 of 500,000/);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message,
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "complete");
  assert.equal(goal.usage.tokensUsed, 500_001);
  assert.equal(harness.sentMessages.length, 0);
});

nodeTest(
  "direct update_goal execution without a matching assistant entry contributes zero",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it" });

    const unrelatedMessage = assistantToolUseMessage(100, 20, [{ id: "bash-call", name: "bash" }]);
    const callingMessage = assistantToolUseMessage(100, 20, [
      { id: "update-call", name: "update_goal" },
    ]);
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    harness.appendMessage(unrelatedMessage);
    await harness.runTool("update_goal", { status: "complete" }, "update-call");
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: callingMessage,
      toolResults: [],
    });

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);
  },
);

nodeTest("successful budget-crossing turn clears stale recovery footer attention", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 500_000 });
  harness.clearSentMessages();
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 499_998, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal.usage.tokensUsed, 500_003);
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal unmet/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

nodeTest("budget crossing sends one hidden budget-limit steering message", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 500_000 });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 499_998, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal.usage.tokensUsed, 500_001);
  assert.equal(harness.sentMessages.length, 1);
  assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
    kind: "budget_limit",
    goalId: goal.goalId,
  });

  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
  assert.equal(harness.sentMessages.length, 1);
});

nodeTest(
  "replacement during an in-flight turn does not charge old tokens to the new goal",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runCommand("old goal");
    harness.clearSentMessages();

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.runCommand("new goal");
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 80, output: 20 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement.goalId);
    assert.equal(goal.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 1);
  },
);

const responseTokenCases: [boolean, boolean][] = [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
];
for (const [complete, precedingTool] of responseTokenCases) {
  nodeTest(
    `pause/resume preserves response tokens (complete: ${complete}, preceding tool: ${precedingTool})`,
    async () => {
      const harness = await createRuntimeHarness();
      await harness.runTool("create_goal", { objective: "ship it" });
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
      const message =
        complete || precedingTool
          ? assistantToolUseMessage(100, 20, [
              ...(precedingTool ? [{ id: "bash-call", name: "bash" }] : []),
              ...(complete ? [{ id: "update-call", name: "update_goal" }] : []),
            ])
          : assistantMessage("stop", { input: 100, output: 20 });
      harness.appendMessage(message);
      await harness.runCommand("pause");
      await harness.runCommand("resume");
      if (precedingTool) {
        await emitToolExecutionEnd(harness);
      }
      if (complete) {
        await harness.runTool("update_goal", { status: "complete" }, "update-call");
      }
      await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });

      const goal = harness.snapshot().goal;
      assert.equal(goal?.status, complete ? "complete" : "active");
      assert.equal(goal.usage.tokensUsed, 120);
    },
  );
}

for (const replacementSource of ["command", "tool"] as const) {
  nodeTest(
    `${replacementSource} replacement counts tool time without claiming the old response's tokens`,
    async () => {
      mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      try {
        const harness = await createRuntimeHarness();
        await harness.runTool("create_goal", { objective: "old goal" });
        await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
        const message = assistantToolUseMessage(100, 20, [
          { id: "create-call", name: "create_goal" },
          { id: "update-call", name: "update_goal" },
        ]);
        if (replacementSource === "command") {
          await harness.runCommand("new goal");
          harness.appendMessage(message);
        } else {
          harness.appendMessage(message);
          await harness.runTool(
            "create_goal",
            { objective: "new goal", replace_existing: true },
            "create-call",
          );
        }
        await emitToolExecutionEnd(harness);
        mock.timers.tick(5_000);
        await emitToolExecutionEnd(harness);
        if (replacementSource === "command") {
          await assert.rejects(
            harness.runTool("update_goal", { status: "complete" }, "update-call"),
            /Goal changed while this response was running/,
          );
        } else {
          await harness.runTool("update_goal", { status: "complete" }, "update-call");
        }
        await harness.emit("turn_end", {
          type: "turn_end",
          turnIndex: 0,
          message,
          toolResults: [],
        });

        const goal = harness.snapshot().goal;
        assert.equal(goal?.objective, "new goal");
        assert.equal(goal.status, replacementSource === "command" ? "active" : "complete");
        assert.equal(goal.usage.tokensUsed, 0);
        assert.equal(goal.usage.activeSeconds, 5);

        if (replacementSource === "command") {
          await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
          harness.appendMessage(
            assistantToolUseMessage(10, 2, [{ id: "finish-new", name: "update_goal" }]),
          );
          await harness.runTool("update_goal", { status: "complete" }, "finish-new");
          assert.equal(harness.snapshot().goal?.status, "complete");
          assert.equal(harness.snapshot().goal?.usage.tokensUsed, 12);
        }
      } finally {
        mock.timers.reset();
      }
    },
  );
}

nodeTest("goal tools return Codex-shaped response details", async () => {
  const harness = await createRuntimeHarness();
  const created = await harness.runTool("create_goal", {
    objective: "ship it",
    token_budget: 500_000,
  });
  assert.ok(isRecord(created.details) && isRecord(created.details.goal));

  assert.equal(created.details.goal.objective, "ship it");
  assert.equal(created.details.goal.tokenBudget, 500_000);
  assert.equal(created.details.remainingTokens, 500_000);
  assert.equal(created.details.completionBudgetReport, null);
  const [content] = created.content;
  assert.ok(content?.type === "text");
  assert.deepEqual(JSON.parse(content.text), {
    goal: created.details.goal,
    remainingTokens: 500_000,
    completionBudgetReport: null,
  });

  const completed = await harness.runTool("update_goal", { status: "complete" });
  assert.ok(isRecord(completed.details));
  assert.ok(typeof completed.details.completionBudgetReport === "string");
  assert.match(
    completed.details.completionBudgetReport,
    /^Goal achieved\. Report final budget usage to the user:/,
  );
});

nodeTest("agent_end queues continuation while the host is still running", async () => {
  const harness = await createRuntimeHarness({ idle: false });
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  await deliverQueuedMessage(harness, queued);
  harness.clearSentMessages();

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
});

nodeTest("agent end waits for idle before continuing active goals", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const queuedMessage = queuedCustomMessage(queued);
    harness.clearSentMessages();

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("message_start", {
      type: "message_start",
      message: queuedMessage,
    });
    await emitMessageEnd(harness, queuedMessage);
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });

    assert.equal(harness.sentMessages.length, 0);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

nodeTest("completing a goal cancels a scheduled continuation before it is sent", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });
    assert.equal(harness.sentMessages.length, 0);

    await harness.runTool("update_goal", { status: "complete" });
    const completeSetEntries = harness.entries.filter((entry) => {
      return (
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        isGoalCustomEntry(entry.data) &&
        entry.data.kind === "set" &&
        entry.data.goal.status === "complete"
      );
    });
    assert.equal(completeSetEntries.length, 1);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("goal follow-up guard resets when custom-message continuations start", async () => {
  const harness = await createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });
  harness.clearSentMessages();

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: queued.message.content,
    display: false,
    details: queued.message.details,
    timestamp: 1,
  };
  harness.clearSentMessages();

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await emitMessageEnd(harness, queuedMessage);
  assert.equal(harness.abortCount, 0);
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 5, output: 6 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});

nodeTest("auto-queued continuations use the compact prompt", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  const commandStart = harness.sentMessages[0];
  assert.ok(commandStart);
  const startPrompt = commandStart.message.content;
  assert.ok(typeof startPrompt === "string");
  assert.match(startPrompt, /<untrusted_objective>/);

  harness.clearSentMessages();
  await harness.emit("before_agent_start", userBeforeAgentStartEvent(startPrompt));
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  const continuation = harness.sentMessages[0];
  assert.ok(continuation);
  const content = continuation.message.content;
  assert.ok(typeof content === "string");
  assert.doesNotMatch(content, /pi_goal_continuation|pi_goal_delivery/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /get_goal/);
});

nodeTest(
  "session compaction queues continuation for active goals after the compaction event unwinds",
  async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const harness = await createRuntimeHarness();
      await harness.runCommand("ship it");
      const queued = harness.sentMessages[0];
      assert.ok(queued);
      harness.clearSentMessages();

      await deliverQueuedMessage(harness, queued);
      await harness.emit("session_compact", sessionCompactEvent());

      const goal = harness.snapshot().goal;
      assert.equal(goal?.status, "active");
      assert.equal(harness.sentMessages.length, 0);

      mock.timers.tick(1);
      assert.equal(harness.sentMessages.length, 1);
      assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
        kind: "continuation",
        goalId: goal.goalId,
      });
    } finally {
      mock.timers.reset();
    }
  },
);

nodeTest("session compaction accelerates an existing idle retry after length stops", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const queuedMessage = queuedCustomMessage(queued);
    harness.clearSentMessages();

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("message_start", {
      type: "message_start",
      message: queuedMessage,
    });
    await emitMessageEnd(harness, queuedMessage);
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("length", { input: 30, output: 12 }),
      toolResults: [],
    });
    assert.equal(harness.sentMessages.length, 0);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    await harness.emit("session_compact", sessionCompactEvent());

    mock.timers.tick(1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

nodeTest(
  "session compaction continuation is cancelled if a host retry starts before the deferred check",
  async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const harness = await createRuntimeHarness();
      await harness.runCommand("ship it");
      const queued = harness.sentMessages[0];
      assert.ok(queued);
      harness.clearSentMessages();

      await deliverQueuedMessage(harness, queued);
      await harness.emit("session_compact", sessionCompactEvent());
      assert.equal(harness.sentMessages.length, 0);

      await harness.emit(
        "before_agent_start",
        userBeforeAgentStartEvent("host compact-and-retry prompt"),
      );
      await harness.emit("agent_start", { type: "agent_start" });
      harness.setIdle(false);
      mock.timers.tick(1);
      assert.equal(harness.sentMessages.length, 0);

      await harness.emit("agent_end", {
        type: "agent_end",
        messages: [assistantMessage("stop", { input: 1, output: 1 })],
      });
      const goal = harness.snapshot().goal;
      assert.equal(goal?.status, "active");
      assert.equal(harness.sentMessages.length, 1);
      assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
        kind: "continuation",
        goalId: goal.goalId,
      });
    } finally {
      mock.timers.reset();
    }
  },
);

nodeTest(
  "repeated session_compact events before the deferred check queue at most one continuation",
  async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const harness = await createRuntimeHarness();
      await harness.runCommand("ship it");
      const queued = harness.sentMessages[0];
      assert.ok(queued);
      harness.clearSentMessages();

      await deliverQueuedMessage(harness, queued);
      for (let index = 0; index < 3; index += 1) {
        await harness.emit(
          "session_compact",
          sessionCompactEvent({
            summary: `compact summary ${index}`,
            tokensBefore: 100 + index,
          }),
        );
      }

      mock.timers.tick(1);
      const goal = harness.snapshot().goal;
      assert.equal(goal?.status, "active");
      assert.equal(harness.sentMessages.length, 1);
      assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
        kind: "continuation",
        goalId: goal.goalId,
      });
    } finally {
      mock.timers.reset();
    }
  },
);

nodeTest("session shutdown cancels deferred session_compact continuations", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    harness.clearSentMessages();

    await deliverQueuedMessage(harness, queued);
    await harness.emit("session_compact", sessionCompactEvent());
    await harness.emit("session_shutdown", sessionShutdownEvent());

    mock.timers.tick(1);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("provider-limit pauses schedule auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();
    harness.clearSentUserMessages();

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");

    const paused = harness.snapshot().goal;
    assert.equal(paused?.status, "paused");
    assert.match(harness.footerStatuses.at(-1) ?? "", /Auto-resume will retry in about 5 minutes/);
    assert.equal(harness.sentUserMessages.length, 0);

    fireProviderLimitAutoResume();

    const resumed = harness.snapshot().goal;
    assert.equal(resumed?.goalId, paused.goalId);
    assert.equal(resumed.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    const content = harness.sentMessages[0]?.message.content;
    assert.ok(typeof content === "string");
    assert.doesNotMatch(content, /pi_goal_continuation|pi_goal_delivery/);
    assert.match(content, /<untrusted_objective>/);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("provider-limit auto-resume retries instead of resuming while busy", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.clearSentMessages();
    harness.clearSentUserMessages();

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.match(harness.footerStatuses.at(-1) ?? "", /Auto-resume will retry/);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("non-limit non-retryable pauses do not schedule auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    await emitPersistentAssistantError(harness, 0, "invalid api key");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Auto-resume/);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("manual resume clears provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();
    harness.clearSentUserMessages();

    await emitPersistentAssistantError(harness, 0, "insufficient_quota 429");
    await harness.runCommand("resume");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);

    fireProviderLimitAutoResume();
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

nodeTest(
  "/goal resume cancel clears provider-limit auto-resume and leaves the goal paused",
  async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const harness = await createRuntimeHarness();
      await harness.runCommand("ship it");
      harness.clearSentMessages();

      await emitPersistentAssistantError(harness, 0, "Monthly usage limit reached");
      await harness.runCommand("resume cancel");

      assert.equal(harness.snapshot().goal?.status, "paused");
      assert.equal(
        harness.footerStatuses.at(-1),
        "Goal needs attention (non-retryable provider error (Monthly usage limit reached)). Use /goal resume to continue.",
      );
      assert.equal(harness.sentUserMessages.length, 0);
      fireProviderLimitAutoResume();
      assert.equal(harness.sentUserMessages.length, 0);
    } finally {
      mock.timers.reset();
    }
  },
);

nodeTest("user input and session shutdown clear provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const userInputHarness = await createRuntimeHarness();
    await userInputHarness.runCommand("ship it");
    userInputHarness.clearSentMessages();
    await emitPersistentAssistantError(userInputHarness, 0, "available balance");
    await userInputHarness.emit("input", {
      type: "input",
      text: "I'll handle it",
      source: "user",
      streamingBehavior: "normal",
    });
    fireProviderLimitAutoResume();
    assert.equal(userInputHarness.snapshot().goal?.status, "paused");
    assert.equal(userInputHarness.sentUserMessages.length, 0);

    const shutdownHarness = await createRuntimeHarness();
    await shutdownHarness.runCommand("ship it");
    shutdownHarness.clearSentMessages();
    await emitPersistentAssistantError(shutdownHarness, 0, "quota exceeded");
    await shutdownHarness.emit("session_shutdown", sessionShutdownEvent());
    fireProviderLimitAutoResume();
    assert.equal(shutdownHarness.sentUserMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("a second provider-limit failure after auto-resume schedules one new retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();
    harness.clearSentUserMessages();

    await emitPersistentAssistantError(harness, 0, "FreeUsageLimitError");
    fireProviderLimitAutoResume();
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);

    harness.clearSentMessages();
    await emitPersistentAssistantError(harness, 1, "FreeUsageLimitError");
    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

nodeTest("assistant error turns do not immediately queue continuation", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.clearSentMessages();

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await emitMessageEnd(harness, queuedMessage);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("error", { input: 30, output: 12 }, "websocket closed"),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

async function finishQueuedCustomRun(
  harness: Awaited<ReturnType<typeof createRuntimeHarness>>,
  queued: NonNullable<(typeof harness.sentMessages)[number]>,
  toolNames: readonly string[],
): Promise<void> {
  await harness.emit("agent_start", { type: "agent_start" });

  harness.setIdle(false);
  const runMessages: object[] = [];
  let turnIndex = 0;

  // Pi emits turn_start before the initial custom message_start for triggerTurn custom prompts.
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await deliverQueuedMessage(harness, queued);

  if (toolNames.length > 0) {
    const toolUseMessage = {
      ...assistantMessage("toolUse", { input: 8, output: 2 }),
      content: toolNames.map((name, index) => ({
        type: "toolCall" as const,
        id: `tool-call-${index}`,
        name,
        arguments: {},
      })),
    };
    for (const [index, toolName] of toolNames.entries()) {
      await harness.emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: `tool-call-${index}`,
        toolName,
        args: {},
        result: {},
        isError: false,
      });
    }
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex,
      message: toolUseMessage,
      toolResults: [],
    });
    runMessages.push(toolUseMessage);
    turnIndex += 1;
    await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  }

  const stopMessage = assistantMessage("stop", { input: 10, output: 3 });
  runMessages.push(stopMessage);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message: stopMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: runMessages,
  });
}

async function queueHiddenContinuation(
  harness: Awaited<ReturnType<typeof createRuntimeHarness>>,
): Promise<NonNullable<(typeof harness.sentMessages)[number]>> {
  await harness.runCommand("ship it");
  const commandStart = harness.sentMessages[0];
  assert.ok(commandStart);
  harness.clearSentMessages();

  // command_start is not a hidden continuation; finishing it should queue one.
  await finishQueuedCustomRun(harness, commandStart, ["bash"]);
  const continuation = harness.sentMessages[0];
  assert.ok(continuation);
  assert.partialDeepStrictEqual(continuation.message.details, {
    kind: "continuation",
    goalId: harness.snapshot().goal?.goalId,
  });
  harness.clearSentMessages();
  return continuation;
}

for (const toolName of ["get_goal", "pi__get_goal"] as const) {
  nodeTest(
    `hidden custom continuation that only calls ${toolName} pauses without queuing another continuation`,
    async () => {
      const harness = await createRuntimeHarness();
      const continuation = await queueHiddenContinuation(harness);
      harness.footerStatuses.length = 0;

      await finishQueuedCustomRun(harness, continuation, [toolName]);

      const goal = harness.snapshot().goal;
      assert.equal(goal?.status, "paused");
      assert.equal(harness.sentMessages.length, 0);
      assert.match(harness.footerStatuses.at(-1) ?? "", /Goal needs attention/);
      assert.match(harness.footerStatuses.at(-1) ?? "", /re-inspected goal status/);
    },
  );
}

nodeTest("hidden custom continuation with actionable tools still queues continuation", async () => {
  const harness = await createRuntimeHarness();
  const continuation = await queueHiddenContinuation(harness);

  await finishQueuedCustomRun(harness, continuation, ["get_goal", "bash"]);

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});

nodeTest("user-driven get_goal-only run stays active and can continue", async () => {
  const harness = await createRuntimeHarness({ idle: false });
  await harness.runCommand("ship it");
  harness.clearSentMessages();

  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("message_start", {
    type: "message_start",
    message: goalUserContextMessage("what is blocking the goal?"),
  });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 8, output: 2 }),
    toolResults: [],
  });
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "get_goal",
    args: {},
    result: {},
    isError: false,
  });
  const stopMessage = assistantMessage("stop", { input: 10, output: 3 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: stopMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [stopMessage],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.partialDeepStrictEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});
