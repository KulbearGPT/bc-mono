export type BotRuntimeTask = () => Promise<void>;

export class BotReadinessState {
  private ready = false;

  public isReady(): boolean {
    return this.ready;
  }

  public markStarting(): void {
    this.ready = false;
  }

  public markReady(): void {
    this.ready = true;
  }

  public markStopping(): void {
    this.ready = false;
  }
}

export async function initializeBotRuntime(input: {
  readiness: BotReadinessState;
  criticalTasks: readonly BotRuntimeTask[];
  backgroundTasks: readonly BotRuntimeTask[];
  backgroundConcurrency?: number;
  onBackgroundError?: (error: unknown, taskIndex: number) => void;
}): Promise<{ backgroundDone: Promise<{ completed: number; failed: number }> }> {
  input.readiness.markStarting();
  for (const task of input.criticalTasks) await task();
  input.readiness.markReady();

  return {
    backgroundDone: runBoundedTasks({
      tasks: input.backgroundTasks,
      concurrency: input.backgroundConcurrency ?? 2,
      onError: input.onBackgroundError
    })
  };
}

export async function runBoundedTasks(input: {
  tasks: readonly BotRuntimeTask[];
  concurrency: number;
  onError?: (error: unknown, taskIndex: number) => void;
}): Promise<{ completed: number; failed: number }> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error('Background task concurrency must be a positive integer.');
  }
  let nextTaskIndex = 0;
  let completed = 0;
  let failed = 0;
  const workerCount = Math.min(input.concurrency, input.tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTaskIndex < input.tasks.length) {
      const taskIndex = nextTaskIndex;
      nextTaskIndex += 1;
      try {
        await input.tasks[taskIndex]!();
        completed += 1;
      } catch (error) {
        failed += 1;
        input.onError?.(error, taskIndex);
      }
    }
  });
  await Promise.all(workers);
  return { completed, failed };
}
