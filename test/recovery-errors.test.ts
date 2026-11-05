import assert from "node:assert/strict";
import { mock, test as nodeTest } from "node:test";

import { formatFooterStatus } from "../src/format.ts";
import {
  createRecoveryPausedAttention,
  createRecoveryPendingAttention,
  HOST_OVERFLOW_RECOVERY_REASON,
} from "../src/recovery.ts";
import {
  assistantMessage,
  createRuntimeHarness,
  emitHostSessionCompact,
  emitPersistentAssistantError,
  emitSilentContextOverflow,
  flushContinuationScheduler,
  sessionBeforeCompactEvent,
  sessionCompactEvent,
} from "./support/runtime-harness.ts";

nodeTest("non-retryable provider errors pause active goals immediately", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.clearSentMessages();

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      createRecoveryPausedAttention(
        "non-retryable provider error (invalid tool call state: malformed function arguments)",
      ),
    ),
  );
});

nodeTest("terminal provider-limit 429 errors pause active goals immediately", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.clearSentMessages();

  await emitPersistentAssistantError(harness, 0, "insufficient_quota 429");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      createRecoveryPausedAttention("non-retryable provider error (insufficient_quota 429)"),
      true,
    ),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

nodeTest("non-retryable provider error pause does not cancel host compaction", async () => {
  const harness = await createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.clearSentMessages();

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );

  assert.equal(harness.snapshot().goal?.status, "paused");

  const compaction = await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  assert.notDeepEqual(compaction[0], { cancel: true });
});

nodeTest(
  "varied retryable transient errors stay active without tripping signature-scoped cap",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    const errors = [
      "HTTP 500 internal server error",
      "HTTP 502 bad gateway",
      "HTTP 503 service unavailable",
      "HTTP 504 gateway timeout",
    ];

    for (const [attempt, error] of errors.entries()) {
      await emitPersistentAssistantError(harness, attempt, error);
      assert.equal(harness.snapshot().goal?.status, "active");
    }

    assert.equal(harness.sentMessages.length, 0);
  },
);

nodeTest(
  "upstream request-buffer retry exhaustion stays active with pending recovery",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    await emitPersistentAssistantError(
      harness,
      0,
      "exceeded request buffer limit while retrying upstream",
    );

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(
      harness.footerStatuses.at(-1),
      formatFooterStatus(
        harness.snapshot().goal,
        createRecoveryPendingAttention(
          "provider error (exceeded request buffer limit while retrying upstream)",
        ),
      ),
    );
    assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
  },
);

nodeTest(
  "silent stop overflow suppresses continuation and shows overflow recovery attention",
  async () => {
    const harness = await createRuntimeHarness({ contextWindow: 128_000 });
    await harness.runCommand("ship it");
    const goal = harness.snapshot().goal;
    assert.ok(goal);
    harness.clearSentMessages();
    harness.footerStatuses.length = 0;

    const overflowMessage = assistantMessage("stop", {
      input: 130_000,
      output: 0,
      cacheRead: 0,
    });
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: overflowMessage,
      toolResults: [],
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [overflowMessage],
    });

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(
      harness.footerStatuses.at(-1),
      formatFooterStatus(goal, createRecoveryPendingAttention(HOST_OVERFLOW_RECOVERY_REASON)),
    );
  },
);

nodeTest(
  "zero-output length overflow suppresses continuation and shows overflow recovery attention",
  async () => {
    const harness = await createRuntimeHarness({ contextWindow: 128_000 });
    await harness.runCommand("ship it");
    const goal = harness.snapshot().goal;
    assert.ok(goal);
    harness.clearSentMessages();

    const overflowMessage = assistantMessage("length", {
      input: 127_000,
      output: 0,
      cacheRead: 1_000,
    });
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: overflowMessage,
      toolResults: [],
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [overflowMessage],
    });

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(
      harness.footerStatuses.at(-1),
      formatFooterStatus(goal, createRecoveryPendingAttention(HOST_OVERFLOW_RECOVERY_REASON)),
    );
  },
);

nodeTest("host overflow compaction fallback does not duplicate a host retry turn", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    await emitPersistentAssistantError(
      harness,
      0,
      'Codex error: {"error":{"code":"context_length_exceeded"}}',
    );
    await emitHostSessionCompact(harness);
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });

    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

nodeTest(
  "threshold session_compact after transient provider error preserves pending attention",
  async () => {
    const harness = await createRuntimeHarness();
    await harness.runCommand("ship it");
    const goal = harness.snapshot().goal;
    assert.ok(goal);
    harness.clearSentMessages();
    harness.footerStatuses.length = 0;

    await emitPersistentAssistantError(harness, 0, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit(
      "session_compact",
      sessionCompactEvent({ reason: "threshold", summary: "threshold compact" }),
    );

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(
      harness.footerStatuses.at(-1),
      formatFooterStatus(
        harness.snapshot().goal,
        createRecoveryPendingAttention("provider error (websocket closed)"),
      ),
    );
  },
);

nodeTest(
  "repeated silent stop overflow after host compaction pauses without blocking manual compaction",
  async () => {
    const harness = await createRuntimeHarness({ contextWindow: 128_000 });
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    const firstOverflow = assistantMessage("stop", {
      input: 130_000,
      output: 0,
      cacheRead: 0,
    });
    await emitSilentContextOverflow(harness, 0, firstOverflow);

    const firstCompaction = await harness.emit(
      "session_before_compact",
      sessionBeforeCompactEvent({ reason: "overflow" }),
    );
    assert.notDeepEqual(firstCompaction[0], { cancel: true });
    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow" }));

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    const secondOverflow = assistantMessage("stop", {
      input: 131_000,
      output: 0,
      cacheRead: 0,
    });
    await emitSilentContextOverflow(harness, 1, secondOverflow);

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.footerStatuses.at(-1) ?? "", /Goal needs attention/);

    const manualCompaction = await harness.emit(
      "session_before_compact",
      sessionBeforeCompactEvent(),
    );
    assert.notDeepEqual(manualCompaction[0], { cancel: true });
    assert.equal(harness.sentMessages.length, 0);
  },
);

nodeTest(
  "repeated zero-output length overflow after host compaction pauses without blocking manual compaction",
  async () => {
    const harness = await createRuntimeHarness({ contextWindow: 128_000 });
    await harness.runCommand("ship it");
    harness.clearSentMessages();

    const firstOverflow = assistantMessage("length", {
      input: 127_000,
      output: 0,
      cacheRead: 1_000,
    });
    await emitSilentContextOverflow(harness, 0, firstOverflow);
    await emitHostSessionCompact(harness);

    assert.equal(harness.snapshot().goal?.status, "active");

    const secondOverflow = assistantMessage("length", {
      input: 128_000,
      output: 0,
      cacheRead: 1_000,
    });
    await emitSilentContextOverflow(harness, 1, secondOverflow);

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentMessages.length, 0);

    const manualCompaction = await harness.emit(
      "session_before_compact",
      sessionBeforeCompactEvent(),
    );
    assert.notDeepEqual(manualCompaction[0], { cancel: true });
  },
);
