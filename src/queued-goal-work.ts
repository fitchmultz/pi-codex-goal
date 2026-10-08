import { continuationGoalIdFromPrompt } from "./prompts.ts";
import {
  isActiveGoalQueuedDetails,
  type QueuedGoalContextInput,
  userContentFromUnknown,
} from "./queued-goal-messages.ts";
import { CUSTOM_ENTRY_TYPE, type GoalStatus, type ThreadGoal } from "./types.ts";

export interface CancelledQueuedGoalWorkDetails {
  kind: "stale_continuation";
  goalId: string;
  currentGoalId: string | null;
  currentStatus: GoalStatus | null;
}

export interface QueuedGoalWorkCancellation {
  text: string;
  details: CancelledQueuedGoalWorkDetails;
}

const CANCELLED_WORK_FIRST_LINE = "A queued hidden goal continuation was stale and has been cancelled before running.";
const CANCELLED_WORK_GOAL_ID = /^Queued goal id: (.+)\.$/m;

function cancelledQueuedGoalWorkGoalId(details: unknown): string | null {
  if (details === null || typeof details !== "object") {
    return null;
  }
  const candidate = details as { kind?: unknown; goalId?: unknown };
  return candidate.kind === "stale_continuation" && typeof candidate.goalId === "string" ? candidate.goalId : null;
}

function textContentFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  const parts = userContentFromUnknown(content);
  if (parts.length === 0) {
    return null;
  }

  return parts.map((part) => part.text).join("\n");
}

function continuationGoalIdFromMessageContent(content: unknown): string | null {
  const text = textContentFromMessageContent(content);
  return text === null ? null : continuationGoalIdFromPrompt(text);
}

/** Goal id of a user message that was cancelled at delivery, which has no details to carry it. */
function cancelledGoalIdFromMessageContent(content: unknown): string | null {
  const text = textContentFromMessageContent(content);
  if (text === null || !text.startsWith(CANCELLED_WORK_FIRST_LINE)) {
    return null;
  }
  return CANCELLED_WORK_GOAL_ID.exec(text)?.[1] ?? null;
}

function staleGoalContinuationMessage(queuedGoalId: string, currentGoal: ThreadGoal | null): string {
  const currentState = currentGoal
    ? `Current goal id: ${currentGoal.goalId}; current status: ${currentGoal.status}.`
    : "There is no current goal.";
  return [
    CANCELLED_WORK_FIRST_LINE,
    `Queued goal id: ${queuedGoalId}.`,
    currentState,
    "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
  ].join("\n");
}

function extensionQueuedGoalWorkMessageId(message: QueuedGoalContextInput): string | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }

  if (isActiveGoalQueuedDetails(message.details)) {
    return message.details.goalId;
  }

  return cancelledQueuedGoalWorkGoalId(message.details) ?? continuationGoalIdFromMessageContent(message.content);
}

function queuedGoalWorkMessageId(message: QueuedGoalContextInput): string | null {
  if (message.role === "user") {
    return continuationGoalIdFromMessageContent(message.content) ?? cancelledGoalIdFromMessageContent(message.content);
  }

  return extensionQueuedGoalWorkMessageId(message);
}

/**
 * Text and details that replace queued goal work delivered after its goal stopped being active, or
 * null when the message is already cancelled.
 *
 * Pi persists a `message_end` replacement in place of the delivered message, so the transcript
 * records the cancellation once and every later provider request resends it unchanged. Deciding
 * this from the current goal on each request instead rewrites history the provider has cached.
 */
export function cancelQueuedGoalWork(
  message: QueuedGoalContextInput,
  queuedGoalId: string,
  currentGoal: ThreadGoal | null,
): QueuedGoalWorkCancellation | null {
  const alreadyCancelled =
    message.role === "custom"
      ? cancelledQueuedGoalWorkGoalId(message.details) !== null
      : cancelledGoalIdFromMessageContent(message.content) !== null;
  if (alreadyCancelled) {
    return null;
  }

  return {
    text: staleGoalContinuationMessage(queuedGoalId, currentGoal),
    details: {
      kind: "stale_continuation",
      goalId: queuedGoalId,
      currentGoalId: currentGoal?.goalId ?? null,
      currentStatus: currentGoal?.status ?? null,
    },
  };
}

export function extensionQueuedGoalWorkMessageIdForRuntime(
  message: QueuedGoalContextInput,
  resolveContinuationGoalIdFromPrompt: (prompt: string) => string | null,
): string | null {
  if (message.role === "user") {
    const text = textContentFromMessageContent(message.content);
    return text === null ? null : resolveContinuationGoalIdFromPrompt(text);
  }

  return queuedGoalWorkMessageId(message);
}

export function agentEndMessagesIncludeQueuedGoalWork(
  messages: readonly QueuedGoalContextInput[],
): boolean {
  return messages.some((message) => queuedGoalWorkMessageId(message) !== null);
}

export function pendingStaleQueuedGoalWorkIdsFromMessages(
  messages: readonly QueuedGoalContextInput[],
  staleQueuedGoalWorkAgentEndGoalIds: ReadonlySet<string>,
): string[] {
  const goalIds: string[] = [];
  for (const message of messages) {
    const queuedGoalId = queuedGoalWorkMessageId(message);
    if (queuedGoalId !== null && staleQueuedGoalWorkAgentEndGoalIds.has(queuedGoalId)) {
      goalIds.push(queuedGoalId);
    }
  }
  return goalIds;
}
