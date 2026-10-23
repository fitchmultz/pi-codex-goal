import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { formatFooterStatus, formatGoalSummary, toToolGoal } from "../src/format.ts";
import { planGoalTransition } from "../src/goal-transition.ts";
import { compactContinuationPrompt, continuationPrompt, TOOL_PROMPT_GUIDELINES } from "../src/prompts.ts";
import { applyUsage, createThreadGoal, goalsEquivalent, isThreadGoal, reconstructGoal, runtimeUsageEntry, setEntry, updateGoalStatus } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import {
  acceptUserMessage, assistantMessage, createRuntimeHarness, emitPersistentAssistantError, fireProviderLimitAutoResume,
  flushContinuationScheduler, goalUserContextMessage, queuedCustomMessage, sessionCompactEvent,
  userBeforeAgentStartEvent,
} from "./support/runtime-harness.ts";

const reason = "Explorers alpha and beta will send their reports";
const wait = { status: "waiting", reason };

test("waiting requires a named dependency, persists as a set entry, and ignores stale usage", () => {
  const active = createThreadGoal("Integrate explorer reports");
  for (const invalid of [undefined, "", "   "]) {
    assert.equal(updateGoalStatus(active, "waiting", invalid).ok, false);
    assert.equal(isThreadGoal({ ...active, status: "waiting", waitingReason: invalid }), false);
  }
  const waiting = updateGoalStatus(active, "waiting", `  ${reason}  `).goal;
  assert.ok(waiting);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.waitingReason, reason);
  assert.equal(isThreadGoal(waiting), true);
  assert.equal(isThreadGoal({ ...waiting, waitingReason: 42 }), false);
  assert.equal(goalsEquivalent(waiting, { ...waiting, waitingReason: "different job" }), false);
  const usage = runtimeUsageEntry({ ...active, usage: { tokensUsed: 999, activeSeconds: 999 } });
  const entries = [setEntry(active, "tool"), setEntry(waiting, "tool"), usage].map((data) => ({ type: "custom", customType: CUSTOM_ENTRY_TYPE, data }));
  assert.deepEqual(reconstructGoal(entries).goal, waiting);
  assert.throws(() => runtimeUsageEntry(waiting), /Cannot persist waiting/);
  assert.deepEqual(applyUsage(waiting, 100, 60).goal, waiting);
  const plan = planGoalTransition(active, { kind: "set", nextGoal: waiting, source: "tool" });
  for (const type of ["clearContinuation", "clearActiveAccounting", "resetRecovery"]) {
    assert.ok(plan.beforePersist.some((effect) => effect.type === type));
  }
  const resumed = planGoalTransition(waiting, { kind: "resume_waiting" });
  assert.equal(resumed.nextGoal?.status, "active");
  assert.equal(resumed.nextGoal?.waitingReason, undefined);
  assert.deepEqual(resumed.afterPersist, [], "wake the incoming work; do not queue a duplicate turn");
  assert.throws(() => planGoalTransition(active, { kind: "resume_waiting" }), /current status must be waiting/);
});

test("waiting reason is visible in summary, terminal-safe footer and tool output", () => {
  const goal = { ...createThreadGoal("Integrate reports"), status: "waiting" as const, waitingReason: "\x1b]0;title\x07\x1b[31mExplorer\x1b[0m\n report\tA" };
  assert.match(formatGoalSummary(goal), /Waiting for:/);
  assert.match(formatGoalSummary(goal), /\/goal resume/);
  assert.equal(formatFooterStatus(goal), "Goal waiting: Explorer report A (/goal resume)");
  assert.equal(toToolGoal(goal).waitingReason, goal.waitingReason);
});

test("all model guidance distinguishes self-delivering waits from blockers and forbids polling", () => {
  const goal = createThreadGoal("Integrate reports");
  for (const text of [continuationPrompt(goal), compactContinuationPrompt(goal), TOOL_PROMPT_GUIDELINES.join("\n")]) {
    assert.match(text, /status "waiting"/);
    assert.match(text, /reason naming that work/);
    assert.match(text, /Do not poll, sleep/);
    assert.match(text, /will deliver its own result message/);
    assert.match(text, /explicit \/goal resume/);
  }
});

