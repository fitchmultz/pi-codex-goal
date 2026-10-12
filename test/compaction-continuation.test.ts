import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  createRuntimeHarness,
  userBeforeAgentStartEvent,
  flushContinuationScheduler,
  sessionCompactEvent,
  type RuntimeHarness,
} from "./support/runtime-harness.ts";

async function startQueuedContinuation(harness: RuntimeHarness): Promise<void> {
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  harness.sentMessages.length = 0;

  await harness.emit("before_agent_start", userBeforeAgentStartEvent(String(queued.message.content)));
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
    await harness.emit("before_agent_start", userBeforeAgentStartEvent("preflight that never starts an agent run"));

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
