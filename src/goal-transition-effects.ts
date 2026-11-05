export type GoalTransitionEffect =
  | { type: "clearContinuation" }
  | { type: "clearActiveAccounting" }
  | { type: "resetRecovery" }
  | { type: "clearBudgetWarning" }
  | { type: "clearHostOverflowRecovery" }
  | { type: "setRecoveryPausedAttention"; reason: string }
  | { type: "markContinuationQueued"; goalId: string }
  | { type: "stopStatusRefresh" };

export interface GoalTransitionEffectHandlers {
  clearContinuation: () => void;
  clearActiveAccounting: () => void;
  resetRecovery: () => void;
  clearBudgetWarning: () => void;
  clearHostOverflowRecovery: () => void;
  setRecoveryPausedAttention: (reason: string) => void;
  markContinuationQueued: (goalId: string) => void;
  stopStatusRefresh: () => void;
}

function goalTransitionEffectKey(effect: GoalTransitionEffect): string {
  switch (effect.type) {
    case "setRecoveryPausedAttention":
      return `${effect.type}:${effect.reason}`;
    case "markContinuationQueued":
      return `${effect.type}:${effect.goalId}`;
    case "clearContinuation":
    case "clearActiveAccounting":
    case "resetRecovery":
    case "clearBudgetWarning":
    case "clearHostOverflowRecovery":
    case "stopStatusRefresh":
      return effect.type;
  }
}

export function appendGoalTransitionEffectOnce(
  effects: GoalTransitionEffect[],
  effect: GoalTransitionEffect,
): void {
  const key = goalTransitionEffectKey(effect);
  if (!effects.some((existing) => goalTransitionEffectKey(existing) === key)) {
    effects.push(effect);
  }
}

export function mergeGoalTransitionEffects(
  ...groups: readonly GoalTransitionEffect[][]
): GoalTransitionEffect[] {
  const result: GoalTransitionEffect[] = [];
  for (const group of groups) {
    for (const effect of group) {
      appendGoalTransitionEffectOnce(result, effect);
    }
  }
  return result;
}

export function applyGoalTransitionEffects(
  effects: readonly GoalTransitionEffect[],
  handlers: GoalTransitionEffectHandlers,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearContinuation":
        handlers.clearContinuation();
        break;
      case "clearActiveAccounting":
        handlers.clearActiveAccounting();
        break;
      case "resetRecovery":
        handlers.resetRecovery();
        break;
      case "clearBudgetWarning":
        handlers.clearBudgetWarning();
        break;
      case "clearHostOverflowRecovery":
        handlers.clearHostOverflowRecovery();
        break;
      case "setRecoveryPausedAttention":
        handlers.setRecoveryPausedAttention(effect.reason);
        break;
      case "markContinuationQueued":
        handlers.markContinuationQueued(effect.goalId);
        break;
      case "stopStatusRefresh":
        handlers.stopStatusRefresh();
        break;
      default: {
        const _exhaustive: never = effect;
        throw new Error(`Unhandled goal transition effect: ${String(_exhaustive)}`);
      }
    }
  }
}
