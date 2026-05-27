export type RecoveryPhase =
  | { kind: "idle" }
  | { kind: "pendingHostOverflow"; hostRecoveryActive: boolean; needsUserReset: boolean };

export type GoalStartTurnStrategy = "hiddenFollowUp" | "userFollowUp";

export const idleRecoveryPhase: RecoveryPhase = { kind: "idle" };

export function resetRecoveryPhase(): RecoveryPhase {
  return idleRecoveryPhase;
}

export function recoveryPhaseNeedsUserStartTurn(phase: RecoveryPhase): boolean {
  return phase.kind === "pendingHostOverflow" && phase.needsUserReset;
}

export function goalStartTurnStrategy(phase: RecoveryPhase): GoalStartTurnStrategy {
  return recoveryPhaseNeedsUserStartTurn(phase) ? "userFollowUp" : "hiddenFollowUp";
}

export function recoveryPhaseBlocksContinuation(phase: RecoveryPhase): boolean {
  return phase.kind === "pendingHostOverflow" && phase.hostRecoveryActive;
}

export function enterHostOverflowRecoveryPhase(): RecoveryPhase {
  return {
    kind: "pendingHostOverflow",
    hostRecoveryActive: true,
    needsUserReset: true,
  };
}

export function clearHostOverflowRecoveryActive(phase: RecoveryPhase): RecoveryPhase {
  if (phase.kind !== "pendingHostOverflow" || !phase.hostRecoveryActive) {
    return phase;
  }
  return { ...phase, hostRecoveryActive: false };
}

export function clearHostOverflowUserReset(phase: RecoveryPhase): RecoveryPhase {
  if (phase.kind !== "pendingHostOverflow" || !phase.needsUserReset) {
    return phase;
  }
  const next: RecoveryPhase = { ...phase, needsUserReset: false };
  if (!next.hostRecoveryActive) {
    return idleRecoveryPhase;
  }
  return next;
}

export function applyPersistedHostOverflowUserReset(
  phase: RecoveryPhase,
  needsUserReset: boolean,
): RecoveryPhase {
  if (!needsUserReset) {
    return clearHostOverflowUserReset(phase);
  }
  if (phase.kind === "pendingHostOverflow") {
    return { ...phase, needsUserReset: true };
  }
  return {
    kind: "pendingHostOverflow",
    hostRecoveryActive: false,
    needsUserReset: true,
  };
}
