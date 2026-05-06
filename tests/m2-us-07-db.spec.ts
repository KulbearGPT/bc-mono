import { describe, expect, test } from 'vitest';
import { PostgresOrderStore } from '@blackcat/api/orders';

describe('M2-US-07 Postgres matching projection', () => {
  test('maps a timed-out latest attempt to the customer decision state', async () => {
    const store = new PostgresOrderStore({
      client: {
        query: async () => ({ rows: [{
          order_status: 'PENDING_DISPATCH',
          player_id: null,
          player_display_name: null,
          attempt_status: 'TIMED_OUT',
          expires_at: new Date('2026-07-18T08:05:00.000Z'),
          notified_count: '4'
        }] })
      }
    });

    await expect(store.getMatchingProgress('00000000-0000-0000-0000-00000000b701')).resolves.toEqual({
      stage: 'TIMED_OUT',
      notifiedCandidateCount: 4,
      timeoutAt: '2026-07-18T08:05:00.000Z',
      nextStep: 'CHOOSE_CONTINUE_OR_CANCEL',
      playerSummary: null
    });
  });

  test('returns only the accepted player display summary', async () => {
    const store = new PostgresOrderStore({
      client: {
        query: async () => ({ rows: [{
          order_status: 'ACCEPTED',
          player_id: '00000000-0000-0000-0000-00000000a702',
          player_display_name: '陪玩小陈',
          attempt_status: 'ACCEPTED',
          expires_at: null,
          notified_count: 3
        }] })
      }
    });

    await expect(store.getMatchingProgress('00000000-0000-0000-0000-00000000b701')).resolves.toMatchObject({
      stage: 'ACCEPTED',
      notifiedCandidateCount: 3,
      nextStep: 'CONFIRM_READINESS',
      playerSummary: {
        playerId: '00000000-0000-0000-0000-00000000a702',
        displayName: '陪玩小陈'
      }
    });
  });
});
