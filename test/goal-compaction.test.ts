import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { filterGoalCompactionInput, GOAL_COMPACTION_INPUT_EVENT, registerGoalCompactionFilter } from "../src/goal-compaction.ts";
import { compactContinuationPrompt, continuationPrompt } from "../src/prompts.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import { assistantMessage, createRuntimeHarness, sessionBeforeCompactEvent, sessionCompactEvent, userBeforeAgentStartEvent } from "./support/runtime-harness.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type Message = Preparation["messagesToSummarize"][number];

function goalMessage(kind: string, content = "Goal control text", goalId = "goal-1"): Message {
  return { role: "custom", customType: CUSTOM_ENTRY_TYPE, content, display: false, details: { kind, goalId }, timestamp: 1 };
}

function preparation(messages: Message[]): Preparation {
  return {
    messagesToSummarize: [...messages], turnPrefixMessages: [...messages],
    firstKeptEntryId: "keep-recent-entry", isSplitTurn: true, tokensBefore: 30_000,
    previousSummary: "A real task with verified progress",
    fileOps: { read: new Set(["input.ts"]), written: new Set(["output.ts"]), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  };
}

function replacedMessage(result: unknown): { content: unknown } {
  assert.ok(result && typeof result === "object" && "message" in result);
  return result.message as { content: unknown };
}

test("compaction omits control messages without changing history, task requirements, or boundaries", () => {
  const keep = [goalMessage("command_start", "Exact user objective"), goalMessage("command_resume"), assistantMessage("stop", { input: 1, output: 1 })];
  const transcript = [keep[0]!, goalMessage("continuation"), keep[1]!, goalMessage("superseded_continuation"), goalMessage("stale_continuation"), keep[2]!];
  const original = structuredClone(transcript), input = preparation(transcript);
  const boundaries = { firstKeptEntryId: input.firstKeptEntryId, isSplitTurn: input.isSplitTurn, tokensBefore: input.tokensBefore, previousSummary: input.previousSummary, fileOps: input.fileOps, settings: input.settings };
  filterGoalCompactionInput(input);
  assert.deepEqual(input.messagesToSummarize, keep);
  assert.deepEqual(input.turnPrefixMessages, keep);
  assert.deepEqual(transcript, original);
  for (const [key, value] of Object.entries(boundaries)) assert.equal(input[key as keyof Preparation], value);
});

test("compaction preserves user markers, external messages, budget warnings, and unknown metadata", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: '<pi_goal_continuation goal_id="goal-1">User task</pi_goal_continuation>' }], timestamp: 1 },
    { role: "custom", customType: "background-result", content: "Verification passed", display: true, details: { kind: "continuation", goalId: "goal-1" }, timestamp: 2 },
    goalMessage("budget_limit"),
    { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "Unclassified data", display: false, timestamp: 3 },
    { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "Malformed metadata", details: { kind: "continuation" }, display: false, timestamp: 4 },
  ];
  const input = preparation(messages);
  filterGoalCompactionInput(input);
  assert.deepEqual(input.messagesToSummarize, messages);
  assert.deepEqual(input.turnPrefixMessages, messages);
});

test("default compaction filters through the existing session_before_compact event", async () => {
  const harness = createRuntimeHarness();
  const input = preparation([goalMessage("continuation"), goalMessage("command_start")]);
  assert.deepEqual(await harness.emit("session_before_compact", { ...sessionBeforeCompactEvent(), preparation: input }), [undefined]);
  assert.deepEqual(input.messagesToSummarize, [goalMessage("command_start")]);
});

test("custom summarizers can request the same synchronous filter using the existing extension bus", () => {
  const bus = new EventEmitter();
  const pi = { events: {
    emit(event, data) { bus.emit(event, data); },
    on(event, handler) { bus.on(event, handler); return () => { bus.off(event, handler); }; },
  } } satisfies Pick<ExtensionAPI, "events">;
  registerGoalCompactionFilter(pi);
  const input = preparation([goalMessage("continuation"), goalMessage("command_start")]);
  pi.events.emit(GOAL_COMPACTION_INPUT_EVENT, input);
  assert.deepEqual(input.messagesToSummarize, [goalMessage("command_start")]);
  assert.doesNotThrow(() => pi.events.emit(GOAL_COMPACTION_INPUT_EVENT, null));
  assert.doesNotThrow(() => pi.events.emit(GOAL_COMPACTION_INPUT_EVENT, { messagesToSummarize: null }));
});

test("the next delivered continuation restores the current objective and usage once", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Verify <requirements> & preserve the exact objective");
  const before = harness.snapshot().goal;
  assert.ok(before);
  const queued = goalMessage("continuation", compactContinuationPrompt(before), before.goalId);
  await harness.emit("session_compact", sessionCompactEvent());
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 4, output: 2 }), toolResults: [] });
  const saved = harness.snapshot().goal;
  assert.ok(saved);
  const results = await harness.emit("message_end", { type: "message_end", message: queued });
  const delivered = replacedMessage(results[0]);
  assert.equal(delivered.content, continuationPrompt(saved));
  assert.match(String(delivered.content), /Verify &lt;requirements&gt; &amp; preserve the exact objective/);
  assert.match(String(delivered.content), /Tokens used: 6/);
  assert.equal(await harness.emit("message_end", { type: "message_end", message: queued }).then((r) => r[0]), undefined);
  assert.deepEqual(await harness.emit("context", { type: "context", messages: [delivered] }), [undefined]);
});

