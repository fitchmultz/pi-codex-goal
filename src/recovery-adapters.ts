import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";

export interface OverflowCheckAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

const OVERFLOW_CHECK_API = "pi-codex-goal-overflow-check";
const OVERFLOW_CHECK_PROVIDER = "pi-codex-goal";
const OVERFLOW_CHECK_MODEL = "overflow-check";

function stopReasonFromAssistantError(stopReason: string | undefined): StopReason {
  switch (stopReason) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return stopReason;
    default:
      return "error";
  }
}

/** Single adapter for pi-ai overflow checks; keeps AssistantMessage casts out of recovery logic. */
export function assistantMessageForOverflowCheck(message: OverflowCheckAssistantMessage): AssistantMessage {
  const usage = message.usage ?? { input: 0, output: 0 };
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  const assistantMessage: AssistantMessage = {
    role: "assistant",
    content: [],
    api: OVERFLOW_CHECK_API,
    provider: OVERFLOW_CHECK_PROVIDER,
    model: OVERFLOW_CHECK_MODEL,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite,
      totalTokens: usage.input + usage.output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: stopReasonFromAssistantError(message.stopReason),
    timestamp: 0,
  };

  if (message.errorMessage !== undefined) {
    assistantMessage.errorMessage = message.errorMessage;
  }

  return assistantMessage;
}
