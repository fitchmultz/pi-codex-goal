import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatGoalSummary } from "./format.js";
import { compactContinuationPrompt, continuationPrompt } from "./prompts.js";
import { replaceGoal, updateGoalStatus } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  needsHostOverflowCapReset(): boolean;
}

const COMMANDS = ["pause", "resume", "clear"] as const;

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "sendUserMessage">;

export interface GoalCommandContext {
  hasUI: boolean;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus">;
}

function completions(prefix: string) {
  return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
    value: command,
    label: command,
    description: `goal ${command}`,
  }));
}

function queueGoalTurn(pi: GoalCommandPi, goal: ThreadGoal, kind: "command_start" | "command_resume"): void {
  pi.sendMessage(
    {
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind, goalId: goal.goalId },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function queueGoalUserResumeTurn(pi: GoalCommandPi, goal: ThreadGoal): void {
  pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
}

function queueGoalUserStartTurn(pi: GoalCommandPi, goal: ThreadGoal): void {
  pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  args: string,
  ctx: GoalCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }

  if (trimmed === "clear") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.clearGoal("command", ctx);
    ctx.ui.notify("Goal cleared.");
    return;
  }

  if (trimmed === "pause" || trimmed === "resume") {
    const current = host.getGoal();
    const status = trimmed === "pause" ? "paused" : "active";
    const result = updateGoalStatus(current, status);
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
    if (trimmed === "resume" && result.goal.status === "active") {
      queueGoalUserResumeTurn(pi, result.goal);
    }
    return;
  }

  const current = host.getGoal();
  if (current && current.status !== "complete") {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear the existing goal before replacing it.", "error");
      return;
    }
    const shouldReplace = await ctx.ui.confirm(
      "Replace goal?",
      `Current goal:\n${current.objective}\n\nNew goal:\n${trimmed}`,
    );
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }

  const result = replaceGoal(trimmed);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  if (host.needsHostOverflowCapReset()) {
    queueGoalUserStartTurn(pi, result.goal);
  } else {
    queueGoalTurn(pi, result.goal, "command_start");
  }
}

export function registerGoalCommand(pi: GoalCommandPi, host: CommandHost): void {
  pi.registerCommand("goal", {
    description: "Show or manage the current Codex-style goal.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleGoalCommand(pi, host, args, ctx);
    },
  });
}
