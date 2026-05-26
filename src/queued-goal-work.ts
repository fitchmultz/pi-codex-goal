import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  supersededContinuationMessage,
} from "./prompts.js";
import {
  isActiveGoalQueuedDetails,
  type QueuedGoalContextCarrier,
  type QueuedGoalContextInput,
  type QueuedGoalCustomMessage,
  type QueuedGoalTextPart,
  type QueuedGoalUserMessage,
  type QueuedGoalWorkSourceMessage,
  toQueuedGoalContextCarrier,
  toQueuedGoalWorkSource,
  userContentFromUnknown,
} from "./queued-goal-messages.js";
import { CUSTOM_ENTRY_TYPE, type GoalStatus, type ThreadGoal } from "./types.js";

interface SupersededContinuationDetails {
  kind: "superseded_continuation";
  goalId: string;
}

interface StaleContinuationDetails {
  kind: "stale_continuation";
  goalId: string;
  currentGoalId: string | null;
  currentStatus: GoalStatus | null;
}

interface SupersededQueuedGoalCustomMessage extends QueuedGoalCustomMessage {
  content: string;
  display: false;
  details: SupersededContinuationDetails;
}

interface SupersededQueuedGoalUserMessage extends QueuedGoalUserMessage {
  content: QueuedGoalTextPart[];
}

interface StaleQueuedGoalCustomMessage extends QueuedGoalCustomMessage {
  content: string;
  display: false;
  details: StaleContinuationDetails;
}

interface StaleQueuedGoalUserMessage extends QueuedGoalUserMessage {
  content: QueuedGoalTextPart[];
}

interface RefreshedActiveQueuedGoalCustomMessage extends QueuedGoalCustomMessage {
  content: string;
  display: false;
}

interface RefreshedActiveQueuedGoalUserMessage extends QueuedGoalUserMessage {
  content: QueuedGoalTextPart[];
}

type RewrittenQueuedGoalWorkMessage =
  | SupersededQueuedGoalCustomMessage
  | SupersededQueuedGoalUserMessage
  | StaleQueuedGoalCustomMessage
  | StaleQueuedGoalUserMessage
  | RefreshedActiveQueuedGoalCustomMessage
  | RefreshedActiveQueuedGoalUserMessage;

/** Single bridge from concrete queued-goal rewrites back onto provider-context messages. */
function mergeProviderContextMessage<TMessage extends QueuedGoalContextInput>(
  original: TMessage,
  rewritten: RewrittenQueuedGoalWorkMessage,
): TMessage {
  return {
    ...original,
    ...rewritten,
  } as TMessage;
}

function isSupersededContinuationDetails(details: unknown): boolean {
  return details !== null && typeof details === "object" && (details as { kind?: unknown }).kind === "superseded_continuation";
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

export function extensionQueuedGoalWorkMessageId(message: QueuedGoalContextInput): string | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }

  if (isSupersededContinuationDetails(message.details)) {
    return null;
  }

  if (isActiveGoalQueuedDetails(message.details)) {
    return message.details.goalId;
  }

  return continuationGoalIdFromMessageContent(message.content);
}

function queuedGoalWorkMessageId(message: QueuedGoalContextInput): string | null {
  if (message.role === "user") {
    return continuationGoalIdFromMessageContent(message.content);
  }

  return extensionQueuedGoalWorkMessageId(message);
}

function supersededContinuationContextMessage(
  message: QueuedGoalWorkSourceMessage,
  goalId: string,
): SupersededQueuedGoalCustomMessage | SupersededQueuedGoalUserMessage {
  const content = supersededContinuationMessage(goalId);

  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: {
        kind: "superseded_continuation" as const,
        goalId,
      },
    };
  }

  const userContent: QueuedGoalTextPart[] = [{ type: "text", text: content }];
  return {
    ...message,
    content: userContent,
  };
}

function continuationPromptForProviderContext(
  goal: ThreadGoal,
  message: Pick<QueuedGoalWorkSourceMessage, "details">,
): string {
  if (isActiveGoalQueuedDetails(message.details)) {
    const kind = message.details.kind;
    if (kind === "command_start" || kind === "command_resume") {
      return continuationPrompt(goal);
    }
  }

  return compactContinuationPrompt(goal);
}

