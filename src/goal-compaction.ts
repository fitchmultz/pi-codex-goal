import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { CUSTOM_ENTRY_TYPE } from "./types.ts";
import { isRecord } from "./validation.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type GoalCompactionInput = {
  [K in keyof Pick<Preparation, "messagesToSummarize" | "turnPrefixMessages">]: unknown[];
};

// Custom summarizers can request the same synchronous filter before consuming
// preparation, even when their session_before_compact handler loads first.
export const GOAL_COMPACTION_INPUT_EVENT = "pi-codex-goal:compaction-input";

function isGoalControlMessage(message: unknown): boolean {
  if (
    !isRecord(message) ||
    message.role !== "custom" ||
    message.customType !== CUSTOM_ENTRY_TYPE ||
    !isRecord(message.details)
  ) {
    return false;
  }
  const { details } = message;
  return (
    typeof details.goalId === "string" &&
    (details.kind === "continuation" ||
      details.kind === "superseded_continuation" ||
      details.kind === "stale_continuation")
  );
}

/** Filter only summarization copies; retain objectives, work, cuts, and file tracking. */
export function filterGoalCompactionInput(preparation: GoalCompactionInput): void {
  // oxlint-disable-next-line no-param-reassign -- QX-002: Pi consumes this preparation after the hook.
  preparation.messagesToSummarize = preparation.messagesToSummarize.filter(
    (message) => !isGoalControlMessage(message),
  );
  // oxlint-disable-next-line no-param-reassign -- QX-002: Pi consumes this preparation after the hook.
  preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter(
    (message) => !isGoalControlMessage(message),
  );
}

function isGoalCompactionInput(input: unknown): input is GoalCompactionInput {
  return (
    isRecord(input) &&
    Array.isArray(input.messagesToSummarize) &&
    Array.isArray(input.turnPrefixMessages)
  );
}

export function registerGoalCompactionFilter(pi: Pick<ExtensionAPI, "events">): void {
  pi.events.on(GOAL_COMPACTION_INPUT_EVENT, (input: unknown) => {
    if (isGoalCompactionInput(input)) {
      filterGoalCompactionInput(input);
    }
  });
}
