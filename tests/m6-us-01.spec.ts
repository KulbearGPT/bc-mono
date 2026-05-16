import { describe, expect, test } from 'vitest';
import {
  InMemorySettlementStore,
  SettlementError,
  createSettlementBatch,
  previewSettlement,
  type SettlementCandidateEarning,
  type SettlementCreateInput
} from '@blackcat/api/settlements';

const playerA = '00000000-0000-0000-0000-000000006101';
const playerB = '00000000-0000-0000-0000-000000006102';
const cutoffAt = '2026-07-19T16:00:00.000Z';

function earning(input: Partial<SettlementCandidateEarning> & Pick<SettlementCandidateEarning, 'id'>): SettlementCandidateEarning {
  return {
    id: input.id,
    orderId: input.orderId ?? input.id,
    playerUserId: input.playerUserId ?? playerA,
    amountMinor: input.amountMinor ?? 10_000,
    currency: input.currency ?? 'CNY',
    status: input.status ?? 'CONFIRMED',
    confirmedAt: input.confirmedAt === undefined ? '2026-07-19T12:00:00.000Z' : input.confirmedAt,
    paidAt: input.paidAt ?? null,
    createdAt: input.createdAt ?? '2026-07-19T11:00:00.000Z',
    adjustments: input.adjustments ?? []
  };
}

function createInput(overrides: Partial<SettlementCreateInput> = {}): SettlementCreateInput {
  return {
    source: 'MANUAL',
    scheduleKey: null,
    periodStart: '2026-07-13T16:00:00.000Z',
    periodEnd: '2026-07-19T16:00:00.000Z',
    cutoffAt,
    timeZone: 'Asia/Shanghai',
    currency: 'CNY',
    playerUserIds: null,
    createdByStaffId: '00000000-0000-0000-0000-000000006190',
    ...overrides
  };
}

