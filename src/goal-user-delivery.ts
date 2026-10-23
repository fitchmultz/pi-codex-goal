import { randomUUID } from "node:crypto";
import type { InputEvent, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import type { MessageEndEvent } from "./goal-runtime-event-handler-types.ts";
import { continuationGoalIdFromPrompt } from "./prompts.ts";

type Message = MessageEndEvent["message"];

// Input transforms have text/images, but no metadata or queue-discard callback on Pi 1.0.
// Carry ownership in the delivery itself, not a text lookup or a parallel pending queue.
// Only extension-source Goal controls receive this transport header. Re-entering queued
// text through input removes its old header before the NEW source decides ownership.
const DELIVERY_HEADER = /^<pi_goal_delivery id="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}">\n/;
const finalizedGoalIds = new WeakMap<object, string>();

function unpack(text: string): { text: string; tagged: boolean } {
  const header = DELIVERY_HEADER.exec(text);
  return header ? { text: text.slice(header[0].length), tagged: true } : { text, tagged: false };
}

export function prepareGoalUserInput(event: InputEvent): { text: string; goalId: string | null } {
  const { text } = unpack(event.text);
  const goalId = event.source === "extension" ? continuationGoalIdFromPrompt(text) : null;
  return { text: goalId === null ? text : `<pi_goal_delivery id="${randomUUID()}">\n${text}`, goalId };
}

export function goalIdFromDeliveryPrompt(text: string): string | null {
  const delivery = unpack(text);
  return delivery.tagged ? continuationGoalIdFromPrompt(delivery.text) : null;
}

export function finalizedGoalUserMessageId(message: object): string | null {
  return finalizedGoalIds.get(message) ?? null;
}

/**
 * Strip transport data before Pi persists/sends the finalized USER message. The callback
 * changes only Goal's control envelope; normalization's captions, images and notes survive.
 * Pi's finalized lifecycle retains the delivered message object (including at agent_end).
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
    finalizedGoalIds.set(message, goalId);
    if (result.message) finalizedGoalIds.set(result.message, goalId);
  }
  return result;
}
