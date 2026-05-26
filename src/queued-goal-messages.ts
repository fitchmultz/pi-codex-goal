import { CUSTOM_ENTRY_TYPE } from "./types.js";

type GoalQueuedWorkKind = "continuation" | "command_start" | "command_resume";

export interface ActiveGoalQueuedDetails {
  kind: GoalQueuedWorkKind;
  goalId: string;
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
  customType: typeof CUSTOM_ENTRY_TYPE;
  content: string | QueuedGoalUserContent;
  display: boolean;
}

export interface QueuedGoalUserMessage extends QueuedGoalContextCarrier {
  role: "user";
  content: QueuedGoalUserContent;
}

export type QueuedGoalWorkSourceMessage = QueuedGoalCustomMessage | QueuedGoalUserMessage;

/** Role/customType only — does not prove normalized content or display. */
interface QueuedGoalCustomRoleCarrier {
  role: "custom";
  customType: typeof CUSTOM_ENTRY_TYPE;
}

function isQueuedGoalCustomRole(
  message: QueuedGoalContextCarrier,
): message is QueuedGoalContextCarrier & QueuedGoalCustomRoleCarrier {
  return message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE;
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

function customContentFromUnknown(content: unknown): string | QueuedGoalUserContent {
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
    case "custom": {
      if (!isQueuedGoalCustomRole(message)) {
        return null;
      }
      const normalized: QueuedGoalCustomMessage = {
        role: "custom",
        customType: message.customType,
        timestamp: message.timestamp,
        content: customContentFromUnknown(message.content),
        display: message.display ?? false,
      };
      if (message.details !== undefined) {
        normalized.details = message.details;
      }
      return normalized;
    }
    default:
      return null;
  }
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
  return (
    isQueuedGoalCustomRole(message) &&
    isActiveGoalQueuedDetails(message.details) &&
    message.details.kind === "command_resume"
  );
}
