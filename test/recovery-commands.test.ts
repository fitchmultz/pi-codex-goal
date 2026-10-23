import assert from "node:assert/strict";
import { test } from "node:test";

import { reconstructHostOverflowCapNeedsUserReset } from "../src/state.ts";
import { createRuntimeHarness, emitPersistentAssistantError, queuedCustomMessage, emitQueuedTurnThroughContext } from "./support/runtime-harness.ts";
import { givenOverflowPausedGoal } from "./support/scenarios.ts";

test("/goal resume after non-retryable pause resets recovery counters", async () => {
  const h = createRuntimeHarness();
  await h.runCommand("ship it");
  await emitPersistentAssistantError(h, 0, "invalid tool call state: malformed function arguments");
  assert.equal(h.snapshot().goal?.status, "paused");
  h.sentMessages.length = 0;
  await h.runCommand("resume");
  const queued = h.sentMessages[0];
  assert.ok(queued);
  await emitQueuedTurnThroughContext(h, [queuedCustomMessage(queued)]);
  await emitPersistentAssistantError(h, 1, "websocket closed");
  assert.equal(h.snapshot().goal?.status, "active");
  assert.match(h.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

for (const action of ["resume", "replace", "clear-replace", "reload-resume", "before-goal"] as const) {
  test(`overflow persistence cannot manufacture a genuine user reset through ${action}`, async () => {
    const h = action === "before-goal" ? createRuntimeHarness() : (await givenOverflowPausedGoal()).harness;
    if (action === "before-goal") await emitPersistentAssistantError(h, 0, "context_length_exceeded");
    if (action === "reload-resume") await h.reloadSession();
    if (action === "clear-replace") await h.runCommand("clear");
    h.sentMessages.length = 0;
    h.sentUserMessages.length = 0;
    await h.runCommand(action === "resume" || action === "reload-resume" ? "resume" : "Replacement objective");
    assert.equal(h.snapshot().goal?.status, "paused");
    assert.equal(reconstructHostOverflowCapNeedsUserReset(h.entries), true);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
    assert.match(h.footerStatuses.at(-1) ?? "", /genuine user message/);

    // Genuine native user delivery, not command text or automation, clears the persisted requirement.
    await h.emit("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "I reduced the context. Continue." }], timestamp: 1 } });
    assert.equal(reconstructHostOverflowCapNeedsUserReset(h.entries), false);
    await h.runCommand("resume");
    assert.equal(h.snapshot().goal?.status, "active");
    assert.equal(h.sentUserMessages.length, 0);
    assert.equal(h.sentMessages.length, 1);
    assert.equal(h.sentMessages[0]?.message.customType, "pi-codex-goal");
  });
}
