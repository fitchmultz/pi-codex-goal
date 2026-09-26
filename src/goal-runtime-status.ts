import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatFooterStatus } from "./format.ts";
import type { GoalRecoveryMachineState } from "./recovery-machine.ts";
import type { ThreadGoal } from "./types.ts";

export interface StatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

interface GoalRuntimeStatusDeps {
  getGoalForDisplay: () => ThreadGoal | null;
  getGoalStatus: () => ThreadGoal["status"] | null;
  getRecoveryAttention: () => GoalRecoveryMachineState["attention"];
  isProviderLimitAutoResumeScheduled: (goalId: string) => boolean;
}

function formatFooterStatusForRuntime(deps: GoalRuntimeStatusDeps): string | undefined {
  const goal = deps.getGoalForDisplay();
  return formatFooterStatus(
    goal,
    deps.getRecoveryAttention(),
    goal ? deps.isProviderLimitAutoResumeScheduled(goal.goalId) : false,
  );
}

export function createGoalRuntimeStatus(deps: GoalRuntimeStatusDeps) {
  let statusContext: StatusContext | null = null;
  let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const stopStatusRefresh = (): void => {
    if (statusRefreshTimer) {
      clearInterval(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };

  const syncStatusRefresh = (): void => {
    if (deps.getGoalStatus() === "active" && statusContext && !statusRefreshTimer) {
      // 1 Hz footer refresh is the intentional steady-state cost of live
      // elapsed-time display for active goals; stopped when the goal leaves active.
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || deps.getGoalStatus() !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus("codex-goal", formatFooterStatusForRuntime(deps));
      }, 1_000);
      statusRefreshTimer.unref?.();
      return;
    }

    if (deps.getGoalStatus() !== "active") {
      stopStatusRefresh();
    }
  };

  const refreshUi = (ctx: StatusContext): void => {
    statusContext = ctx;
    ctx.ui.setStatus("codex-goal", formatFooterStatusForRuntime(deps));
    syncStatusRefresh();
  };

  return {
    refreshUi,
    stopStatusRefresh,
  };
}
