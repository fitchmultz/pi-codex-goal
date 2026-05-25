export interface DelayScheduler {
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
}

export const defaultDelayScheduler: DelayScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
};

interface PendingDelay {
  callback: () => void;
  delayMs: number;
}

export function createRecordingDelayScheduler(): {
  scheduler: DelayScheduler;
  scheduledDelays: number[];
  runPending: () => void;
} {
  const pending: PendingDelay[] = [];
  const scheduledDelays: number[] = [];

  return {
    scheduledDelays,
    scheduler: {
      schedule(callback, delayMs) {
        scheduledDelays.push(delayMs);
        pending.push({ callback, delayMs });
        return setTimeout(() => {}, 0);
      },
    },
    runPending() {
      const next = pending.shift();
      next?.callback();
    },
  };
}
