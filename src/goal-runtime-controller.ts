import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.ts";
import { createContinuationScheduler } from "./continuation-scheduler.ts";
import { assistantTurnTokensForToolCall, createGoalAccounting } from "./goal-accounting.ts";
import { createGoalDeliveries, type GoalDeliveryKind } from "./goal-delivery.ts";
import { createGoalPersistence } from "./goal-persistence.ts";
import {
  createGoalRuntimeEventHandlers,
  type GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handlers.ts";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.ts";
import { createGoalRuntimeState } from "./goal-runtime-state.ts";
import { createGoalRuntimeStatus, type StatusContext } from "./goal-runtime-status.ts";
import { createGoalStateController } from "./goal-state-controller.ts";
import { createProviderLimitAutoResumeScheduler } from "./provider-limit-auto-resume.ts";
import { createGoalRecoveryRuntime } from "./recovery-runtime.ts";
import { recoveryPhaseNeedsUserStartTurn } from "./recovery-machine.ts";
import { goalWithLiveUsage, updateGoalStatus } from "./state.ts";
import { registerGoalTools } from "./tools.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

export interface GoalRuntimeController extends GoalRuntimeEventHandlers {
  getGoalForDisplay: () => ThreadGoal | null;
  queueGoalTurn: (goal: ThreadGoal, kind: GoalDeliveryKind, ctx: StatusContext) => GoalResult;
  setGoal: (goal: ThreadGoal, source: GoalEntrySource, ctx: StatusContext) => void;
  clearGoal: (source: GoalEntrySource, ctx: StatusContext) => void;
  updateGoal: (
    ctx: ExtensionContext,
    toolCallId: string,
    status: "complete" | "blocked" | "waiting",
    reason?: string,
  ) => GoalResult;
  cancelProviderLimitAutoResume: (goalId: string, ctx: StatusContext) => void;
  resumeGoalWithContinuation: (
    goalId: string,
    source: GoalEntrySource,
    ctx: StatusContext,
  ) => GoalResult;
}

export function createGoalRuntimeController(pi: ExtensionAPI): GoalRuntimeController {
  const controller = new RuntimeController(pi);
  return {
    getGoalForDisplay: controller.getGoalForDisplay,
    queueGoalTurn: controller.queueGoalTurn,
    setGoal: controller.setGoal,
    clearGoal: controller.clearGoal,
    cancelProviderLimitAutoResume: controller.cancelProviderLimitAutoResume,
    updateGoal: controller.updateGoal,
    resumeGoalWithContinuation: controller.resumeGoalWithContinuation,
    ...controller.getEventHandlers(),
  };
}

class RuntimeController {
  private readonly pi: ExtensionAPI;
  private readonly runtimeState = createGoalRuntimeState();
  private readonly persistence: ReturnType<typeof createGoalPersistence>;
  private readonly deliveries: ReturnType<typeof createGoalDeliveries>;
  private autoResumeContext: ExtensionContext | null = null;
  private readonly providerLimitAutoResume: ReturnType<
    typeof createProviderLimitAutoResumeScheduler
  >;
  private readonly status: ReturnType<typeof createGoalRuntimeStatus>;
  private readonly continuation: ReturnType<typeof createContinuationScheduler>;
  private readonly stateController: ReturnType<typeof createGoalStateController>;
  private readonly goalAccounting: ReturnType<typeof createGoalAccounting>;
  private readonly recoveryRuntime: ReturnType<typeof createGoalRecoveryRuntime<ExtensionContext>>;
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.persistence = createGoalPersistence({ pi: this.pi });
    this.deliveries = createGoalDeliveries(this.pi, this.persistence.getGoal);
    this.providerLimitAutoResume = createProviderLimitAutoResumeScheduler({
      onTimer: (goalId) => {
        if (
          !this.autoResumeContext ||
          !this.autoResumeContext.isIdle() ||
          this.autoResumeContext.hasPendingMessages()
        ) {
          return false;
        }
        this.resumeGoalWithContinuation(goalId, "runtime", this.autoResumeContext);
        return true;
      },
    });
    this.status = createGoalRuntimeStatus({
      getGoalForDisplay: this.getGoalForDisplay,
      getGoalStatus: () => this.persistence.getGoal()?.status ?? null,
      getRecoveryAttention: () => this.runtimeState.recoveryState.attention,
      isProviderLimitAutoResumeScheduled: this.providerLimitAutoResume.isScheduledFor,
    });
    this.continuation = createContinuationScheduler({
      deliveries: this.deliveries,
      getGoal: () => this.persistence.getGoal(),
      getRecoveryState: () => this.runtimeState.recoveryState,
      staleQueuedWorkGuard: this.runtimeState.staleQueuedWorkGuard,
      getCurrentTurnIndex: () => this.runtimeState.currentTurnIndex,
      getAgentRunSequence: () => this.runtimeState.agentRunSequence,
    });
    this.stateController = this.createStateController();
    this.goalAccounting = createGoalAccounting({
      getGoal: () => this.stateController.getGoal(),
      getAccounting: () => this.runtimeState.accounting,
      applyRuntimeAccountingTransition: (ctx, nextGoal) => {
        this.stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
      },
      sendMessage: this.pi.sendMessage.bind(this.pi),
    });
    this.recoveryRuntime = this.createRecoveryRuntime();
  }
  private readonly clearActiveAccounting = (): void => {
    this.runtimeState.accounting.activeGoalId = null;
    this.runtimeState.accounting.lastAccountedAt = null;
    this.runtimeState.accounting.lastSampledAt = null;
  };

  private readonly resetErrorRecovery = (): void => {
    this.runtimeState.recoveryState.resetRecoveryMachine();
  };

  getGoalForDisplay: () => ThreadGoal | null = () =>
    goalWithLiveUsage(
      this.persistence.getGoal(),
      this.runtimeState.accounting.activeGoalId,
      this.runtimeState.accounting.lastAccountedAt,
    );

  private createStateController(): ReturnType<typeof createGoalStateController> {
    return createGoalStateController({
      pi: this.pi,
      persistence: this.persistence,
      invalidateDeliveries: this.deliveries.invalidate,
      getRecoveryState: () => this.runtimeState.recoveryState,
      transitionEffectHandlers: {
        clearContinuation: this.continuation.clearContinuationState,
        clearActiveAccounting: this.clearActiveAccounting,
        resetRecovery: this.resetErrorRecovery,
        clearBudgetWarning: () => {
          this.runtimeState.accounting.budgetWarningSentFor = null;
        },
        clearHostOverflowRecovery: () => {
          this.runtimeState.recoveryState.clearActiveHostOverflowRecovery();
        },
        setRecoveryPausedAttention: (reason: string) => {
          this.runtimeState.recoveryState.setRecoveryPausedAttention(reason);
        },
        markContinuationQueued: this.continuation.markContinuationQueued,
        stopStatusRefresh: () => this.status.stopStatusRefresh(),
      },
      refreshUi: (ctx) => this.status.refreshUi(ctx),
    });
  }

  private createRecoveryRuntime(): ReturnType<typeof createGoalRecoveryRuntime<ExtensionContext>> {
    return createGoalRecoveryRuntime({
      getGoal: () => this.stateController.getGoal(),
      getRecoveryState: () => this.runtimeState.recoveryState,
      clearContinuationState: this.continuation.clearContinuationState,
      pauseGoalForRecovery: (ctx, recoveryReason) => {
        this.stateController.pauseForRecovery(ctx, recoveryReason);
      },
      refreshUi: this.status.refreshUi,
      maybeContinue: this.continuation.maybeContinue,
      scheduleProviderLimitAutoResume: (goalId, ctx) => {
        this.autoResumeContext = ctx;
        this.providerLimitAutoResume.schedule(goalId);
        this.status.refreshUi(ctx);
      },
    });
  }

  queueGoalTurn = (goal: ThreadGoal, kind: GoalDeliveryKind, ctx: StatusContext): GoalResult => {
    if (recoveryPhaseNeedsUserStartTurn(this.runtimeState.recoveryState.phase)) {
      const message =
        "Goal cannot restart native overflow recovery. Reduce context or switch models, then send a genuine user message before /goal resume.";
      this.stateController.pauseForRecovery(ctx, message);
      return { ok: false, message, goal: this.stateController.getGoal() };
    }
    this.continuation.markContinuationQueued(goal.goalId);
    this.deliveries.send(goal, kind);
    return { ok: true, message: "Goal follow-up queued.", goal };
  };

  private checkResumeGoal(
    current: ThreadGoal | null,
    goalId: string,
    source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult | null {
    if (current?.status === "blocked" && source !== "command") {
      return { ok: false, message: "Blocked goals require explicit /goal resume.", goal: current };
    }
    if (
      current?.goalId === goalId &&
      recoveryPhaseNeedsUserStartTurn(this.runtimeState.recoveryState.phase)
    ) {
      return this.queueGoalTurn(current, "command_resume", ctx);
    }
    return null;
  }

  resumeGoalWithContinuation = (
    goalId: string,
    source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult => {
    const current = this.stateController.getGoal();
    const guarded = this.checkResumeGoal(current, goalId, source, ctx);
    if (guarded !== null) {
      return guarded;
    }
    const result = updateGoalStatus(current, "active");
    if (!result.ok || !result.goal || result.goal.goalId !== goalId) {
      return result;
    }
    this.providerLimitAutoResume.clear();
    switch (current?.status) {
      case "blocked":
        this.stateController.applyGoalTransition(
          { kind: "set", nextGoal: result.goal, source },
          ctx,
        );
        break;
      case "waiting":
        this.stateController.resumeWaitingGoal(ctx);
        break;
      case "active":
      case "paused":
      case "complete":
      case "budgetLimited":
      case undefined:
        this.stateController.resumePausedGoal(ctx);
    }
    const resumedGoal = this.stateController.getGoal();
    if (resumedGoal?.status === "active" && resumedGoal.goalId === goalId) {
      return this.queueGoalTurn(resumedGoal, "command_resume", ctx);
    }
    return result;
  };

  getEventHandlers = (): GoalRuntimeEventHandlers =>
    createGoalRuntimeEventHandlers({
      pi: this.pi,
      deliveries: this.deliveries,
      runtimeState: this.runtimeState,
      stateController: this.stateController,
      continuation: this.continuation,
      goalAccounting: this.goalAccounting,
      recoveryRuntime: this.recoveryRuntime,
      status: this.status,
      providerLimitAutoResume: this.providerLimitAutoResume,
      clearActiveAccounting: this.clearActiveAccounting,
      resetErrorRecovery: this.resetErrorRecovery,
      resumeGoalWithContinuation: this.resumeGoalWithContinuation,
    });

  updateGoal = (
    ctx: ExtensionContext,
    toolCallId: string,
    status: "complete" | "blocked" | "waiting",
    reason?: string,
  ): GoalResult => {
    const goal = this.stateController.getGoal();
    if (
      goal &&
      this.runtimeState.completionGoalId !== null &&
      this.runtimeState.completionGoalId !== goal.goalId
    ) {
      return {
        ok: false,
        message:
          "Goal changed while this response was running; inspect the current goal before updating its status.",
        goal,
      };
    }
    const validation = updateGoalStatus(goal, status, reason);
    if (!validation.ok) {
      return validation;
    }
    this.providerLimitAutoResume.clear();
    if (status === "blocked" || status === "waiting") {
      this.continuation.clearPostCompactContinuationFallback();
    }
    const completedTurnTokens = assistantTurnTokensForToolCall(
      ctx.sessionManager.getBranch(),
      toolCallId,
    );
    this.goalAccounting.accountProgress(ctx, false, completedTurnTokens, true);
    // A command can resume the goal before sibling tools finish and turn_end arrives.
    this.runtimeState.accounting.turnGoalId = null;
    return this.stateController.updateGoal("tool", ctx, status, reason);
  };

  setGoal = (nextGoal: ThreadGoal, source: GoalEntrySource, ctx: StatusContext): void => {
    this.providerLimitAutoResume.clear();
    this.stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    // A tool-created goal is known to this response, unlike a concurrent /goal replacement.
    if (source === "tool") {
      this.runtimeState.completionGoalId = nextGoal.goalId;
    }
  };

  clearGoal = (source: GoalEntrySource, ctx: StatusContext): void => {
    this.providerLimitAutoResume.clear();
    this.stateController.applyGoalTransition({ kind: "clear", source }, ctx);
  };

  cancelProviderLimitAutoResume = (_goalId: string, ctx: StatusContext): void => {
    this.providerLimitAutoResume.clear();
    this.status.refreshUi(ctx);
  };
}

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerGoalTools(pi, {
    getGoal: controller.getGoalForDisplay,
    setGoal: controller.setGoal,
    updateGoal: controller.updateGoal,
  });
  registerGoalCommand(pi, {
    getGoal: controller.getGoalForDisplay,
    queueGoalTurn: controller.queueGoalTurn,
    setGoal: controller.setGoal,
    clearGoal: controller.clearGoal,
    cancelProviderLimitAutoResume: controller.cancelProviderLimitAutoResume,
    resumeGoalWithContinuation: controller.resumeGoalWithContinuation,
  });
  registerGoalRuntimeEvents(pi, controller);
}
