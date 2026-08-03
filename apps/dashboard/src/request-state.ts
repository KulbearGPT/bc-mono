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

export class RetriableWriteKeys {
  private readonly keys = new Map<string, string>();

  get(fingerprint: string, createKey: () => string = () => `dashboard:${crypto.randomUUID()}`): string {
    const existing = this.keys.get(fingerprint);
    if (existing) return existing;
    const key = createKey();
    this.keys.set(fingerprint, key);
    return key;
  }

  complete(fingerprint: string): void {
    this.keys.delete(fingerprint);
  }

  clear(): void {
    this.keys.clear();
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
