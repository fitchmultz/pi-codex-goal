import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createRuntimeHarness, assistantMessage, emitPersistentAssistantError, flushContinuationScheduler, fireProviderLimitAutoResume, queuedCustomMessage, sessionCompactEvent } from "./support/runtime-harness.ts";

// These harness checks cover owned timers and stale queues that the SDK fixture cannot advance deterministically.
test("blocking clears continuation timers and makes already accepted continuations inert without aborting live work", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const h = createRuntimeHarness();
    await h.runCommand("Wait for the filename");
    const queued = h.sentMessages[0];
    assert.ok(queued);
    await h.emit("session_compact", sessionCompactEvent());
    await h.runTool("update_goal", { status: "blocked", reason: "Need filename" });
    assert.equal(h.abortCount, 0, "blocking stops future work, not an already running tool");
    h.sentMessages.length = 0;
    flushContinuationScheduler();
    fireProviderLimitAutoResume();
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
    const results = await h.emit("context", { type: "context", messages: [queuedCustomMessage(queued)] });
    assert.doesNotMatch(JSON.stringify(results), /Continue working toward the active thread goal/);
    await h.emit("agent_end", { type: "agent_end", messages: [] });
    flushContinuationScheduler();
    assert.equal(h.sentMessages.length, 0);
  } finally { mock.timers.reset(); }
});

test("blocking a provider-paused goal cancels its pending auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const h = createRuntimeHarness();
    await h.runCommand("Wait for external approval");
    h.sentMessages.length = 0;
    await emitPersistentAssistantError(h, 0, "usage limit has been reached");
    assert.match(h.footerStatuses.at(-1) ?? "", /Auto-resume/);
    await h.runTool("update_goal", { status: "blocked", reason: "Need user approval" });
    fireProviderLimitAutoResume();
    flushContinuationScheduler();
    assert.equal(h.snapshot().goal?.status, "blocked");
    assert.equal(h.sentUserMessages.length, 0);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.abortCount, 0);
  } finally { mock.timers.reset(); }
});

test("resume before the blocking response ends does not charge that response twice", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Wait for input" });
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const message = { ...assistantMessage("toolUse", { input: 100, output: 20 }), content: [{ type: "toolCall" as const, id: "block", name: "update_goal", arguments: { status: "blocked", reason: "Missing file" } }] };
  h.appendMessage(message);
  await h.runTool("update_goal", { status: "blocked", reason: "Missing file" }, "block");
  assert.equal(h.snapshot().goal?.usage.tokensUsed, 120);
  await h.runCommand("resume");
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  assert.equal(h.snapshot().goal?.status, "active");
  assert.equal(h.snapshot().goal?.usage.tokensUsed, 120);
});

test("blocked goal cannot be completed, replaced by a stale response, or bypass a reached token budget", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Wait for input", token_budget: 500_000 });
  const initial = h.snapshot().goal;
  for (const reason of [undefined, "", "   ", 42]) {
    await assert.rejects(() => h.runTool("update_goal", { status: "blocked", reason }), /non-empty reason/);
    assert.deepEqual(h.snapshot().goal, initial);
  }
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const message = { ...assistantMessage("toolUse", { input: 500_000, output: 2 }), content: [{ type: "toolCall" as const, id: "block", name: "update_goal", arguments: { status: "blocked", reason: "Missing file" } }] };
  h.appendMessage(message);
  await assert.rejects(() => h.runTool("update_goal", { status: "blocked", reason: "Missing file" }, "block"), /Only active or paused goals/);
  assert.equal(h.snapshot().goal?.status, "budgetLimited");
  assert.equal(h.snapshot().goal?.usage.tokensUsed, 500_002);
  await h.runCommand("resume");
  assert.equal(h.snapshot().goal?.status, "budgetLimited");

  await h.runCommand("New objective");
  await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
  await h.runCommand("Replacement objective");
  await assert.rejects(() => h.runTool("update_goal", { status: "blocked", reason: "Old response dependency" }), /Goal changed/);
  assert.equal(h.snapshot().goal?.status, "active");
});
