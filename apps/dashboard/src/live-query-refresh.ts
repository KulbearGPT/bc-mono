export interface VisibilitySource {
  visibilityState: 'visible' | 'hidden' | string;
  addEventListener(name: 'visibilitychange', listener: () => void): void;
  removeEventListener(name: 'visibilitychange', listener: () => void): void;
}

export interface IntervalScheduler {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}

export function createLatestRequestSequence() {
  let current = 0;
  return {
    begin() { current += 1; return current; },
    invalidate() { current += 1; },
    isCurrent(sequence: number) { return sequence === current; }
  };
}

export function createVisibleRefreshLoop(input: {
  refresh: () => Promise<unknown> | unknown;
  intervalMs: number;
  visibility?: VisibilitySource;
  scheduler?: IntervalScheduler;
  onError?: (error: unknown) => void;
}): () => void {
  const visibility = input.visibility ?? document;
  const scheduler = input.scheduler ?? window;
  let timer: number | null = null;
  let stopped = false;
  let inFlight = false;
  let rerun = false;

  const run = () => {
    if (stopped || visibility.visibilityState === 'hidden') return;
    if (inFlight) { rerun = true; return; }
    inFlight = true;
    Promise.resolve()
      .then(input.refresh)
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        inFlight = false;
        if (rerun) { rerun = false; run(); }
      });
  };
  const disarm = () => {
    if (timer !== null) scheduler.clearInterval(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (!stopped && visibility.visibilityState !== 'hidden') {
      timer = scheduler.setInterval(run, input.intervalMs);
    }
  };
  const onVisibilityChange = () => {
    if (visibility.visibilityState === 'hidden') { disarm(); return; }
    arm();
    run();
  };

  visibility.addEventListener('visibilitychange', onVisibilityChange);
  arm();
  run();
  return () => {
    stopped = true;
    disarm();
    visibility.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
