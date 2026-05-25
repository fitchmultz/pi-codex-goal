import { isContextOverflow } from "@earendil-works/pi-ai";

export const CONTEXT_OVERFLOW_SIGNATURE = "context_overflow";

/** Host AgentSession performs one overflow compact-and-retry before giving up. */
export const MAX_CONTEXT_COMPACTION_RETRIES = 1;
/** Host default retry settings use maxRetries = 3 before final failure. */
export const MAX_TRANSIENT_ERROR_RETRIES = 3;

export interface AssistantErrorMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface ErrorRecoveryCounters {
  signature: string | null;
  transientAttempts: number;
  compactionAttempts: number;
}

export function createErrorRecoveryCounters(): ErrorRecoveryCounters {
  return {
    signature: null,
    transientAttempts: 0,
    compactionAttempts: 0,
  };
}

export function isErrorAssistantMessage(message: AssistantErrorMessage): boolean {
  return message.role === "assistant" && message.stopReason === "error";
}

export function isSuccessfulAssistantTurn(message: AssistantErrorMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

export function isContextOverflowError(errorMessage: string | undefined): boolean {
  return isContextOverflow({
    role: "assistant",
    stopReason: "error",
    errorMessage: errorMessage ?? "",
  } as Parameters<typeof isContextOverflow>[0]);
}

function normalizeTransientSignature(line: string): string {
  return line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\breq[_-]?[a-z0-9-]+\b/gi, "req_<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .slice(0, 200);
}

export function failureSignature(errorMessage: string | undefined): string {
  if (isContextOverflowError(errorMessage)) {
    return CONTEXT_OVERFLOW_SIGNATURE;
  }
  const message = (errorMessage ?? "unknown_error").trim();
  const firstLine = message.split("\n")[0] ?? message;
  return normalizeTransientSignature(firstLine);
}

export function countersForFailureSignature(
  counters: ErrorRecoveryCounters,
  signature: string,
): ErrorRecoveryCounters {
  if (counters.signature === signature) {
    return counters;
  }
  return {
    signature,
    transientAttempts: 0,
    compactionAttempts: 0,
  };
}

export function recoveryAttentionMessage(reason: string): string {
  return `Goal needs attention (${reason}). Use /goal resume to continue.`;
}
