import { isRecord } from "../../src/validation.ts";

export interface QueuedGoalContextCarrier {
  role: string;
  timestamp: number;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
}

export function isQueuedGoalContextCarrier(value: unknown): value is QueuedGoalContextCarrier {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    typeof value.timestamp === "number" &&
    (value.customType === undefined || typeof value.customType === "string") &&
    (value.display === undefined || typeof value.display === "boolean")
  );
}

export function userContentFromUnknown(content: unknown): { type: "text"; text: string }[] {
  return Array.isArray(content)
    ? content.filter(
        (part: unknown): part is { type: "text"; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string",
      )
    : [];
}
