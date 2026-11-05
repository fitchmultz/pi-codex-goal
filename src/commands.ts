import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { copyTextToClipboard, type ClipboardCopyResult } from "./clipboard.ts";
import { formatGoalSummary } from "./format.ts";
import type { StatusContext } from "./goal-runtime-status.ts";
import type { GoalDeliveryKind } from "./goal-delivery.ts";
import { canResumeGoal, replaceGoal, updateGoalStatus } from "./state.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

export interface CommandHost {
  getGoal: () => ThreadGoal | null;
  setGoal: (goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext) => void;
  clearGoal: (source: GoalEntrySource, ctx: GoalCommandContext) => void;
  cancelProviderLimitAutoResume: (goalId: string, ctx: GoalCommandContext) => void;
  queueGoalTurn: (goal: ThreadGoal, kind: GoalDeliveryKind, ctx: GoalCommandContext) => GoalResult;
  resumeGoalWithContinuation: (
    goalId: string,
    source: GoalEntrySource,
    ctx: GoalCommandContext,
  ) => GoalResult;
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

async function copyGoal(
  host: CommandHost,
  ctx: GoalCommandContext,
  copyText: CopyText,
): Promise<void> {
  const goal = host.getGoal();
  if (!goal) {
    ctx.ui.notify("No goal is set.", "warning");
    return;
  }
  const result = await copyText(goal.objective);
  if (!result.ok) {
    ctx.ui.notify(
      result.message !== undefined && result.message.length > 0
        ? `Could not copy goal objective: ${result.message}`
        : "Could not copy goal objective.",
      "error",
    );
    return;
  }
  ctx.ui.notify("Goal objective copied.");
}

function changeGoalStatus(
  host: CommandHost,
  command: "pause" | "resume",
  ctx: GoalCommandContext,
): void {
  const current = host.getGoal();
  if (command === "resume" && current !== null && canResumeGoal(current)) {
    const result = host.resumeGoalWithContinuation(current.goalId, "command", ctx);
    ctx.ui.notify(result.message, result.ok ? undefined : "warning");
    return;
  }
  const result = updateGoalStatus(current, command === "pause" ? "paused" : "active");
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
}

async function setGoalObjective(
  host: CommandHost,
  objective: string,
  ctx: GoalCommandContext,
): Promise<void> {
  const current = host.getGoal();
  if (current && current.status !== "complete") {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear the existing goal before replacing it.", "error");
      return;
    }
    const shouldReplace = await ctx.ui.confirm(
      "Replace goal?",
      `Current goal:\n${current.objective}\n\nNew goal:\n${objective}`,
    );
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }
  const result = replaceGoal(objective);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  const queued = host.queueGoalTurn(result.goal, "command_start", ctx);
  ctx.ui.notify(queued.ok ? result.message : queued.message, queued.ok ? undefined : "warning");
}

export async function handleGoalCommand(
  host: CommandHost,
  args: string,
  ctx: GoalCommandContext,
  copyText: CopyText = copyTextToClipboard,
): Promise<void> {
  const trimmed = args.trim();
  switch (trimmed) {
    case "":
      ctx.ui.notify(formatGoalSummary(host.getGoal()));
      return;
    case "copy":
      await copyGoal(host, ctx, copyText);
      return;
    case "pause":
    case "resume":
      changeGoalStatus(host, trimmed, ctx);
      return;
    case "clear":
    case "resume cancel": {
      const current = host.getGoal();
      if (!current) {
        ctx.ui.notify("No goal is set.", "warning");
        return;
      }
      if (trimmed === "clear") {
        host.clearGoal("command", ctx);
        ctx.ui.notify("Goal cleared.");
      } else {
        host.cancelProviderLimitAutoResume(current.goalId, ctx);
        ctx.ui.notify("Provider-limit auto-resume canceled. Use /goal resume when ready.");
      }
      return;
    }
    default:
      await setGoalObjective(host, trimmed, ctx);
  }
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
