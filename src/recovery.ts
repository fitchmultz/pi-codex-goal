import { isContextOverflow } from "@earendil-works/pi-ai";

import { assistantMessageForOverflowCheck } from "./recovery-adapters.js";

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
  return isContextOverflow(assistantMessageForOverflowCheck(message), contextWindow);
}

export function isContextOverflowError(errorMessage: string | undefined): boolean {
  return isContextOverflow(
    assistantMessageForOverflowCheck({
      stopReason: "error",
      errorMessage: errorMessage ?? "",
    }),
  );
}

export function isProviderLimitError(errorMessage: string | undefined): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage limit has been reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
    errorMessage ?? "",
  );
}

function isNonRetryableProviderLimitError(errorMessage: string): boolean {
  return isProviderLimitError(errorMessage);
}

/**
 * Mirrors the current Pi host AgentSession retryable-error classification for transient provider failures.
 * Context overflow is not transient retryable because host compaction handles that path.
 * Terminal quota, billing, and provider-limit errors are not retryable even when they contain 429 or rate-limit wording.
 */
export function isRetryableTransientError(errorMessage: string | undefined): boolean {
  if (!errorMessage) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return false;
  }
  if (isNonRetryableProviderLimitError(errorMessage)) {
    return false;
  }
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|retrying upstream|request buffer limit|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
    errorMessage,
  );
}

function normalizeTransientSignature(line: string): string {
  return line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\breq[_-][a-z0-9-]+\b/gi, "req_<id>")
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

export type RecoveryAttention =
  | { kind: "pending"; reason: string }
  | { kind: "paused"; reason: string };

export function createRecoveryPendingAttention(reason: string): RecoveryAttention {
  return { kind: "pending", reason };
}

export function createRecoveryPausedAttention(reason: string): RecoveryAttention {
  return { kind: "paused", reason };
}

export function recoveryPendingAttentionMessage(reason: string): string {
  return `Goal recovery pending (${reason}); ${RECOVERY_PENDING_ATTENTION_SUFFIX}`;
}

export function recoveryPausedAttentionMessage(reason: string): string {
  return `Goal needs attention (${reason}). Use /goal resume to continue.`;
}

export function formatRecoveryAttention(attention: RecoveryAttention | null): string | null {
  if (!attention) {
    return null;
  }
  return attention.kind === "pending"
    ? recoveryPendingAttentionMessage(attention.reason)
    : recoveryPausedAttentionMessage(attention.reason);
}

export function isRecoveryPendingAttention(
  attention: RecoveryAttention | null,
): attention is Extract<RecoveryAttention, { kind: "pending" }> {
  return attention?.kind === "pending";
}

export function reasonFromRecoveryPendingAttention(attention: RecoveryAttention | null): string | null {
  return attention?.kind === "pending" ? attention.reason : null;
}

/** Paused goals use /goal resume guidance in footer attention copy. */
export function recoveryAttentionMessage(reason: string): string {
  return recoveryPausedAttentionMessage(reason);
}