describe('M6-US-01 settlement domain', () => {
  test('selects only confirmed CNY earnings at the inclusive cutoff and keeps playerUserId identity', async () => {
    const atCutoff = earning({ id: '00000000-0000-0000-0000-000000006111', confirmedAt: cutoffAt });
    const afterCutoff = earning({ id: '00000000-0000-0000-0000-000000006112', confirmedAt: '2026-07-19T16:00:00.001Z' });
    const pending = earning({ id: '00000000-0000-0000-0000-000000006113', status: 'PENDING', confirmedAt: null });
    const usd = earning({ id: '00000000-0000-0000-0000-000000006114', currency: 'USD' });
    const store = new InMemorySettlementStore({ earnings: [atCutoff, afterCutoff, pending, usd] });

    const preview = await previewSettlement({ store, input: createInput() });

    expect(preview.items).toEqual([
      expect.objectContaining({ playerUserId: playerA, grossAmountMinor: 10_000, netAmountMinor: 10_000 })
    ]);
    expect(preview.items[0]?.entries.map((entry) => entry.playerEarningId)).toEqual([atCutoff.id]);
  });

  test('filters by player user id and rejects currencies outside the P0 CNY boundary', async () => {
    const store = new InMemorySettlementStore({ earnings: [
      earning({ id: '00000000-0000-0000-0000-000000006121', playerUserId: playerA }),
      earning({ id: '00000000-0000-0000-0000-000000006122', playerUserId: playerB })
    ] });

    const preview = await previewSettlement({ store, input: createInput({ playerUserIds: [playerB] }) });
    expect(preview.items.map((item) => item.playerUserId)).toEqual([playerB]);
    await expect(previewSettlement({ store, input: createInput({ currency: 'USD' }) }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNSUPPORTED_CURRENCY' }));
  });

  test('snapshots net adjustments and leaves preview storage unchanged', async () => {
    const source = earning({
      id: '00000000-0000-0000-0000-000000006131',
      amountMinor: 10_000,
      adjustments: [
        { id: '00000000-0000-0000-0000-000000006132', playerEarningId: '00000000-0000-0000-0000-000000006131', type: 'CORRECTION_CREDIT', amountMinor: 500, currency: 'CNY', createdAt: '2026-07-19T13:00:00.000Z' },
        { id: '00000000-0000-0000-0000-000000006133', playerEarningId: '00000000-0000-0000-0000-000000006131', type: 'REVERSAL_DEBIT', amountMinor: 2_000, currency: 'CNY', createdAt: '2026-07-19T14:00:00.000Z' }
      ]
    });
    const store = new InMemorySettlementStore({ earnings: [source] });

    const preview = await previewSettlement({ store, input: createInput() });

    expect(preview).toMatchObject({ grossAmountMinor: 10_000, adjustmentAmountMinor: -1_500, netAmountMinor: 8_500 });
    expect(preview.items[0]?.entries.map((entry) => entry.amountMinor)).toEqual([10_000, 500, -2_000]);
    expect(store.batches).toHaveLength(0);
    expect(source.adjustments).toHaveLength(2);
  });

  test('deduplicates an automatic schedule deterministically and returns immutable snapshots', async () => {
    const source = earning({ id: '00000000-0000-0000-0000-000000006141' });
    const store = new InMemorySettlementStore({ earnings: [source] });
    const input = createInput({ source: 'SCHEDULED', scheduleKey: 'weekly-cny' });

    const first = await createSettlementBatch({ store, input });
    source.amountMinor = 99_999;
    const replay = await createSettlementBatch({ store, input });

    expect(replay.id).toBe(first.id);
    expect(store.batches).toHaveLength(1);
    expect(first.items[0]?.grossAmountMinor).toBe(10_000);
    expect(first.status).toBe('DRAFT');
    expect(first.items[0]?.paymentStatus).toBe('PENDING');
  });

  test('rejects stale creation when an earning is already linked to a non-void batch', async () => {
    const source = earning({ id: '00000000-0000-0000-0000-000000006151' });
    const store = new InMemorySettlementStore({ earnings: [source] });
    await createSettlementBatch({ store, input: createInput() });

    await expect(createSettlementBatch({ store, input: createInput({ periodStart: '2026-07-12T16:00:00.000Z' }) }))
      .rejects.toEqual(expect.objectContaining<Partial<SettlementError>>({ code: 'SOURCE_ALREADY_BATCHED' }));
    expect(store.batches).toHaveLength(1);
  });

  test('defers a negative-only late adjustment without creating an item or occupying its entry', async () => {
    const source = earning({
      id: '00000000-0000-0000-0000-000000006161',
      status: 'PAID',
      paidAt: '2026-07-18T16:00:00.000Z',
      adjustments: [{
        id: '00000000-0000-0000-0000-000000006162',
        playerEarningId: '00000000-0000-0000-0000-000000006161',
        type: 'CORRECTION_DEBIT',
        amountMinor: 1_200,
        currency: 'CNY',
        createdAt: '2026-07-19T15:00:00.000Z'
      }]
    });
    const store = new InMemorySettlementStore({ earnings: [source] });

    const preview = await previewSettlement({ store, input: createInput() });

    expect(preview).toMatchObject({
      grossAmountMinor: 0,
      adjustmentAmountMinor: 0,
      netAmountMinor: 0,
      deferredAdjustmentMinor: -1_200,
      items: []
    });
    await expect(createSettlementBatch({ store, input: createInput() }))
      .rejects.toEqual(expect.objectContaining({ code: 'NO_ELIGIBLE_SOURCES' }));
    expect(store.batches).toHaveLength(0);
  });

  test('applies a deferred debit to a later positive earning without re-batching the paid earning', async () => {
    const paid = earning({
      id: '00000000-0000-0000-0000-000000006171',
      status: 'PAID',
      paidAt: '2026-07-18T16:00:00.000Z',
      adjustments: [{
        id: '00000000-0000-0000-0000-000000006172',
        playerEarningId: '00000000-0000-0000-0000-000000006171',
        type: 'CORRECTION_DEBIT',
        amountMinor: 1_200,
        currency: 'CNY',
        createdAt: '2026-07-19T15:00:00.000Z'
      }]
    });
    const positive = earning({
      id: '00000000-0000-0000-0000-000000006173',
      amountMinor: 10_000,
      confirmedAt: '2026-07-19T15:30:00.000Z'
    });
    const store = new InMemorySettlementStore({ earnings: [paid, positive] });

    const batch = await createSettlementBatch({ store, input: createInput() });

    expect(batch).toMatchObject({ grossAmountMinor: 10_000, adjustmentAmountMinor: -1_200, netAmountMinor: 8_800 });
    expect(batch.items[0]).toMatchObject({ grossAmountMinor: 10_000, adjustmentAmountMinor: -1_200, netAmountMinor: 8_800 });
    expect(batch.items[0]?.entries).toEqual([
      expect.objectContaining({ entryType: 'EARNING_ADJUSTMENT', playerEarningId: null, playerEarningAdjustmentId: paid.adjustments[0]?.id }),
      expect.objectContaining({ entryType: 'PLAYER_EARNING', playerEarningId: positive.id, playerEarningAdjustmentId: null })
    ]);
    expect(batch.items[0]?.entries.some((entry) => entry.playerEarningId === paid.id)).toBe(false);
  });
});