test("waiting stops continuation/fallback timers and idle accounting without aborting running tools", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100_000 });
  try {
    const h = createRuntimeHarness();
    await h.runCommand("Integrate reports");
    const queued = h.sentMessages[0];
    assert.ok(queued);
    await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    mock.timers.tick(2_000);
    const message = { ...assistantMessage("toolUse", { input: 100, output: 20 }), content: [{ type: "toolCall" as const, id: "wait", name: "update_goal", arguments: wait }] };
    h.appendMessage(message);
    await h.emit("session_compact", sessionCompactEvent({ willRetry: true }));
    await h.runTool("update_goal", wait, "wait");
    const saved = h.snapshot().goal;
    assert.equal(saved?.usage.tokensUsed, 120);
    assert.equal(saved?.usage.activeSeconds, 2);
    assert.equal(saved?.waitingReason, reason);
    h.sentMessages.length = 0;
    await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
    await h.emit("agent_end", { type: "agent_end", messages: [message] });
    mock.timers.tick(60_000);
    flushContinuationScheduler();
    fireProviderLimitAutoResume();
    assert.deepEqual(h.snapshot().goal, saved);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
    assert.equal(h.abortCount, 0, "waiting stops future goal work, not live tools");
    const results = await h.emit("context", { type: "context", messages: [queuedCustomMessage(queued)] });
    assert.doesNotMatch(JSON.stringify(results), /Continue working toward the active thread goal/);
  } finally { mock.timers.reset(); }
});

for (const role of ["user", "custom"] as const) {
  test(`${role} input wakes waiting and charges the first resumed response once`, async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100_000 });
    try {
      const h = createRuntimeHarness();
      await h.runTool("create_goal", { objective: "Integrate reports" });
      await h.runTool("update_goal", wait);
      mock.timers.tick(60_000);
      const message = role === "user" ? goalUserContextMessage("Here is the report") : { role: "custom", customType: "explorer-result", content: "Report A", display: true, timestamp: 1 };
      await h.emit("agent_start", { type: "agent_start" });
      await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
      await h.emit("message_start", { type: "message_start", message });
      assert.equal(h.snapshot().goal?.status, "active");
      assert.equal(h.snapshot().goal?.waitingReason, undefined);
      assert.equal(h.sentMessages.length, 0);
      const response = assistantMessage("stop", { input: 200, output: 30 });
      mock.timers.tick(3_000);
      await h.emit("turn_end", { type: "turn_end", turnIndex: 1, message: response, toolResults: [] });
      assert.equal(h.snapshot().goal?.usage.tokensUsed, 230);
      assert.equal(h.snapshot().goal?.usage.activeSeconds, 3, "idle wait is excluded");
      await h.emit("agent_end", { type: "agent_end", messages: [message, response] });
      flushContinuationScheduler();
      assert.equal(h.sentMessages.length, 1, "normal unfinished-work continuation resumes after wake");
      assert.equal(h.snapshot().goal?.usage.tokensUsed, 230);
    } finally { mock.timers.reset(); }
  });
}

test("goal bookkeeping, assistant/tool messages and queued user continuations cannot wake waiting", async () => {
  for (const kind of ["continuation", "command_start", "command_resume", "budget_limit", "superseded_continuation", "stale_continuation"]) {
    const h = createRuntimeHarness();
    await h.runTool("create_goal", { objective: "Integrate reports" });
    const goal = h.snapshot().goal;
    assert.ok(goal);
    const queuedUser = await acceptUserMessage(h, compactContinuationPrompt(goal), "extension");
    await h.runTool("update_goal", wait);
    await h.emit("agent_start", { type: "agent_start" });
    await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
    await h.emit("message_start", { type: "message_start", message: { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "Bookkeeping", display: false, details: { kind, goalId: goal.goalId }, timestamp: 1 } });
    await h.emit("message_start", { type: "message_start", message: assistantMessage("stop", { input: 1, output: 1 }) });
    await h.emit("message_start", { type: "message_start", message: { role: "toolResult", toolCallId: "wait", content: [], timestamp: 1 } });
    assert.equal(h.snapshot().goal?.status, "waiting", kind);
    const prompt = compactContinuationPrompt(goal);
    const [result] = await h.emit("input", { type: "input", text: prompt, images: [], source: "extension" });
    assert.deepEqual(result, { action: "handled" });
    await h.emit("before_agent_start", userBeforeAgentStartEvent(prompt));
    await h.emit("message_start", { type: "message_start", message: queuedUser });
    assert.equal(h.snapshot().goal?.status, "waiting");
  }
});

