import { CONTINUATION_RETRY_MS, PROVIDER_LIMIT_AUTO_RESUME_MS } from "./runtime-config.ts";

interface ProviderLimitAutoResumeDeps {
  onTimer: (goalId: string) => boolean;
}

export function createProviderLimitAutoResumeScheduler(deps: ProviderLimitAutoResumeDeps) {
  let scheduledGoalId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const clear = (): void => {
    generation += 1;
    scheduledGoalId = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleTimer = (goalId: string, delayMs: number): void => {
    const timerGeneration = generation;
    scheduledGoalId = goalId;
    timer = setTimeout(() => {
      timer = null;
      if (timerGeneration !== generation || scheduledGoalId !== goalId) {
        return;
      }
      if (!deps.onTimer(goalId)) {
        if (timerGeneration === generation && scheduledGoalId === goalId) {
          scheduleTimer(goalId, CONTINUATION_RETRY_MS);
        }
        return;
      }
      if (timerGeneration === generation && scheduledGoalId === goalId) {
        scheduledGoalId = null;
      }
    }, delayMs);
    timer.unref?.();
  };

  const schedule = (goalId: string): void => {
    clear();
    scheduleTimer(goalId, PROVIDER_LIMIT_AUTO_RESUME_MS);
  };

  const isScheduledFor = (goalId: string): boolean => scheduledGoalId === goalId;

  return { clear, isScheduledFor, schedule };
}
