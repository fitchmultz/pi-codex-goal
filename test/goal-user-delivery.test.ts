import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { finalizeGoalUserDelivery, goalIdFromDeliveryPrompt, prepareGoalUserInput } from "../src/goal-user-delivery.ts";
import { agentEndMessagesIncludeQueuedGoalWork, cancelQueuedGoalWork, extensionQueuedGoalWorkMessageIdForRuntime } from "../src/queued-goal-work.ts";

const control = '<pi_goal_continuation goal_id="goal">\nWork\n</pi_goal_continuation>';
const input = (text: string, source: "extension" | "interactive" | "rpc") => prepareGoalUserInput({ type: "input", text, source });
const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

test("ownership belongs to each extension delivery, never to identical genuine text", () => {
  const first = input(control, "extension"), second = input(control, "extension");
  assert.notEqual(first.text, second.text);
  assert.equal(goalIdFromDeliveryPrompt(first.text), "goal");
  assert.equal(goalIdFromDeliveryPrompt(second.text), "goal");
  for (const source of ["interactive", "rpc"] as const) {
    assert.deepEqual(input(control, source), { text: control, goalId: null });
    assert.deepEqual(input(first.text, source), { text: control, goalId: null }, "re-entered queue text gets the new source, not the old delivery's ownership");
  }
  const resubmitted = input(first.text, "extension");
  assert.notEqual(resubmitted.text, first.text);
  assert.equal(resubmitted.goalId, "goal");
  assert.equal(extensionQueuedGoalWorkMessageIdForRuntime(user(control)), null);
  assert.deepEqual(input("An external extension result", "extension"), { text: "An external extension result", goalId: null });
});

test("finalization owns marker removal and retains identity only for the actual finalized message", () => {
  const prepared = input(control, "extension");
  const suffix = "\nCaption\n\n[Image: original 3000x8, displayed at 2000x5]";
  const image = { type: "image" as const, data: "image", mimeType: "image/png" };
  const message: UserMessage = { ...user(prepared.text + suffix), content: [{ type: "text", text: prepared.text + suffix }, image] };
  const result = finalizeGoalUserDelivery(message, (clean, goalId) => {
    assert.equal(goalId, "goal");
    assert.ok(clean.role === "user");
    assert.deepEqual(clean.content, [{ type: "text", text: control + suffix }, image]);
    return undefined;
  });
  assert.ok(result?.message);
  assert.doesNotMatch(JSON.stringify(result.message), /pi_goal_delivery/);
  assert.equal(agentEndMessagesIncludeQueuedGoalWork([message]), true);
  assert.equal(agentEndMessagesIncludeQueuedGoalWork([result.message]), true);
  assert.equal(agentEndMessagesIncludeQueuedGoalWork([structuredClone(result.message)]), false, "text and timestamp copies do not transfer identity");
  assert.equal(extensionQueuedGoalWorkMessageIdForRuntime(user(control + suffix)), null);
});

test("cancelled delivery identity does not attach to a genuine copy of its cancellation text", () => {
  const message = user(input(control, "extension").text);
  const result = finalizeGoalUserDelivery(message, (clean, goalId) => {
    assert.ok(clean.role === "user");
    const cancellation = cancelQueuedGoalWork(clean, goalId, null);
    assert.ok(cancellation);
    return { message: { ...clean, content: cancellation.text } };
  });
  assert.ok(result?.message?.role === "user");
  assert.equal(typeof result.message.content, "string");
  assert.equal(extensionQueuedGoalWorkMessageIdForRuntime(message), "goal");
  assert.equal(extensionQueuedGoalWorkMessageIdForRuntime(result.message), "goal");
  assert.equal(agentEndMessagesIncludeQueuedGoalWork([user(String(result.message.content))]), false);
});

test("discarding an input cannot leave a slot for another delivery to consume", () => {
  const discarded = input(control, "extension");
  for (let index = 0; index < 5; index++) input(control, "interactive");
  const later = input(control, "extension");
  assert.notEqual(later.text, discarded.text);
  assert.equal(goalIdFromDeliveryPrompt(later.text), "goal");
  assert.deepEqual(input(discarded.text, "interactive"), { text: control, goalId: null });
  assert.equal(finalizeGoalUserDelivery(user(control), () => assert.fail("genuine input must not be rewritten")), undefined);
});
