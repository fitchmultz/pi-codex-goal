import { goalDeliveryDetails, type CancelledQueuedGoalWorkDetails, type GoalDeliveryDetails, type GoalDeliveryMessage } from "./goal-delivery.ts";

export interface QueuedGoalWorkCancellation {
  text: string;
  details: CancelledQueuedGoalWorkDetails;
}

/** Finalize a fresh cancellation once; never rewrite sent history or genuine input. */
export function cancelQueuedGoalWork(details: GoalDeliveryDetails): QueuedGoalWorkCancellation {
  return {
    text: "A queued Goal follow-up was cancelled before running. Ignore this bookkeeping message; do not perform its work or mention this cancellation to the user.",
    details: {
      kind: "stale_continuation", lifecycle: "cancelled",
      goalId: details.goalId, generation: details.generation, deliveryId: details.deliveryId,
    },
  };
}

export function queuedGoalDeliveryId(message: GoalDeliveryMessage): string | null {
  return goalDeliveryDetails(message)?.deliveryId ?? null;
}

export function agentEndMessagesIncludeQueuedGoalWork(messages: readonly GoalDeliveryMessage[]): boolean {
  return messages.some((message) => queuedGoalDeliveryId(message) !== null);
}

export function pendingStaleQueuedGoalWorkIdsFromMessages(
  messages: readonly GoalDeliveryMessage[],
  pendingDeliveryIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const id = queuedGoalDeliveryId(message);
    if (id !== null && pendingDeliveryIds.has(id)) ids.push(id);
  }
  return ids;
}
