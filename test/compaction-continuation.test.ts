import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  assistantMessage,
  createRuntimeHarness,
  emitSilentContextOverflow,
  flushContinuationScheduler,
  sessionCompactEvent,
  type RuntimeHarness,
} from "./support/runtime-harness.js";

async function startQueuedContinuation(harness: RuntimeHarness): Promise<void> {
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

test("willRetry session compaction falls back after grace when host retry never starts", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startQueuedContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("willRetry session compaction fallback keeps polling while session is busy", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false });
    await startQueuedContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));

    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 0);

    harness.setIdle(true);
    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("willRetry session compaction fallback survives preflight without an agent start", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startQueuedContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "preflight that never starts an agent run",
      systemPrompt: "",
      systemPromptOptions: {},
    });

    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("willRetry session compaction fallback is cancelled when host retry starts", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startQueuedContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));
    await harness.emit("agent_start", { type: "agent_start" });

    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("settled host retry without continuation resumes the active goal", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startQueuedContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));
    await harness.emit("agent_start", { type: "agent_start" });
    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("agent_settled", { type: "agent_settled" });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("successful overflow compaction resumes the active goal when the host settles", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ contextWindow: 128_000 });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitSilentContextOverflow(
      harness,
      0,
      assistantMessage("stop", { input: 130_000, output: 0, cacheRead: 0 }),
    );
    await harness.emit(
      "session_compact",
      sessionCompactEvent({ reason: "overflow", willRetry: false }),
    );

    assert.equal(harness.sentMessages.length, 0);
    await harness.emit("agent_settled", { type: "agent_settled" });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("agent_settled does not duplicate a post-compaction timer continuation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ contextWindow: 128_000 });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitSilentContextOverflow(
      harness,
      0,
      assistantMessage("stop", { input: 130_000, output: 0, cacheRead: 0 }),
    );
    await harness.emit(
      "session_compact",
      sessionCompactEvent({ reason: "overflow", willRetry: false }),
    );

    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 1);

    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("agent_settled does not duplicate continuation from a completed host retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startQueuedContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 1, output: 1 })],
    });

    assert.equal(harness.sentMessages.length, 1);
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});
