import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { CUSTOM_ENTRY_TYPE } from "./types.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type GoalCompactionInput = Pick<Preparation, "messagesToSummarize" | "turnPrefixMessages">;

// Custom summarizers can request the same synchronous filter before consuming
// preparation, even when their session_before_compact handler loads first.
export const GOAL_COMPACTION_INPUT_EVENT = "pi-codex-goal:compaction-input";

function isGoalControlMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (candidate.role !== "custom" || candidate.customType !== CUSTOM_ENTRY_TYPE ||
      !candidate.details || typeof candidate.details !== "object") return false;
  const details = candidate.details as { kind?: unknown; goalId?: unknown };
  return typeof details.goalId === "string" && (
    details.kind === "continuation" ||
    details.kind === "superseded_continuation" ||
    details.kind === "stale_continuation"
  );
}

/** Filter only summarization copies; retain objectives, work, cuts, and file tracking. */
export function filterGoalCompactionInput(preparation: GoalCompactionInput): void {
  preparation.messagesToSummarize = preparation.messagesToSummarize.filter((message) => !isGoalControlMessage(message));
  preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter((message) => !isGoalControlMessage(message));
}

export function registerGoalCompactionFilter(pi: Pick<ExtensionAPI, "events">): void {
  pi.events.on(GOAL_COMPACTION_INPUT_EVENT, (input: unknown) => {
    if (!input || typeof input !== "object") return;
    const candidate = input as { messagesToSummarize?: unknown; turnPrefixMessages?: unknown };
    if (Array.isArray(candidate.messagesToSummarize) && Array.isArray(candidate.turnPrefixMessages)) {
      filterGoalCompactionInput(input as GoalCompactionInput);
    }
  });
}
