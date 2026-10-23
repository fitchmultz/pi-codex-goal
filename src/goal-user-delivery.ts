import { randomUUID } from "node:crypto";
import type { InputEvent, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import type { MessageEndEvent } from "./goal-runtime-event-handler-types.ts";
import { continuationGoalIdFromPrompt } from "./prompts.ts";

type Message = MessageEndEvent["message"];

// Input transforms have text/images, but no metadata or queue-discard callback on Pi 1.0.
// Carry ownership in the delivery itself, not a text lookup or a parallel pending queue.
// Only extension-source Goal controls receive this transport header. Re-entering queued
// text through input removes its old headers before the NEW source decides ownership.
const DELIVERY_HEADER_LINE = /<pi_goal_delivery id="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}">/;
const DELIVERY_HEADER = new RegExp(`^${DELIVERY_HEADER_LINE.source}\\n`);
const REENTRY_DELIVERY_HEADERS = new RegExp(`^${DELIVERY_HEADER_LINE.source}(?:\\n|$)`, "gm");
const deliveryGoalIds = new WeakMap<object, string>();

function unpack(text: string): { text: string; tagged: boolean } {
  const header = DELIVERY_HEADER.exec(text);
  return header ? { text: text.slice(header[0].length), tagged: true } : { text, tagged: false };
}

export function prepareGoalUserInput(event: InputEvent): { text: string; goalId: string | null } {
  // Pi restores multiple queued messages into one editor value. Headers can now
  // be in the middle; removing them is cleanup, not evidence of ownership.
  const text = event.text.replace(REENTRY_DELIVERY_HEADERS, "");
  const goalId = event.source === "extension" ? continuationGoalIdFromPrompt(text) : null;
  return { text: goalId === null ? text : `<pi_goal_delivery id="${randomUUID()}">\n${text}`, goalId };
}

export function goalIdFromDeliveryPrompt(text: string): string | null {
  const delivery = unpack(text);
  return delivery.tagged ? continuationGoalIdFromPrompt(delivery.text) : null;
}

/** Bind the native delivery before chained message_end handlers can pass copies. */
export function noteGoalUserDeliveryStarted(message: Message): void {
  if (message.role !== "user") return;
  const text = typeof message.content === "string" ? message.content
    : message.content.find((part) => part.type === "text")?.text;
  const goalId = text === undefined ? null : goalIdFromDeliveryPrompt(text);
  if (goalId !== null) deliveryGoalIds.set(message, goalId);
}

export function finalizedGoalUserMessageId(message: object): string | null {
  return deliveryGoalIds.get(message) ?? null;
}

/**
 * Strip transport data before Pi persists/sends the finalized USER message. The callback
 * changes only Goal's control envelope; normalization's captions, images and notes survive.
 * Pi retains the original message_start object at agent_end and in persistence, even if
 * an earlier message_end handler gives us a copy. Its ownership was bound at message_start.
 * Keep that identity out of serialized content. Discarded inputs need no cleanup: no pending
 * record exists, and finalized records are weakly held for the message's own lifetime.
 */
export function finalizeGoalUserDelivery(
  message: Message,
  rewrite: (message: Message, goalId: string) => MessageEndEventResult | undefined,
): MessageEndEventResult | undefined {
  if (message.role !== "user") return undefined;
  const text = typeof message.content === "string" ? message.content
    : message.content.find((part) => part.type === "text")?.text;
  if (text === undefined) return undefined;
  const delivery = unpack(text);
  if (!delivery.tagged) return undefined;
  const goalId = continuationGoalIdFromPrompt(delivery.text);
  const firstText = typeof message.content === "string" ? -1 : message.content.findIndex((part) => part.type === "text");
  const content = typeof message.content === "string" ? delivery.text
    : message.content.map((part, index) => index === firstText
      ? { ...part, type: "text" as const, text: delivery.text } : part);
  const clean = { ...message, content };
  const result = (goalId === null ? undefined : rewrite(clean, goalId)) ?? { message: clean };
  if (goalId !== null) {
    deliveryGoalIds.set(message, goalId);
    if (result.message) deliveryGoalIds.set(result.message, goalId);
  }
  return result;
}
