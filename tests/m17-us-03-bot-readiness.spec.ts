import { describe, expect, test, vi } from 'vitest';
import {
  BotReadinessState,
  initializeBotRuntime
} from '@blackcat/bot/runtime';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

describe('M17-US-03 Bot startup readiness barrier', () => {
  test('stays unavailable until API health, config and onboarding complete, then starts background recovery', async () => {
    const readiness = new BotReadinessState();
    const health = deferred();
    const config = deferred();
    const onboarding = deferred();
    const background = deferred();
    const order: string[] = [];
    const start = initializeBotRuntime({
      readiness,
      criticalTasks: [
        async () => { order.push('health'); await health.promise; },
        async () => { order.push('config'); await config.promise; },
        async () => { order.push('onboarding'); await onboarding.promise; }
      ],
      backgroundTasks: [async () => { order.push('background'); await background.promise; }],
      backgroundConcurrency: 2
    });

    expect(readiness.isReady()).toBe(false);
    expect(order).toEqual(['health']);
    health.resolve();
    await vi.waitFor(() => expect(order).toEqual(['health', 'config']));
    expect(readiness.isReady()).toBe(false);
    config.resolve();
    await vi.waitFor(() => expect(order).toEqual(['health', 'config', 'onboarding']));
    expect(readiness.isReady()).toBe(false);
    onboarding.resolve();

    const result = await start;
    expect(readiness.isReady()).toBe(true);
    await vi.waitFor(() => expect(order).toContain('background'));
    background.resolve();
    await result.backgroundDone;
  });

  test('fails closed when a critical task fails and never starts background recovery', async () => {
    const readiness = new BotReadinessState();
    const background = vi.fn();

    await expect(initializeBotRuntime({
      readiness,
      criticalTasks: [async () => { throw new Error('config unavailable'); }],
      backgroundTasks: [background]
    })).rejects.toThrow('config unavailable');

    expect(readiness.isReady()).toBe(false);
    expect(background).not.toHaveBeenCalled();
  });

  test('marks ready before bounded background work finishes and stopping immediately clears ready', async () => {
    const readiness = new BotReadinessState();
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 4 }, () => deferred());
    const result = await initializeBotRuntime({
      readiness,
      criticalTasks: [async () => undefined],
      backgroundConcurrency: 2,
      backgroundTasks: gates.map((gate) => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      })
    });

    expect(readiness.isReady()).toBe(true);
    await vi.waitFor(() => expect(active).toBe(2));
    gates[0].resolve();
    gates[1].resolve();
    await vi.waitFor(() => expect(active).toBe(2));
    gates[2].resolve();
    gates[3].resolve();
    await result.backgroundDone;
    expect(peak).toBe(2);

    readiness.markStopping();
    expect(readiness.isReady()).toBe(false);
  });
});
