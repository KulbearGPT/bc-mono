import { describe, expect, test } from 'vitest';
import {
  InMemoryWeeklyReportStore,
  generateWeeklyReports,
  resolveWeeklyReportPeriod,
  type WeeklyReportFact,
  type WeeklyReportGenerationInput
} from '@blackcat/api/weekly-reports';

const guildId = '900000000000006300';
const playerA = '00000000-0000-0000-0000-000000006301';
const playerB = '00000000-0000-0000-0000-000000006302';

function generation(): WeeklyReportGenerationInput {
  return {
    guildId,
    scheduleKey: 'weekly-cny',
    periodStart: '2026-07-12T16:00:00.000Z',
    periodEnd: '2026-07-19T16:00:00.000Z',
    cutoffAt: '2026-07-19T16:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    currency: 'USD'
  };
}

function fact(overrides: Partial<WeeklyReportFact> = {}): WeeklyReportFact {
  return {
    id: 'fact-a', guildId, playerUserId: playerA, orderId: 'order-a', orderStatus: 'COMPLETED',
    serviceMinutes: 120, orderEarningMinor: 12_000, giftEarningMinor: 2_000,
    adjustmentMinor: -500, earningStatus: 'CONFIRMED', batchedMinor: 4_000,
    occurredAt: '2026-07-18T12:00:00.000Z', issues: [], ...overrides
  };
}

describe('M6-US-03 weekly report domain', () => {
  test('uses a half-open local week and preserves the DST-aware UTC boundary', () => {
    expect(resolveWeeklyReportPeriod({
      now: new Date('2026-03-09T04:05:00.000Z'), timeZone: 'America/Toronto', weekStartsOn: 1
    })).toEqual({
      periodStart: '2026-03-02T05:00:00.000Z',
      periodEnd: '2026-03-09T04:00:00.000Z',
      cutoffAt: '2026-03-09T04:00:00.000Z'
    });
  });

  test('atomically creates one player report per player and one matching summary', async () => {
    const store = new InMemoryWeeklyReportStore({ facts: [
      fact(),
      fact({ id: 'fact-b', playerUserId: playerB, orderId: 'order-b', orderStatus: 'CANCELLED',
        serviceMinutes: 0, orderEarningMinor: 3_000, giftEarningMinor: 0, adjustmentMinor: 250,
        earningStatus: 'PENDING', batchedMinor: 0 })
    ] });

    const first = await generateWeeklyReports({ store, input: generation() });
    const replay = await generateWeeklyReports({ store, input: generation() });

    expect(replay).toEqual(first);
    expect(first.playerReports).toHaveLength(2);
    expect(first.playerReports[0]).toMatchObject({
      playerUserId: playerA, status: 'READY', currentRevision: 1,
      metrics: { completedOrderCount: 1, cancelledOrderCount: 0, serviceMinutes: 120,
        orderEarningMinor: 12_000, giftEarningMinor: 2_000, adjustmentMinor: -500,
        pendingMinor: 0, settlementReadyMinor: 0, batchedMinor: 4_000 }
    });
    expect(first.playerReports[1]).toMatchObject({
      playerUserId: playerB,
      metrics: { completedOrderCount: 0, cancelledOrderCount: 1, pendingMinor: 3_250, settlementReadyMinor: 0 }
    });
    expect(first.summaryReport.metrics).toMatchObject({
      activePlayerCount: 2, completedOrderCount: 1, cancelledOrderCount: 1,
      serviceMinutes: 120, grossAmountMinor: 17_000, adjustmentMinor: -250,
      pendingMinor: 3_250, netPayableMinor: 0
    });
  });

  test('shows a current-period debit on an older paid earning as pending offset', async () => {
    const store = new InMemoryWeeklyReportStore({ facts: [fact({ id: 'old-adjustment', orderId: 'old-order',
      serviceMinutes: 0, orderEarningMinor: 0, giftEarningMinor: 0, adjustmentMinor: -500,
      earningStatus: 'PAID', batchedMinor: 0, includeOrderActivity: false })] });
    const report = (await generateWeeklyReports({ store, input: generation() })).playerReports[0]!;
    expect(report.metrics).toMatchObject({ completedOrderCount: 0, orderEarningMinor: 0,
      adjustmentMinor: -500, pendingMinor: 500, settlementReadyMinor: 0, batchedMinor: 0 });
  });

  test('marks inconsistent data for review instead of silently substituting zero', async () => {
    const store = new InMemoryWeeklyReportStore({ facts: [fact({ issues: ['MISSING_SERVICE_BOUNDARY'] })] });
    const reports = await generateWeeklyReports({ store, input: generation() });

    expect(reports.playerReports[0]?.status).toBe('NEEDS_REVIEW');
    expect(reports.summaryReport.status).toBe('NEEDS_REVIEW');
    expect(reports.playerReports[0]?.detailSnapshot).toMatchObject({ issues: ['MISSING_SERVICE_BOUNDARY'] });
  });

  test('rejects cross-guild, non-USD, and out-of-period facts', async () => {
    const store = new InMemoryWeeklyReportStore({ facts: [
      fact(),
      fact({ id: 'wrong-guild', guildId: 'other-guild', orderId: 'order-x', orderEarningMinor: 99_999 }),
      fact({ id: 'boundary', orderId: 'order-y', occurredAt: generation().periodEnd, orderEarningMinor: 99_999 })
    ] });
    const reports = await generateWeeklyReports({ store, input: generation() });
    expect(reports.summaryReport.metrics.grossAmountMinor).toBe(14_000);

    await expect(generateWeeklyReports({ store, input: { ...generation(), currency: 'EUR' } }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
