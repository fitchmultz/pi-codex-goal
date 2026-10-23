export interface QueuedGoalContextCarrier {
  role: string;
  timestamp: number;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
}

export function userContentFromUnknown(content: unknown): { type: "text"; text: string }[] {
  return Array.isArray(content) ? content.filter((part): part is { type: "text"; text: string } =>
    part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string") : [];
}
