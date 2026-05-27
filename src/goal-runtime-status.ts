import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatFooterStatus } from "./format.js";
import type { GoalRecoveryMachineState } from "./recovery-machine.js";
import type { ThreadGoal } from "./types.js";

export interface StatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

interface GoalRuntimeStatusDeps {
  getGoalForDisplay: () => ThreadGoal | null;
  getGoalStatus: () => ThreadGoal["status"] | null;
  getRecoveryAttention: () => GoalRecoveryMachineState["attention"];
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
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || deps.getGoalStatus() !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus(
          "codex-goal",
          formatFooterStatus(deps.getGoalForDisplay(), deps.getRecoveryAttention()),
        );
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
    ctx.ui.setStatus(
      "codex-goal",
      formatFooterStatus(deps.getGoalForDisplay(), deps.getRecoveryAttention()),
    );
    syncStatusRefresh();
  };

  return {
    refreshUi,
    stopStatusRefresh,
  };
}
