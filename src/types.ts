export const CUSTOM_ENTRY_TYPE = "pi-codex-goal";
export const MAX_OBJECTIVE_CHARS = 8000;

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";

export interface GoalUsage {
	tokensUsed: number;
	activeSeconds: number;
}

export interface ThreadGoal {
	goalId: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	usage: GoalUsage;
	createdAt: number;
	updatedAt: number;
}

export type GoalEntrySource = "command" | "tool" | "runtime";

export type GoalCustomEntry =
	| {
			version: 1;
			kind: "set";
			source: GoalEntrySource;
			goal: ThreadGoal;
			at: number;
	  }
	| {
			version: 1;
			kind: "clear";
			source: GoalEntrySource;
			clearedGoalId: string | null;
			at: number;
	  }
	| {
			version: 1;
			kind: "host_overflow_cap_reset";
			active: boolean;
			at: number;
	  };

export interface GoalResult {
	ok: boolean;
	message: string;
	goal: ThreadGoal | null;
}

export interface GoalSnapshot {
	goal: ThreadGoal | null;
	hasGoal: boolean;
}

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}
