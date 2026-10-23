import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { compactContinuationPrompt, continuationPrompt } from "./prompts.ts";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.ts";

export type GoalDeliveryKind = "continuation" | "command_start" | "command_resume";

export interface GoalDeliveryIdentity {
  goalId: string;
  generation: string;
  deliveryId: string;
}

export interface ActiveGoalQueuedDetails extends GoalDeliveryIdentity {
  kind: GoalDeliveryKind;
  lifecycle: "queued" | "delivered";
  objectiveRefresh?: true;
}

export interface CancelledQueuedGoalWorkDetails extends GoalDeliveryIdentity {
  kind: "stale_continuation";
  lifecycle: "cancelled";
}

export type GoalDeliveryDetails = ActiveGoalQueuedDetails | CancelledQueuedGoalWorkDetails;
export type GoalDeliveryMessage = { role: string; customType?: string; details?: unknown };

export function goalDeliveryDetails(message: GoalDeliveryMessage): GoalDeliveryDetails | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE ||
      !message.details || typeof message.details !== "object") return null;
  const details = message.details as Partial<GoalDeliveryDetails>;
  if (typeof details.goalId !== "string" || typeof details.generation !== "string" ||
      typeof details.deliveryId !== "string") return null;
  if (details.kind === "stale_continuation" && details.lifecycle === "cancelled") {
    return details as CancelledQueuedGoalWorkDetails;
  }
  if ((details.kind === "continuation" || details.kind === "command_start" || details.kind === "command_resume") &&
      (details.lifecycle === "queued" || details.lifecycle === "delivered")) {
    return details as ActiveGoalQueuedDetails;
  }
  return null;
}

/** Own only deliveries this runtime actually enqueued in the current goal activation. */
export function createGoalDeliveries(
  pi: Pick<ExtensionAPI, "sendMessage">,
  getGoal: () => ThreadGoal | null,
) {
  let generation = randomUUID();
  const pending = new Map<string, { details: ActiveGoalQueuedDetails; prompt: string; started: boolean }>();

  const invalidate = (): void => {
    generation = randomUUID();
    pending.clear();
  };

  const send = (goal: ThreadGoal, kind: GoalDeliveryKind): void => {
    const details: ActiveGoalQueuedDetails = {
      kind, goalId: goal.goalId, generation, deliveryId: randomUUID(), lifecycle: "queued",
    };
    const prompt = kind === "continuation" ? compactContinuationPrompt(goal) : continuationPrompt(goal);
    pending.set(details.deliveryId, { details, prompt, started: false });
    try {
      pi.sendMessage({ customType: CUSTOM_ENTRY_TYPE, content: prompt, display: false, details },
        { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      pending.delete(details.deliveryId);
      throw error;
    }
  };

  const matching = (details: GoalDeliveryDetails) => {
    const delivery = pending.get(details.deliveryId);
    return delivery?.details.goalId === details.goalId && delivery.details.generation === details.generation &&
      delivery.details.kind === details.kind ? delivery : undefined;
  };

  const current = (details: GoalDeliveryDetails) => {
    const goal = getGoal();
    const delivery = matching(details);
    return goal?.status === "active" && goal.goalId === details.goalId &&
      details.generation === generation && details.lifecycle === "queued" ? delivery : undefined;
  };

  const start = (details: GoalDeliveryDetails): boolean => {
    const delivery = current(details);
    if (!delivery || delivery.started) {
      // A duplicate cannot become another runnable delivery, even before finalization.
      if (matching(details)) pending.delete(details.deliveryId);
      return false;
    }
    delivery.started = true;
    return true;
  };

  const finish = (details: GoalDeliveryDetails): string | null => {
    const delivery = current(details);
    if (matching(details)) pending.delete(details.deliveryId);
    return delivery?.started ? delivery.prompt : null;
  };

  const retireQueued = (): boolean => {
    let needsFullGoal = false;
    // agent_end closes the native run. Any owned delivery that never started
    // (for example discarded by native Alt+Up) cannot keep Goal wedged queued.
    for (const [id, delivery] of pending) {
      if (delivery.started) continue;
      needsFullGoal ||= delivery.details.kind !== "continuation";
      pending.delete(id);
    }
    return needsFullGoal;
  };

  return { send, start, finish, invalidate, retireQueued };
}

export type GoalDeliveries = ReturnType<typeof createGoalDeliveries>;
