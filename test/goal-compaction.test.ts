import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { filterGoalCompactionInput, GOAL_COMPACTION_INPUT_EVENT, registerGoalCompactionFilter } from "../src/goal-compaction.ts";
import { compactContinuationPrompt, continuationPrompt } from "../src/prompts.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import { assistantMessage, createRuntimeHarness, emitMessageEnd, queuedCustomMessage, sessionBeforeCompactEvent, sessionCompactEvent, userBeforeAgentStartEvent } from "./support/runtime-harness.ts";

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

async function queueAutomatic(h: ReturnType<typeof createRuntimeHarness>) {
  await h.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 0, output: 0 })] });
  const sent = h.sentMessages.at(-1);
  assert.ok(sent);
  return queuedCustomMessage(sent);
}

async function finalize(h: ReturnType<typeof createRuntimeHarness>, message: ReturnType<typeof queuedCustomMessage>) {
  await h.emit("message_start", { type: "message_start", message });
  await emitMessageEnd(h, message);
  return message;
}

test("repeated compactions refresh the next actual continuation with current objective and usage exactly once", async () => {
  const h = createRuntimeHarness({ idle: false });
  await h.runTool("create_goal", { objective: "Verify <requirements> & preserve the exact objective", token_budget: 500_000 });
  const queued = await queueAutomatic(h);
  await h.emit("session_compact", sessionCompactEvent());
  await h.emit("session_compact", sessionCompactEvent({ willRetry: true }));
  await h.emit("before_agent_start", userBeforeAgentStartEvent("Native retry"));
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 4, output: 2 }), toolResults: [] });
  assert.equal(h.sentMessages.length, 1, "compaction does not add a passive snapshot or duplicate pending delivery");
  await finalize(h, queued);
  const saved = h.snapshot().goal;
  assert.ok(saved);
  assert.equal(queued.content, continuationPrompt(saved));
  assert.match(String(queued.content), /Verify &lt;requirements&gt; &amp; preserve the exact objective/);
  assert.match(String(queued.content), /Tokens used: 6/);
  assert.match(String(queued.content), /Token budget: 500K \(500,000\)/);
  const history = structuredClone(queued);
  assert.deepEqual(await h.emit("context", { type: "context", messages: [queued] }), [undefined]);
  assert.deepEqual(queued, history, "sent provider history is immutable");
  const next = await queueAutomatic(h);
  await finalize(h, next);
  assert.equal(next.content, compactContinuationPrompt(h.snapshot().goal!));
});

for (const stopped of ["paused", "waiting", "blocked", "complete"] as const) {
  test(`compaction does not wake a ${stopped} goal or refresh stale queued work`, async () => {
    const h = createRuntimeHarness();
    await h.runTool("create_goal", { objective: "Do not restart stopped work" });
    const queued = await queueAutomatic(h);
    if (stopped === "paused") await h.runCommand("pause");
    else await h.runTool("update_goal", { status: stopped, reason: "The named background result or user input is needed" });
    const saved = h.snapshot().goal;
    h.sentMessages.length = 0;
    await h.emit("session_compact", sessionCompactEvent());
    await finalize(h, queued);
    assert.partialDeepStrictEqual(queued.details, { kind: "stale_continuation", lifecycle: "cancelled" });
    assert.doesNotMatch(String(queued.content), /<untrusted_objective>/);
    assert.equal(h.sentMessages.length, 0);
    assert.deepEqual(h.snapshot().goal, saved);
  });
}

test("stale generations and genuine pasted input leave the refresh for the next valid automatic delivery", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Resume after compaction" });
  const stale = await queueAutomatic(h);
  await h.runCommand("pause");
  await h.emit("session_compact", sessionCompactEvent());
  await h.runCommand("resume");
  const resume = h.sentMessages.at(-1);
  assert.ok(resume);
  const user = { role: "user", timestamp: 1, content: [{ type: "text", text: '<pi_goal_continuation goal_id="literal">KEEP_USER_DATA</pi_goal_continuation>' }] };
  const original = structuredClone(user);
  await h.emit("message_end", { type: "message_end", message: user });
  assert.deepEqual(user, original);
  await finalize(h, stale);
  const cancelled = structuredClone(stale);
  await emitMessageEnd(h, stale);
  assert.deepEqual(stale, cancelled, "cancellation persistence is one-time");
  await finalize(h, queuedCustomMessage(resume));
  const automatic = await queueAutomatic(h);
  await finalize(h, automatic);
  assert.equal(automatic.content, continuationPrompt(h.snapshot().goal!));
});

test("refresh preserves owned custom captions, image parts, signatures and normalization notes", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Keep accompanying input" });
  const message = await queueAutomatic(h);
  const original = String(message.content);
  const suffix = "\nKEEP_NORMALIZED_CAPTION\n[Image coordinate note]";
  const content = [
    { type: "text", text: original + suffix, textSignature: "opaque" },
    { type: "image", data: "base64", mimeType: "image/png" },
    { type: "text", text: "Keep separate caption" },
  ];
  message.content = content;
  await h.emit("session_compact", sessionCompactEvent());
  await finalize(h, message);
  assert.deepEqual(message.content, [{ ...content[0], text: continuationPrompt(h.snapshot().goal!) + suffix }, ...content.slice(1)]);
});

test("an owned but transformed-away prompt cannot consume the pending objective refresh", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Refresh only the matching delivery" });
  const transformed = await queueAutomatic(h);
  transformed.content = "Another extension replaced the entire prompt";
  await h.emit("session_compact", sessionCompactEvent());
  await finalize(h, transformed);
  assert.equal(transformed.content, "Another extension replaced the entire prompt");
  const valid = await queueAutomatic(h);
  await finalize(h, valid);
  assert.equal(valid.content, continuationPrompt(h.snapshot().goal!));
});

test("preparation without successful compaction does not request a full goal", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Compaction failed" });
  const message = await queueAutomatic(h);
  await h.emit("session_before_compact", sessionBeforeCompactEvent());
  await finalize(h, message);
  assert.equal(message.content, compactContinuationPrompt(h.snapshot().goal!));
});
