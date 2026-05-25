import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

export const CONTEXT_OVERFLOW_SIGNATURE = "context_overflow";

/** Host AgentSession performs one overflow compact-and-retry before giving up. */
export const MAX_CONTEXT_COMPACTION_RETRIES = 1;
/** Host default retry settings use maxRetries = 3 before final failure. */
export const MAX_TRANSIENT_ERROR_RETRIES = 3;

export const HOST_OVERFLOW_RECOVERY_REASON = "recovering from context overflow";

export interface AssistantErrorMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ErrorRecoveryCounters {
  signature: string | null;
  transientAttempts: number;
  consecutiveTransientAttempts: number;
  compactionAttempts: number;
}

export function createErrorRecoveryCounters(): ErrorRecoveryCounters {
  return {
    signature: null,
    transientAttempts: 0,
    consecutiveTransientAttempts: 0,
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

export function isAssistantContextOverflow(
  message: AssistantErrorMessage,
  contextWindow: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (contextWindow <= 0) {
    return isContextOverflowError(message.errorMessage);
  }
  return isContextOverflow(message as AssistantMessage, contextWindow);
}

export function isContextOverflowError(errorMessage: string | undefined): boolean {
  return isContextOverflow({
    role: "assistant",
    stopReason: "error",
    errorMessage: errorMessage ?? "",
  } as AssistantMessage);
}

/**
 * Mirrors host AgentSession._isRetryableError() classification for transient provider failures.
 */
export function isRetryableTransientError(errorMessage: string | undefined): boolean {
  if (!errorMessage) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return false;
  }
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
    errorMessage,
  );
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
    consecutiveTransientAttempts: counters.consecutiveTransientAttempts,
    compactionAttempts: 0,
  };
}

export function recoveryAttentionMessage(reason: string): string {
  return `Goal needs attention (${reason}). Use /goal resume to continue.`;
}
