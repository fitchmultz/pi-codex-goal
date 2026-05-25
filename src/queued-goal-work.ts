import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  supersededContinuationMessage,
} from "./prompts.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";

interface QueuedGoalMessageDetails {
  kind?: unknown;
  goalId?: unknown;
}

interface TextMessagePart {
  type?: unknown;
  text?: unknown;
}

function isQueuedGoalMessageDetails(details: unknown): details is QueuedGoalMessageDetails {
  return details !== null && typeof details === "object";
}

function isSupersededContinuationDetails(details: unknown): boolean {
  return isQueuedGoalMessageDetails(details) && details.kind === "superseded_continuation";
}

function isQueuedGoalWorkKind(kind: unknown): boolean {
  return kind === "continuation" || kind === "command_start" || kind === "command_resume";
}

function textContentFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const textPart = part as TextMessagePart;
    if (textPart.type === "text" && typeof textPart.text === "string") {
      textParts.push(textPart.text);
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : null;
}

function continuationGoalIdFromMessageContent(content: unknown): string | null {
  const text = textContentFromMessageContent(content);
  return text === null ? null : continuationGoalIdFromPrompt(text);
}

function staleGoalContinuationMessage(queuedGoalId: string, currentGoal: ThreadGoal | null): string {
  const currentState = currentGoal
    ? `Current goal id: ${currentGoal.goalId}; current status: ${currentGoal.status}.`
    : "There is no current goal.";
  return [
    "A queued hidden goal continuation was stale and has been cancelled before running.",
    `Queued goal id: ${queuedGoalId}.`,
    currentState,
    "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
  ].join("\n");
}

export function extensionQueuedGoalWorkMessageId(message: {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
}): string | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }

  if (isSupersededContinuationDetails(message.details)) {
    return null;
  }

  if (isQueuedGoalMessageDetails(message.details)) {
    const { kind, goalId } = message.details;
    if (isQueuedGoalWorkKind(kind) && typeof goalId === "string") {
      return goalId;
    }
  }

  return continuationGoalIdFromMessageContent(message.content);
}

export function queuedGoalWorkMessageId(message: {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
}): string | null {
  if (message.role === "user") {
    return continuationGoalIdFromMessageContent(message.content);
  }

  return extensionQueuedGoalWorkMessageId(message);
}

function supersededContinuationContextMessage<TMessage extends { role: string; content?: unknown; display?: boolean; details?: unknown }>(
  message: TMessage,
  goalId: string,
): TMessage {
  const content = supersededContinuationMessage(goalId);

  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: {
        kind: "superseded_continuation",
        goalId,
      },
    } as TMessage;
  }

  return {
    ...message,
    content: [{ type: "text", text: content }],
  } as TMessage;
}

function continuationPromptForProviderContext(
  goal: ThreadGoal,
  message: { details?: unknown },
): string {
  if (isQueuedGoalMessageDetails(message.details)) {
    const kind = message.details.kind;
    if (kind === "command_start" || kind === "command_resume") {
      return continuationPrompt(goal);
    }
  }

  return compactContinuationPrompt(goal);
}

export function dedupeActiveGoalContinuations<TMessage extends {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
  display?: boolean;
}>(
  messages: TMessage[],
  goal: ThreadGoal,
  resolveQueuedGoalWorkMessageId: (
    message: { role: string; customType?: string; details?: unknown; content?: unknown },
  ) => string | null,
): { messages: TMessage[]; changed: boolean } {
  const activeGoalId = goal.goalId;
  const indices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const queuedGoalId = resolveQueuedGoalWorkMessageId(message);
    if (queuedGoalId === activeGoalId) {
      indices.push(index);
    }
  }

  const latestIndex = indices.at(-1);
  if (latestIndex === undefined) {
    return { messages, changed: false };
  }

  let changed = false;
  const nextMessages = messages.slice();

  for (const index of indices.slice(0, -1)) {
    const message = nextMessages[index];
    if (!message) {
      continue;
    }
    nextMessages[index] = supersededContinuationContextMessage(message, activeGoalId);
    changed = true;
  }

  const latestMessage = nextMessages[latestIndex];
  if (!latestMessage) {
    return { messages, changed };
  }
  const refreshedContent = continuationPromptForProviderContext(goal, latestMessage);
  if (latestMessage.role === "custom") {
    if (latestMessage.content !== refreshedContent) {
      nextMessages[latestIndex] = {
        ...latestMessage,
        content: refreshedContent,
        display: false,
      };
      changed = true;
    }
  } else {
    const refreshedUserContent = [{ type: "text", text: refreshedContent }];
    const currentContent = textContentFromMessageContent(latestMessage.content);
    if (currentContent !== refreshedContent) {
      nextMessages[latestIndex] = {
        ...latestMessage,
        content: refreshedUserContent,
      } as TMessage;
      changed = true;
    }
  }

  return { messages: nextMessages, changed };
}

export function staleGoalContinuationContextMessage<TMessage extends { role: string; content?: unknown }>(
  message: TMessage,
  queuedGoalId: string,
  currentGoal: ThreadGoal | null,
): TMessage {
  const content = staleGoalContinuationMessage(queuedGoalId, currentGoal);

  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: {
        kind: "stale_continuation",
        goalId: queuedGoalId,
        currentGoalId: currentGoal?.goalId ?? null,
        currentStatus: currentGoal?.status ?? null,
      },
    } as TMessage;
  }

  return {
    ...message,
    content: [{ type: "text", text: content }],
  } as TMessage;
}

export function extensionQueuedGoalWorkMessageIdForRuntime(
  message: {
    role: string;
    customType?: string;
    details?: unknown;
    content?: unknown;
  },
  resolveContinuationGoalIdFromPrompt: (prompt: string) => string | null,
): string | null {
  if (message.role === "user") {
    const text = textContentFromMessageContent(message.content);
    return text === null ? null : resolveContinuationGoalIdFromPrompt(text);
  }

  return queuedGoalWorkMessageId(message);
}

export function pendingStaleQueuedGoalWorkIdsFromMessages(
  messages: Array<{ role: string; customType?: string; details?: unknown; content?: unknown }>,
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