test("genuine user input remains eligible even when it resembles a continuation", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Integrate reports" });
  const goal = h.snapshot().goal;
  assert.ok(goal);
  await h.runTool("update_goal", wait);
  const prompt = compactContinuationPrompt(goal);
  await h.emit("input", { type: "input", text: prompt, images: [], source: "interactive" });
  await h.emit("before_agent_start", userBeforeAgentStartEvent(prompt));
  await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
  await h.emit("message_start", { type: "message_start", message: goalUserContextMessage(prompt) });
  assert.equal(h.snapshot().goal?.status, "active");
});

test("explicit resume wakes waiting, while explicit pause opts out of automatic wake", async () => {
  for (const command of ["resume", "pause"]) {
    const h = createRuntimeHarness();
    await h.runTool("create_goal", { objective: "Integrate reports" });
    await h.runTool("update_goal", wait);
    await h.runCommand(command);
    assert.equal(h.snapshot().goal?.status, command === "resume" ? "active" : "paused");
    assert.equal(h.snapshot().goal?.waitingReason, undefined);
    assert.equal(h.sentUserMessages.length, command === "resume" ? 1 : 0);
    await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
    await h.emit("message_start", { type: "message_start", message: { role: "custom", customType: "explorer-result", content: "Report", display: true, timestamp: 1 } });
    assert.equal(h.snapshot().goal?.status, command === "resume" ? "active" : "paused");
  }
});

test("waiting cancels provider retries and survives compact/reload/tree without a continuation", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const h = createRuntimeHarness();
    await h.runTool("create_goal", { objective: "Integrate reports" });
    await emitPersistentAssistantError(h, 0, "usage limit has been reached");
    assert.equal(h.snapshot().goal?.status, "paused");
    await h.runTool("update_goal", wait);
    const saved = h.snapshot().goal;
    await h.emit("session_compact", sessionCompactEvent());
    await h.reloadSession("reload");
    await h.emit("session_tree", { type: "session_tree" });
    fireProviderLimitAutoResume();
    flushContinuationScheduler();
    assert.deepEqual(h.snapshot().goal, saved);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
  } finally { mock.timers.reset(); }
});

test("waiting validates before accounting and cannot bypass budget, terminal, blocked or stale-response guards", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Integrate reports", token_budget: 500_000 });
  const initial = h.snapshot().goal;
  for (const invalid of [undefined, "", "   ", 42]) {
    await assert.rejects(() => h.runTool("update_goal", { status: "waiting", reason: invalid }), /non-empty reason/);
    assert.deepEqual(h.snapshot().goal, initial);
  }
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const message = { ...assistantMessage("toolUse", { input: 500_000, output: 2 }), content: [{ type: "toolCall" as const, id: "wait", name: "update_goal", arguments: wait }] };
  h.appendMessage(message);
  await assert.rejects(() => h.runTool("update_goal", wait, "wait"), /Only active or paused goals/);
  assert.equal(h.snapshot().goal?.status, "budgetLimited");
  assert.equal(h.snapshot().goal?.usage.tokensUsed, 500_002);
  const waitingOverBudget = { ...createThreadGoal("Report", 1), status: "waiting" as const, waitingReason: reason, usage: { tokensUsed: 1, activeSeconds: 0 } };
  assert.equal(planGoalTransition(waitingOverBudget, { kind: "resume_waiting" }).nextGoal?.status, "budgetLimited");
  assert.equal(updateGoalStatus(waitingOverBudget, "active").goal?.status, "budgetLimited");
  await h.runCommand("Replacement");
  await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
  await h.runCommand("Newer replacement");
  await assert.rejects(() => h.runTool("update_goal", wait), /Goal changed/);
  const blocked = updateGoalStatus(createThreadGoal("Report"), "blocked", "Missing input").goal;
  assert.equal(updateGoalStatus(blocked, "waiting", reason).ok, false);
  const completed = updateGoalStatus(createThreadGoal("Report"), "complete").goal;
  assert.equal(updateGoalStatus(completed, "waiting", reason).ok, false);
});

test("resume before the waiting response ends does not charge its tokens twice", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Integrate reports" });
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const message = { ...assistantMessage("toolUse", { input: 100, output: 20 }), content: [{ type: "toolCall" as const, id: "wait", name: "update_goal", arguments: wait }] };
  h.appendMessage(message);
  await h.runTool("update_goal", wait, "wait");
  await h.runCommand("resume");
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  assert.equal(h.snapshot().goal?.status, "active");
  assert.equal(h.snapshot().goal?.usage.tokensUsed, 120);
});
