export type RecoveryPhase =
  | { kind: "idle" }
  | { kind: "hostOverflowRecoveringNeedsUserStart" }
  | { kind: "hostOverflowRecovering" }
  | { kind: "hostOverflowNeedsUserStart" };

export type GoalStartTurnStrategy = "hiddenFollowUp" | "userFollowUp";

export const idleRecoveryPhase: RecoveryPhase = { kind: "idle" };

function assertNever(value: never): never {
  throw new Error(`Unexpected recovery phase: ${JSON.stringify(value)}`);
}

export function recoveryPhaseNeedsUserStartTurn(phase: RecoveryPhase): boolean {
  switch (phase.kind) {
    case "idle":
    case "hostOverflowRecovering":
      return false;
    case "hostOverflowRecoveringNeedsUserStart":
    case "hostOverflowNeedsUserStart":
      return true;
    default:
      return assertNever(phase);
  }
}

export function goalStartTurnStrategy(phase: RecoveryPhase): GoalStartTurnStrategy {
  return recoveryPhaseNeedsUserStartTurn(phase) ? "userFollowUp" : "hiddenFollowUp";
}

export function recoveryPhaseBlocksContinuation(phase: RecoveryPhase): boolean {
  switch (phase.kind) {
    case "idle":
    case "hostOverflowNeedsUserStart":
      return false;
    case "hostOverflowRecoveringNeedsUserStart":
    case "hostOverflowRecovering":
      return true;
    default:
      return assertNever(phase);
  }
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
    case "idle":
    case "hostOverflowNeedsUserStart":
      return phase;
    default:
      return assertNever(phase);
  }
}

export function clearHostOverflowUserReset(phase: RecoveryPhase): RecoveryPhase {
  switch (phase.kind) {
    case "hostOverflowRecoveringNeedsUserStart":
      return { kind: "hostOverflowRecovering" };
    case "hostOverflowNeedsUserStart":
      return idleRecoveryPhase;
    case "idle":
    case "hostOverflowRecovering":
      return phase;
    default:
      return assertNever(phase);
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
    case "idle":
      return { kind: "hostOverflowNeedsUserStart" };
    default:
      return assertNever(phase);
  }
}