test("repeated compactions coalesce and refresh an already queued message without adding another", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Exact objective");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  await harness.emit("session_compact", sessionCompactEvent());
  await harness.emit("session_compact", sessionCompactEvent());
  assert.equal(harness.sentMessages.length, 1);
  const message = { ...queued.message, role: "custom", timestamp: 1 };
  const result = replacedMessage((await harness.emit("message_end", { type: "message_end", message }))[0]);
  assert.equal(result.content, continuationPrompt(harness.snapshot().goal!));
  assert.deepEqual(await harness.emit("message_end", { type: "message_end", message }), [undefined]);
  await harness.emit("session_compact", sessionCompactEvent());
  assert.ok((await harness.emit("message_end", { type: "message_end", message }))[0]);
});

test("native retry preflight does not lose the pending full-goal continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Keep this exact goal across native retry");
  const saved = harness.snapshot().goal;
  assert.ok(saved);
  await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));
  await harness.emit("before_agent_start", userBeforeAgentStartEvent("Native retry"));
  await harness.emit("agent_start", { type: "agent_start" });
  const message = goalMessage("continuation", compactContinuationPrompt(saved), saved.goalId);
  assert.equal(replacedMessage((await harness.emit("message_end", { type: "message_end", message }))[0]).content, continuationPrompt(harness.snapshot().goal!));
});

for (const stopped of ["paused", "waiting", "blocked", "complete"] as const) {
  test(`compaction does not wake a ${stopped} goal or refresh stale queued work`, async () => {
    const harness = createRuntimeHarness();
    await harness.runCommand("Do not restart this stopped goal");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    if (stopped === "paused") await harness.runCommand("pause");
    else await harness.runTool("update_goal", { status: stopped, reason: "Background result or user input is needed" });
    const saved = harness.snapshot().goal;
    harness.sentMessages.length = 0;
    await harness.emit("session_compact", sessionCompactEvent());
    const result = replacedMessage((await harness.emit("message_end", { type: "message_end", message: { ...queued.message, role: "custom", timestamp: 1 } }))[0]);
    assert.doesNotMatch(String(result.content), /<untrusted_objective>/);
    assert.equal(harness.sentMessages.length, 0);
    assert.deepEqual(harness.snapshot().goal, saved);
  });
}

test("explicit user-follow-up resume can carry the full goal without losing images", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Resume after compaction");
  await harness.runCommand("pause");
  await harness.emit("session_compact", sessionCompactEvent());
  await harness.runCommand("resume");
  const text = String(harness.sentUserMessages.at(-1)?.content);
  await harness.emit("input", { type: "input", text, source: "extension" });
  const image = { type: "image", data: "base64", mimeType: "image/png" };
  const caption = { type: "text", text: "Preserve this extra image caption" };
  const message = { role: "user", timestamp: 1, content: [{ type: "text", text }, image, caption] };
  const result = replacedMessage((await harness.emit("message_end", { type: "message_end", message }))[0]);
  assert.deepEqual(result.content, [{ type: "text", text: continuationPrompt(harness.snapshot().goal!) }, image, caption]);
});

test("replaced goals, cancelled notices, and user-pasted markers do not consume the refresh", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Original objective");
  await harness.emit("session_compact", sessionCompactEvent());
  const saved = harness.snapshot().goal;
  assert.ok(saved);
  const text = compactContinuationPrompt(saved);
  await harness.emit("input", { type: "input", text, source: "interactive" });
  assert.deepEqual(await harness.emit("message_end", { type: "message_end", message: { role: "user", timestamp: 1, content: [{ type: "text", text }] } }), [undefined]);
  assert.deepEqual(await harness.emit("message_end", { type: "message_end", message: goalMessage("stale_continuation", "Already cancelled", saved.goalId) }), [undefined]);
  assert.ok((await harness.emit("message_end", { type: "message_end", message: goalMessage("continuation", text, saved.goalId) }))[0]);
  await harness.emit("session_compact", sessionCompactEvent());
  await harness.runTool("update_goal", { status: "complete" });
  await harness.runCommand("Replacement objective");
  const replacement = harness.snapshot().goal;
  assert.ok(replacement);
  assert.deepEqual(await harness.emit("message_end", { type: "message_end", message: goalMessage("continuation", compactContinuationPrompt(replacement), replacement.goalId) }), [undefined]);
});

test("preparation without successful compaction does not request a full goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Compaction failed");
  const saved = harness.snapshot().goal;
  assert.ok(saved);
  await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  assert.deepEqual(await harness.emit("message_end", { type: "message_end", message: goalMessage("continuation", compactContinuationPrompt(saved), saved.goalId) }), [undefined]);
});
