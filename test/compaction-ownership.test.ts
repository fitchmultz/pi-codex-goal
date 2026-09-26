import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  assistantMessage,
  createRuntimeHarness,
  flushContinuationScheduler,
  sessionBeforeCompactEvent,
  sessionCompactEvent,
  type RuntimeHarness,
} from "./support/runtime-harness.ts";

function contextUsage(tokens: number) {
  return {
    source: "reported" as const,
    tokens,
    contextWindow: 272_000,
    percent: (tokens / 272_000) * 100,
  };
}

async function emitToolUseTurnEnd(harness: RuntimeHarness, turnIndex: number): Promise<void> {
  await harness.emit("turn_start", {
    type: "turn_start",
    turnIndex,
    timestamp: turnIndex + 1,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message: assistantMessage("toolUse", { input: 10, output: 2 }),
    toolResults: [],
  });
}

async function startGoal(harness: RuntimeHarness): Promise<void> {
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: String(queued.message.content),
    systemPrompt: "",
    systemPromptOptions: {},
  });
}

test("Pi owns compaction decisions at the configured host threshold", async () => {
  const harness = createRuntimeHarness({
    contextUsage: contextUsage(247_783),
    compactBehavior: "error",
  });
  await startGoal(harness);

  await emitToolUseTurnEnd(harness, 0);

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("host compaction resumes once without a competing extension compaction", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({
      contextUsage: contextUsage(287_256),
      compactBehavior: "error",
    });
    await startGoal(harness);

    await emitToolUseTurnEnd(harness, 0);
    await harness.emit(
      "session_before_compact",
      sessionBeforeCompactEvent({ reason: "threshold" }),
    );
    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));

    // A late pre-compaction result/usage snapshot must not start a second owner.
    await emitToolUseTurnEnd(harness, 1);
    flushContinuationScheduler();

    assert.equal(harness.compactCalls.length, 0);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("host overflow retry cannot race an extension compaction", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({
      contextUsage: contextUsage(287_256),
      compactBehavior: "error",
    });
    await startGoal(harness);

    await emitToolUseTurnEnd(harness, 0);
    await harness.emit(
      "session_before_compact",
      sessionBeforeCompactEvent({ reason: "overflow", willRetry: true }),
    );
    await harness.emit(
      "session_compact",
      sessionCompactEvent({ reason: "overflow", willRetry: true }),
    );
    await harness.emit("agent_start", { type: "agent_start" });
    flushContinuationScheduler();

    assert.equal(harness.compactCalls.length, 0);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});
