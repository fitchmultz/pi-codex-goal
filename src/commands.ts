import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { copyTextToClipboard, type ClipboardCopyResult } from "./clipboard.ts";
import { formatGoalSummary } from "./format.ts";
import type { StatusContext } from "./goal-runtime-status.ts";
import type { GoalDeliveryKind } from "./goal-delivery.ts";
import { replaceGoal, updateGoalStatus } from "./state.ts";
import { type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.ts";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  cancelProviderLimitAutoResume(goalId: string, ctx: GoalCommandContext): void;
  queueGoalTurn(goal: ThreadGoal, kind: GoalDeliveryKind, ctx: GoalCommandContext): GoalResult;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: GoalCommandContext,
  ): { ok: boolean; message: string; goal: ThreadGoal | null };
}

const COMMANDS = ["pause", "resume", "resume cancel", "clear", "copy"] as const;

type CopyText = (text: string) => Promise<ClipboardCopyResult>;

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand">;

export interface GoalCommandContext extends StatusContext {
  hasUI: boolean;
  ui: StatusContext["ui"] & Pick<ExtensionCommandContext["ui"], "confirm" | "notify">;
}

function completions(prefix: string) {
  return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
    value: command,
    label: command,
    description: `goal ${command}`,
  }));
}

export async function handleGoalCommand(
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
    if (trimmed === "resume" && (current?.status === "paused" || current?.status === "blocked" || current?.status === "waiting")) {
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
  const queued = host.queueGoalTurn(result.goal, "command_start", ctx);
  ctx.ui.notify(queued.ok ? result.message : queued.message, queued.ok ? undefined : "warning");
}

export function registerGoalCommand(pi: GoalCommandPi, host: CommandHost): void {
  pi.registerCommand("goal", {
    description: "Show or manage the current Codex-style goal.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleGoalCommand(host, args, ctx);
    },
  });
}
