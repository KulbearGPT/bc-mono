export class ControlledFaultBoundary {
  private remaining = new Map<string, number>();

  failNext(name: string, times = 1): void {
    if (!Number.isInteger(times) || times < 1) throw new Error('Fault count must be a positive integer.');
    this.remaining.set(name, times);
  }

  trigger(name: string): void {
    const remaining = this.remaining.get(name) ?? 0;
    if (remaining < 1) return;
    if (remaining === 1) this.remaining.delete(name);
    else this.remaining.set(name, remaining - 1);
    throw new Error(`CONTROLLED_FAULT:${name}`);
  }

  pending(name: string): number {
    return this.remaining.get(name) ?? 0;
  }
}
