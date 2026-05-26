import { describe, expect, test, vi } from 'vitest';
import { PostgresPlayerStore, type PlayerQueryClient, type PlayerProfileRecord } from '@blackcat/api/players';

const profile = { playerId: '00000000-0000-0000-0000-00000000a001', userId: '00000000-0000-0000-0000-00000000a101' } as PlayerProfileRecord;

describe('M2-US-08 PostgreSQL workbench projection', () => {
  test('scopes current orders, dispatch offers and earnings to the current player user id', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        dispatch_attempt_id: '00000000-0000-0000-0000-00000000d001', expires_at: '2026-07-18T00:02:00.000Z',
        order_id: '00000000-0000-0000-0000-00000000b001', public_id: 'P-1042', status: 'PENDING_DISPATCH', row_version: 5,
        game_code: 'VALORANT', service_code: 'ENTERTAINMENT', region_code: 'NA', billing_unit_minutes: 60, unit_count: 2,
        player_earning_minor: 8000, currency: 'USD', requirement_snapshot: { language: '中文' }, voice_channel_id: null
      }] })
      .mockResolvedValueOnce({ rows: [{ pending_minor: '8000', confirmed_minor: '3000', paid_minor: '20000', currency: 'USD' }] });
    const store = new PostgresPlayerStore({ client: { query } as PlayerQueryClient });

    const result = await store.getWorkbenchData({ profile, now: new Date('2026-07-18T00:00:00.000Z') });

    expect(result.matchingOrders[0]).toMatchObject({ secondsRemaining: 120, order: { requirements: ['中文'] } });
    expect(result.earningsSummary).toMatchObject({ pendingMinor: 8000, confirmedMinor: 3000, paidMinor: 20000 });
    expect(query.mock.calls[0]![1]).toEqual([profile.userId]);
    expect(query.mock.calls[1]![1]).toEqual([profile.userId, '2026-07-18T00:00:00.000Z']);
    expect(query.mock.calls[2]![1]).toEqual([profile.userId]);
    expect(query.mock.calls.map((call) => call[0]).join('\n')).not.toMatch(/customer_note|external_account|email|phone/i);
  });
});