function dedupeActiveGoalContinuations<TMessage extends QueuedGoalContextInput>(
  messages: readonly TMessage[],
  goal: ThreadGoal,
  resolveQueuedGoalWorkMessageId: (message: QueuedGoalContextInput) => string | null,
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
    return { messages: [...messages], changed: false };
  }

  let changed = false;
  const nextMessages = [...messages];

  for (const index of indices.slice(0, -1)) {
    const message = nextMessages[index];
    if (!message) {
      continue;
    }
    const carrier = toQueuedGoalContextCarrier(message);
    if (!carrier) {
      continue;
    }
    const source = toQueuedGoalWorkSource(carrier);
    if (!source) {
      continue;
    }
    const rewritten = supersededContinuationContextMessage(source, activeGoalId);
    nextMessages[index] = mergeProviderContextMessage(message, rewritten);
    changed = true;
  }

  const latestMessage = nextMessages[latestIndex];
  if (!latestMessage) {
    return { messages: nextMessages, changed };
  }
  const latestCarrier = toQueuedGoalContextCarrier(latestMessage);
  if (!latestCarrier) {
    return { messages: nextMessages, changed };
  }
  const latestSource = toQueuedGoalWorkSource(latestCarrier);
  if (!latestSource) {
    return { messages: nextMessages, changed };
  }

  const refreshedContent = continuationPromptForProviderContext(goal, latestSource);
  if (latestSource.role === "custom") {
    if (latestMessage.content !== refreshedContent) {
      const refreshed: RefreshedActiveQueuedGoalCustomMessage = {
        ...latestSource,
        content: refreshedContent,
        display: false,
      };
      nextMessages[latestIndex] = mergeProviderContextMessage(latestMessage, refreshed);
      changed = true;
    }
  } else {
    const refreshedUserContent: QueuedGoalTextPart[] = [{ type: "text", text: refreshedContent }];
    const currentContent = textContentFromMessageContent(latestMessage.content);
    if (currentContent !== refreshedContent) {
      const refreshed: RefreshedActiveQueuedGoalUserMessage = {
        ...latestSource,
        content: refreshedUserContent,
      };
      nextMessages[latestIndex] = mergeProviderContextMessage(latestMessage, refreshed);
      changed = true;
    }
  }

  return { messages: nextMessages, changed };
}

function staleGoalContinuationContextMessage(
  message: QueuedGoalWorkSourceMessage,
  queuedGoalId: string,
  currentGoal: ThreadGoal | null,
): StaleQueuedGoalCustomMessage | StaleQueuedGoalUserMessage {
  const content = staleGoalContinuationMessage(queuedGoalId, currentGoal);
  const staleDetails = {
    kind: "stale_continuation" as const,
    goalId: queuedGoalId,
    currentGoalId: currentGoal?.goalId ?? null,
    currentStatus: currentGoal?.status ?? null,
  };

  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: staleDetails,
    };
  }

  return {
    ...message,
    content: [{ type: "text", text: content }],
  };
}

function rewriteStaleQueuedGoalContextMessage(
  message: QueuedGoalContextCarrier,
  queuedGoalId: string,
  currentGoal: ThreadGoal | null,
): StaleQueuedGoalCustomMessage | StaleQueuedGoalUserMessage | null {
  const source = toQueuedGoalWorkSource(message);
  if (!source) {
    return null;
  }
  return staleGoalContinuationContextMessage(source, queuedGoalId, currentGoal);
}

export function applyQueuedGoalProviderContextRewrites<TMessage extends QueuedGoalContextInput>(
  messages: readonly TMessage[],
  options: {
    goal: ThreadGoal | null;
    resolveStaleQueuedGoalWorkMessageId: (message: QueuedGoalContextInput) => string | null;
    resolveActiveContinuationQueuedGoalWorkMessageId: (message: QueuedGoalContextInput) => string | null;
  },
): { messages: TMessage[]; changed: boolean } {
  let changed = false;
  let nextMessages: TMessage[] = messages.map((message) => {
    const queuedGoalId = options.resolveStaleQueuedGoalWorkMessageId(message);
    if (queuedGoalId === null) {
      return message;
    }

    if (options.goal?.goalId === queuedGoalId && options.goal.status === "active") {
      return message;
    }

    const carrier = toQueuedGoalContextCarrier(message);
    if (!carrier) {
      return message;
    }

    const rewritten = rewriteStaleQueuedGoalContextMessage(carrier, queuedGoalId, options.goal);
    if (!rewritten) {
      return message;
    }

    changed = true;
    return mergeProviderContextMessage(message, rewritten);
  });

  if (options.goal?.status === "active") {
    const deduped = dedupeActiveGoalContinuations(
      nextMessages,
      options.goal,
      options.resolveActiveContinuationQueuedGoalWorkMessageId,
    );
    if (deduped.changed) {
      changed = true;
      nextMessages = deduped.messages;
    }
  }

  return { messages: nextMessages, changed };
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
