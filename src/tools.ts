import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalToolResponse, toToolText, type GoalToolResponse } from "./format.ts";
import { createGoal, MIN_TOKEN_BUDGET, replaceGoal } from "./state.ts";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

const EmptyParams = Type.Object({});

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion.",
  }),
  token_budget: Type.Optional(
    Type.Integer({
      description: `Optional integer token budget of at least ${MIN_TOKEN_BUDGET}; omit for unlimited.`,
      minimum: MIN_TOKEN_BUDGET,
    }),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one.",
    }),
  ),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description: "Complete only when no required work remains; blocked only when missing input or external work prevents meaningful progress.",
  }),
  reason: Type.Optional(Type.String({ minLength: 1, description: "Required for blocked: explain the missing input or external dependency." })),
});

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  updateGoal(source: GoalEntrySource, ctx: ExtensionContext, toolCallId: string, status: "complete" | "blocked", reason?: string): GoalResult;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal, status, token budget, tokens used, and active elapsed time.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet:
      "Create one goal with an objective and optional token budget (unlimited if omitted). Fails when a non-complete goal already exists unless replace_existing is true; replaces a completed goal.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const shouldReplaceExisting = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, params.token_budget ?? null)
        : createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the goal complete only after the objective is achieved, or blocked with a reason when missing user input or external work prevents meaningful progress. Blocked goals stop automatic continuation and require explicit /goal resume before completion.",
    promptSnippet: "Complete after an evidence-backed audit, or block on missing input/external work with a reason. Only /goal resume reactivates blocked goals.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete" && params.status !== "blocked") {
        throwToolError("Status must be complete or blocked.");
      }
      const result = host.updateGoal("tool", ctx, toolCallId, params.status, params.reason);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const includeCompletionReport = result.goal.status === "complete";
      return textResult(toToolText(result.goal, includeCompletionReport), result.goal, includeCompletionReport);
    },
  });
}
