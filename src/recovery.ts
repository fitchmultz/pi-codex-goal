const CONTEXT_OVERFLOW_PATTERNS = [
  /context_length_exceeded/i,
  /context window/i,
  /model_context_window_exceeded/i,
  /prompt too long/i,
  /max context length/i,
  /maximum context/i,
] as const;

export const MAX_TRANSIENT_ERROR_RETRIES = 5;
export const MAX_CONTEXT_COMPACTION_RETRIES = 3;
export const TRANSIENT_ERROR_BACKOFF_BASE_MS = 1_000;
export const TRANSIENT_ERROR_BACKOFF_MAX_MS = 30_000;

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
  const message = errorMessage ?? "";
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

export function failureSignature(errorMessage: string | undefined): string {
  const message = (errorMessage ?? "unknown_error").trim();
  const firstLine = message.split("\n")[0] ?? message;
  return firstLine.slice(0, 200);
}

export function transientErrorBackoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(TRANSIENT_ERROR_BACKOFF_BASE_MS * 2 ** exponent, TRANSIENT_ERROR_BACKOFF_MAX_MS);
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
