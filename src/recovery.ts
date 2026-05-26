import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

export const CONTEXT_OVERFLOW_SIGNATURE = "context_overflow";

/** Host AgentSession performs one overflow compact-and-retry before giving up. */
export const MAX_CONTEXT_COMPACTION_RETRIES = 1;
export const HOST_OVERFLOW_RECOVERY_REASON = "recovering from context overflow";

const RECOVERY_PENDING_ATTENTION_SUFFIX =
  "wait for host retry/compaction or send a new user message if it does not recover.";

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

/** Resets transient retry counters when the failure signature changes; overflow compaction attempts are independent. */
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
    compactionAttempts: counters.compactionAttempts,
  };
}

export function recoveryPendingAttentionMessage(reason: string): string {
  return `Goal recovery pending (${reason}); ${RECOVERY_PENDING_ATTENTION_SUFFIX}`;
}

export function isRecoveryPendingAttention(attention: string | null): boolean {
  return attention?.startsWith("Goal recovery pending (") ?? false;
}

export function reasonFromRecoveryPendingAttention(attention: string): string | null {
  const match = /^Goal recovery pending \((.+)\); /.exec(attention);
  return match?.[1] ?? null;
}

export function recoveryPausedAttentionMessage(reason: string): string {
  return `Goal needs attention (${reason}). Use /goal resume to continue.`;
}

/** Paused goals use /goal resume guidance in footer attention copy. */
export function recoveryAttentionMessage(reason: string): string {
  return recoveryPausedAttentionMessage(reason);
}
