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

/** Minimal shape shared by provider-context messages this extension may rewrite. */
export interface QueuedGoalContextCarrier {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
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
        content:
          typeof message.content === "string" || Array.isArray(message.content)
            ? message.content
            : "",
        display: message.display ?? false,
      };
    default:
      return null;
  }
}

export function isPiCodexGoalCustomMessage(message: QueuedGoalContextCarrier): message is QueuedGoalCustomMessage {
  return isGoalCustomMessage(message) && message.customType === CUSTOM_ENTRY_TYPE;
}

export function applyQueuedGoalRewrite<C extends QueuedGoalContextCarrier>(
  carrier: C,
  rewritten: RewrittenQueuedGoalWorkMessage,
): C {
  return { ...carrier, ...rewritten };
}
