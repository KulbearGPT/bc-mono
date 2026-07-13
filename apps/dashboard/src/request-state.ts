export class LatestRequestGate {
  private generation = 0;

  begin(): { isCurrent: () => boolean } {
    const requestGeneration = ++this.generation;
    return { isCurrent: () => requestGeneration === this.generation };
  }

  invalidate(): void {
    this.generation += 1;
  }
}

export async function runBusyTask<T>(
  setBusy: (busy: boolean) => void,
  task: () => Promise<T>
): Promise<T> {
  setBusy(true);
  try {
    return await task();
  } finally {
    setBusy(false);
  }
}
