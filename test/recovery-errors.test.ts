import assert from "node:assert/strict";
import { test } from "node:test";

import { formatFooterStatus } from "../src/format.js";
import {
  HOST_OVERFLOW_RECOVERY_REASON,
  recoveryAttentionMessage,
  recoveryPendingAttentionMessage,
} from "../src/recovery.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitHostSessionCompact,
  emitPersistentAssistantError,
  emitSilentContextOverflow,
} from "./support/runtime-harness.js";

test("non-retryable provider errors pause active goals immediately", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

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
      recoveryAttentionMessage("non-retryable provider error (invalid tool call state: malformed function arguments)"),
    ),
  );
});

test("non-retryable provider error pause does not cancel host compaction", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );

  assert.equal(harness.snapshot().goal?.status, "paused");

  const compaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(compaction[0], { cancel: true });
});

test("varied retryable transient errors stay active without tripping signature-scoped cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errors = [
    "HTTP 500 internal server error",
    "HTTP 502 bad gateway",
    "HTTP 503 service unavailable",
    "HTTP 504 gateway timeout",
  ];

  for (let attempt = 0; attempt < errors.length; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, errors[attempt]!);
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  assert.equal(harness.sentMessages.length, 0);
});

test("silent stop overflow suppresses continuation and shows overflow recovery attention", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
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
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
});

test("zero-output length overflow suppresses continuation and shows overflow recovery attention", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;

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
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
});

test("threshold session_compact after transient provider error preserves pending attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "threshold compact",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      recoveryPendingAttentionMessage("provider error (websocket closed)"),
    ),
  );
});

test("repeated silent stop overflow after host compaction pauses without blocking manual compaction", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const firstOverflow = assistantMessage("stop", {
    input: 130_000,
    output: 0,
    cacheRead: 0,
  });
  await emitSilentContextOverflow(harness, 0, firstOverflow);

  const firstCompaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(firstCompaction[0], { cancel: true });
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

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

  const manualCompaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(manualCompaction[0], { cancel: true });
  assert.equal(harness.sentMessages.length, 0);
});

test("repeated zero-output length overflow after host compaction pauses without blocking manual compaction", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

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

  const manualCompaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(manualCompaction[0], { cancel: true });
});
