import { randomUUID } from "node:crypto";
import { isRecord } from "./validation.ts";
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

export type GoalDeliveryDetails =
  | (Omit<ActiveGoalQueuedDetails, "objectiveRefresh"> & { objectiveRefresh?: unknown })
  | CancelledQueuedGoalWorkDetails;
export type GoalDeliveryMessage = { role: string; customType?: string; details?: unknown };

function deliveryIdentity(
  details: unknown,
): details is GoalDeliveryIdentity & Record<string, unknown> {
  return (
    isRecord(details) &&
    typeof details.goalId === "string" &&
    typeof details.generation === "string" &&
    typeof details.deliveryId === "string"
  );
}

function isGoalDeliveryDetails(details: unknown): details is GoalDeliveryDetails {
  if (!deliveryIdentity(details)) {
    return false;
  }
  if (details.kind === "stale_continuation") {
    return details.lifecycle === "cancelled";
  }
  return (
    (details.kind === "continuation" ||
      details.kind === "command_start" ||
      details.kind === "command_resume") &&
    (details.lifecycle === "queued" || details.lifecycle === "delivered")
  );
}

export function goalDeliveryDetails(message: GoalDeliveryMessage): GoalDeliveryDetails | null {
  return message.role === "custom" &&
    message.customType === CUSTOM_ENTRY_TYPE &&
    isGoalDeliveryDetails(message.details)
    ? message.details
    : null;
}

/** Own only deliveries this runtime enqueued in the current goal activation. */
export function createGoalDeliveries(
  pi: Pick<ExtensionAPI, "sendMessage">,
  getGoal: () => ThreadGoal | null,
): GoalDeliveries {
  return new DeliveryTracker(pi, getGoal);
}

class DeliveryTracker implements GoalDeliveries {
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly getGoal: () => ThreadGoal | null;
  constructor(pi: Pick<ExtensionAPI, "sendMessage">, getGoal: () => ThreadGoal | null) {
    this.pi = pi;
    this.getGoal = getGoal;
  }

  private generation = randomUUID();
  private readonly pending = new Map<
    string,
    { details: ActiveGoalQueuedDetails; prompt: string; started: boolean }
  >();

  invalidate = (): void => {
    this.generation = randomUUID();
    this.pending.clear();
  };

  send = (goal: ThreadGoal, kind: GoalDeliveryKind): void => {
    const details: ActiveGoalQueuedDetails = {
      kind,
      goalId: goal.goalId,
      generation: this.generation,
      deliveryId: randomUUID(),
      lifecycle: "queued",
    };
    const prompt =
      kind === "continuation" ? compactContinuationPrompt(goal) : continuationPrompt(goal);
    this.pending.set(details.deliveryId, { details, prompt, started: false });
    try {
      this.pi.sendMessage(
        { customType: CUSTOM_ENTRY_TYPE, content: prompt, display: false, details },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch (error) {
      this.pending.delete(details.deliveryId);
      throw error;
    }
  };

  private readonly matching = (details: GoalDeliveryDetails) => {
    const delivery = this.pending.get(details.deliveryId);
    return delivery?.details.goalId === details.goalId &&
      delivery.details.generation === details.generation &&
      delivery.details.kind === details.kind
      ? delivery
      : undefined;
  };

  private readonly current = (details: GoalDeliveryDetails) => {
    const goal = this.getGoal();
    const delivery = this.matching(details);
    return goal?.status === "active" &&
      goal.goalId === details.goalId &&
      details.generation === this.generation &&
      details.lifecycle === "queued"
      ? delivery
      : undefined;
  };

  start = (details: GoalDeliveryDetails): boolean => {
    const delivery = this.current(details);
    if (!delivery || delivery.started) {
      // A duplicate cannot become another runnable delivery, even before finalization.
      if (this.matching(details)) {
        this.pending.delete(details.deliveryId);
      }
      return false;
    }
    delivery.started = true;
    return true;
  };

  finish = (details: GoalDeliveryDetails): string | null => {
    const delivery = this.current(details);
    if (this.matching(details)) {
      this.pending.delete(details.deliveryId);
    }
    return delivery?.started === true ? delivery.prompt : null;
  };

  retireQueued = (): boolean => {
    let needsFullGoal = false;
    // agent_end closes the native run. Any owned delivery that never started
    // (for example discarded by native Alt+Up) cannot keep Goal wedged queued.
    for (const [id, delivery] of this.pending) {
      if (delivery.started) {
        continue;
      }
      needsFullGoal ||= delivery.details.kind !== "continuation";
      this.pending.delete(id);
    }
    return needsFullGoal;
  };
}

export interface GoalDeliveries {
  send: (goal: ThreadGoal, kind: GoalDeliveryKind) => void;
  start: (details: GoalDeliveryDetails) => boolean;
  finish: (details: GoalDeliveryDetails) => string | null;
  invalidate: () => void;
  retireQueued: () => boolean;
}
