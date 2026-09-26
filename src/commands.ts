import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { copyTextToClipboard, type ClipboardCopyResult } from "./clipboard.ts";
import { formatGoalSummary } from "./format.ts";
import type { GoalStartTurnStrategy } from "./recovery-machine.ts";
import { compactContinuationPrompt, continuationPrompt } from "./prompts.ts";
import { replaceGoal, updateGoalStatus } from "./state.ts";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.ts";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  cancelProviderLimitAutoResume(goalId: string, ctx: GoalCommandContext): void;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: GoalCommandContext,
  ): { ok: boolean; message: string; goal: ThreadGoal | null };
}

const COMMANDS = ["pause", "resume", "resume cancel", "clear", "copy"] as const;

type CopyText = (text: string) => Promise<ClipboardCopyResult>;

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

function queueGoalUserTurn(pi: GoalCommandPi, goal: ThreadGoal): void {
  pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  args: string,
  ctx: GoalCommandContext,
  copyText: CopyText = copyTextToClipboard,
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

  if (trimmed === "copy") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    const result = await copyText(goal.objective);
    if (!result.ok) {
      ctx.ui.notify(
        result.message ? `Could not copy goal objective: ${result.message}` : "Could not copy goal objective.",
        "error",
      );
      return;
    }
    ctx.ui.notify("Goal objective copied.");
    return;
  }

  if (trimmed === "resume cancel") {
    const current = host.getGoal();
    if (!current) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.cancelProviderLimitAutoResume(current.goalId, ctx);
    ctx.ui.notify("Provider-limit auto-resume canceled. Use /goal resume when ready.");
    return;
  }

  if (trimmed === "pause" || trimmed === "resume") {
    const current = host.getGoal();
    if (
      trimmed === "resume" &&
      current?.status === "active" &&
      host.getGoalStartTurnStrategy() === "userFollowUp"
    ) {
      queueGoalUserTurn(pi, current);
      ctx.ui.notify("Goal already active; queued a continuation.");
      return;
    }

    if (trimmed === "resume" && current?.status === "paused") {
      const result = host.resumeGoalWithContinuation(current.goalId, "command", ctx);
      ctx.ui.notify(result.message, result.ok ? undefined : "warning");
      return;
    }

    const result = updateGoalStatus(current, trimmed === "pause" ? "paused" : "active");
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
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
  if (host.getGoalStartTurnStrategy() === "userFollowUp") {
    queueGoalUserTurn(pi, result.goal);
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
