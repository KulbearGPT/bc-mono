import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  createLatestRequestSequence,
  createVisibleRefreshLoop
} from '../apps/dashboard/src/live-query-refresh.js';
import { supportSelectionMatches } from '../apps/dashboard/src/SupportWorkbenchPage.js';

class FakeVisibility {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private listener: (() => void) | null = null;
  addEventListener(_name: 'visibilitychange', listener: () => void) { this.listener = listener; }
  removeEventListener(_name: 'visibilitychange', listener: () => void) {
    if (this.listener === listener) this.listener = null;
  }
  change(state: 'visible' | 'hidden') { this.visibilityState = state; this.listener?.(); }
}

class FakeIntervals {
  callback: (() => void) | null = null;
  delay: number | null = null;
  setInterval = (callback: () => void, delay: number) => { this.callback = callback; this.delay = delay; return 1; };
  clearInterval = (_id: number) => { this.callback = null; this.delay = null; };
  tick() { this.callback?.(); }
}

describe('M19-US-04 support live refresh', () => {
  test('refreshes immediately and every five seconds only while the page is visible', async () => {
    const visibility = new FakeVisibility();
    const intervals = new FakeIntervals();
    const refresh = vi.fn(async () => undefined);
    const stop = createVisibleRefreshLoop({
      refresh,
      intervalMs: 5_000,
      visibility,
      scheduler: intervals
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(intervals.delay).toBe(5_000);
    intervals.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(refresh).toHaveBeenCalledTimes(2);

    visibility.change('hidden');
    expect(intervals.callback).toBeNull();
    visibility.change('visible');
    await new Promise((resolve) => setImmediate(resolve));
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(intervals.delay).toBe(5_000);

    stop();
    expect(intervals.callback).toBeNull();
  });

  test('prevents an older response from replacing a newer trusted query', () => {
    const sequence = createLatestRequestSequence();
    const oldRequest = sequence.begin();
    const newRequest = sequence.begin();
    expect(sequence.isCurrent(oldRequest)).toBe(false);
    expect(sequence.isCurrent(newRequest)).toBe(true);
    sequence.invalidate();
    expect(sequence.isCurrent(newRequest)).toBe(false);
  });

  test('never combines a newly selected task with the previously loaded order', () => {
    const orderA = { order: { id: 'order-a' } };
    expect(supportSelectionMatches({ orderId: 'order-a' }, orderA)).toBe(true);
    expect(supportSelectionMatches({ orderId: 'order-b' }, orderA)).toBe(false);
    expect(supportSelectionMatches({ orderId: null }, orderA)).toBe(false);
  });

  test('integrates automatic and manual refresh with every support write path', async () => {
    const source = await readFile('apps/dashboard/src/SupportWorkbenchPage.tsx', 'utf8');
    expect(source).toContain('createVisibleRefreshLoop');
    expect(source).toContain('SUPPORT_REFRESH_INTERVAL_MS = 5_000');
    expect(source).toContain('refreshSupportState');
    expect(source).toContain("'立即刷新'");
    expect(source).toContain('上次更新');
    expect(source.match(/createVisibleRefreshLoop/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('指标刷新失败，当前保留上次结果');
    expect(source).toContain('onUpdated={refreshSupportState}');
    expect(source).not.toMatch(/useEffect\(\(\) => \{ void load\(\); \}, \[load\]\)/u);

    for (const operation of ['claim', 'addNote', 'escalate', 'resolve', 'verifyGift', 'decideGift', 'toggleShift']) {
      const start = source.indexOf(`async function ${operation}(`);
      const nextFunction = source.indexOf('\n  async function ', start + 1);
      const body = start < 0 ? '' : source.slice(start, nextFunction < 0 ? source.indexOf('\n\n  return', start) : nextFunction);
      expect(body, `${operation} must invalidate and re-read affected staff facts`).toContain('refreshSupportState');
    }
  });

  test('guards admin detail responses and page rendering against stale or malformed projections', async () => {
    const [route, app] = await Promise.all([
      readFile('apps/dashboard/src/AdminBusinessRoute.tsx', 'utf8'),
      readFile('apps/dashboard/src/App.tsx', 'utf8')
    ]);
    expect(route).toContain('detailRequestSequence');
    expect(route).toContain('detailRequestSequence.isCurrent(sequence)');
    expect(route).toContain('detailRequestSequence.invalidate()');
    expect(app).toContain('DashboardErrorBoundary');
  });
});
