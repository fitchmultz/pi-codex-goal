export type RecoveryPhase =
  | { kind: "idle" }
  | { kind: "hostOverflowRecoveringNeedsUserStart" }
  | { kind: "hostOverflowRecovering" }
  | { kind: "hostOverflowNeedsUserStart" };

export type GoalStartTurnStrategy = "hiddenFollowUp" | "userFollowUp";

export const idleRecoveryPhase: RecoveryPhase = { kind: "idle" };

export function recoveryPhaseNeedsUserStartTurn(phase: RecoveryPhase): boolean {
  return (
    phase.kind === "hostOverflowRecoveringNeedsUserStart" || phase.kind === "hostOverflowNeedsUserStart"
  );
}

export function goalStartTurnStrategy(phase: RecoveryPhase): GoalStartTurnStrategy {
  return recoveryPhaseNeedsUserStartTurn(phase) ? "userFollowUp" : "hiddenFollowUp";
}

export function recoveryPhaseBlocksContinuation(phase: RecoveryPhase): boolean {
  return phase.kind === "hostOverflowRecoveringNeedsUserStart" || phase.kind === "hostOverflowRecovering";
}

export function hostOverflowRecoveringNeedsUserStartPhase(): RecoveryPhase {
  return { kind: "hostOverflowRecoveringNeedsUserStart" };
}

export function clearHostOverflowRecoveryActive(phase: RecoveryPhase): RecoveryPhase {
  switch (phase.kind) {
    case "hostOverflowRecoveringNeedsUserStart":
      return { kind: "hostOverflowNeedsUserStart" };
    case "hostOverflowRecovering":
      return idleRecoveryPhase;
    default:
      return phase;
  }
}

export function clearHostOverflowUserReset(phase: RecoveryPhase): RecoveryPhase {
  switch (phase.kind) {
    case "hostOverflowRecoveringNeedsUserStart":
      return { kind: "hostOverflowRecovering" };
    case "hostOverflowNeedsUserStart":
      return idleRecoveryPhase;
    default:
      return phase;
  }
}

export function applyPersistedHostOverflowUserReset(
  phase: RecoveryPhase,
  needsUserReset: boolean,
): RecoveryPhase {
  if (!needsUserReset) {
    return clearHostOverflowUserReset(phase);
  }
  switch (phase.kind) {
    case "hostOverflowRecovering":
      return { kind: "hostOverflowRecoveringNeedsUserStart" };
    case "hostOverflowRecoveringNeedsUserStart":
    case "hostOverflowNeedsUserStart":
      return phase;
    default:
      return { kind: "hostOverflowNeedsUserStart" };
  }
}
