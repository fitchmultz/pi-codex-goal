import { CUSTOM_ENTRY_TYPE, type GoalStatus } from "./types.js";

export type GoalQueuedWorkKind = "continuation" | "command_start" | "command_resume";

export interface ActiveGoalQueuedDetails {
  kind: GoalQueuedWorkKind;
  goalId: string;
}

export interface SupersededContinuationDetails {
  kind: "superseded_continuation";
  goalId: string;
}

export interface StaleContinuationDetails {
  kind: "stale_continuation";
  goalId: string;
  currentGoalId: string | null;
  currentStatus: GoalStatus | null;
}

export interface QueuedGoalTextPart {
  readonly type: "text";
  readonly text: string;
}

export type QueuedGoalUserContent = QueuedGoalTextPart[];

/** External provider-context message shape before normalization. */
export interface QueuedGoalContextInput {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

/** Normalized provider-context carrier with required runtime fields. */
export interface QueuedGoalContextCarrier {
  role: string;
  timestamp: number;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
}

export interface QueuedGoalCustomMessage extends QueuedGoalContextCarrier {
  role: "custom";
  customType: string;
  content: string | QueuedGoalUserContent;
  display: boolean;
  details?:
    | ActiveGoalQueuedDetails
    | SupersededContinuationDetails
    | StaleContinuationDetails
    | Record<string, unknown>;
}

export interface QueuedGoalUserMessage extends QueuedGoalContextCarrier {
  role: "user";
  content: QueuedGoalUserContent;
}

export type QueuedGoalWorkSourceMessage = QueuedGoalCustomMessage | QueuedGoalUserMessage;

export interface SupersededQueuedGoalCustomMessage extends QueuedGoalCustomMessage {
  content: string;
  display: false;
  details: SupersededContinuationDetails;
}

export interface SupersededQueuedGoalUserMessage extends QueuedGoalUserMessage {
  content: QueuedGoalTextPart[];
}

export interface StaleQueuedGoalCustomMessage extends QueuedGoalCustomMessage {
  content: string;
  display: false;
  details: StaleContinuationDetails;
}

export interface StaleQueuedGoalUserMessage extends QueuedGoalUserMessage {
  content: QueuedGoalTextPart[];
}

export interface RefreshedActiveQueuedGoalCustomMessage extends QueuedGoalCustomMessage {
  content: string;
  display: false;
}

export interface RefreshedActiveQueuedGoalUserMessage extends QueuedGoalUserMessage {
  content: QueuedGoalTextPart[];
}

export type RewrittenQueuedGoalWorkMessage =
  | SupersededQueuedGoalCustomMessage
  | SupersededQueuedGoalUserMessage
  | StaleQueuedGoalCustomMessage
  | StaleQueuedGoalUserMessage
  | RefreshedActiveQueuedGoalCustomMessage
  | RefreshedActiveQueuedGoalUserMessage;

export function isGoalCustomMessage(message: QueuedGoalContextCarrier): message is QueuedGoalCustomMessage {
  return message.role === "custom" && typeof message.customType === "string";
}

export function isQueuedGoalWorkSourceMessage(
  message: QueuedGoalContextCarrier,
): message is QueuedGoalWorkSourceMessage {
  return message.role === "user" || isGoalCustomMessage(message);
}

export function userContentFromUnknown(content: unknown): QueuedGoalUserContent {
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: QueuedGoalTextPart[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push({ type: "text", text: candidate.text });
    }
  }
  return parts;
}

export function customContentFromUnknown(content: unknown): string | QueuedGoalUserContent {
  if (typeof content === "string") {
    return content;
  }

  const normalized = userContentFromUnknown(content);
  return normalized.length > 0 ? normalized : "";
}

/** Normalizes external provider-context messages once at the package boundary. */
export function toQueuedGoalContextCarrier(message: QueuedGoalContextInput): QueuedGoalContextCarrier | null {
  if (typeof message.timestamp !== "number") {
    return null;
  }

  const carrier: QueuedGoalContextCarrier = {
    role: message.role,
    timestamp: message.timestamp,
  };
  if (message.customType !== undefined) {
    carrier.customType = message.customType;
  }
  if (message.content !== undefined) {
    carrier.content = message.content;
  }
  if (message.display !== undefined) {
    carrier.display = message.display;
  }
  if (message.details !== undefined) {
    carrier.details = message.details;
  }
  return carrier;
}

/** Merges a rewritten queued-goal carrier onto the original provider-context message. */
export function mergeProviderContextMessage<TMessage extends QueuedGoalContextInput>(
  original: TMessage,
  rewritten: QueuedGoalContextCarrier,
): TMessage {
  return {
    ...original,
    ...rewritten,
  } as TMessage;
}

/** Normalizes external provider-context messages once at the package boundary. */
export function toQueuedGoalWorkSource(
  message: QueuedGoalContextCarrier,
): QueuedGoalWorkSourceMessage | null {
  switch (message.role) {
    case "user":
      return {
        ...message,
        role: "user",
        content: userContentFromUnknown(message.content),
      };
    case "custom":
      if (!isGoalCustomMessage(message)) {
        return null;
      }
      return {
        ...message,
        role: "custom",
        customType: message.customType,
        content: customContentFromUnknown(message.content),
        display: message.display ?? false,
      };
    default:
      return null;
  }
}

export function isPiCodexGoalCustomMessage(message: QueuedGoalContextCarrier): message is QueuedGoalCustomMessage {
  return isGoalCustomMessage(message) && message.customType === CUSTOM_ENTRY_TYPE;
}

export function isActiveGoalQueuedDetails(details: unknown): details is ActiveGoalQueuedDetails {
  if (details === null || typeof details !== "object") {
    return false;
  }

  const candidate = details as { kind?: unknown; goalId?: unknown };
  const kind = candidate.kind;
  return (
    (kind === "continuation" || kind === "command_start" || kind === "command_resume") &&
    typeof candidate.goalId === "string"
  );
}

export function isCommandResumeQueuedGoalMessage(message: QueuedGoalContextCarrier): boolean {
  return isGoalCustomMessage(message) && isActiveGoalQueuedDetails(message.details) && message.details.kind === "command_resume";
}
