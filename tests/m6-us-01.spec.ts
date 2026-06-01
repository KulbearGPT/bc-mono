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
const guildId = '900000000000000001';
const cutoffAt = '2026-07-19T16:00:00.000Z';

function earning(input: Partial<SettlementCandidateEarning> & Pick<SettlementCandidateEarning, 'id'>): SettlementCandidateEarning {
  return {
    id: input.id,
    orderId: input.orderId ?? input.id,
    guildId: input.guildId ?? guildId,
    playerUserId: input.playerUserId ?? playerA,
    amountMinor: input.amountMinor ?? 10_000,
    currency: input.currency ?? 'CAT',
    status: input.status ?? 'CONFIRMED',
    confirmedAt: input.confirmedAt === undefined ? '2026-07-19T12:00:00.000Z' : input.confirmedAt,
    paidAt: input.paidAt ?? null,
    createdAt: input.createdAt ?? '2026-07-19T11:00:00.000Z',
    adjustments: input.adjustments ?? []
  };
}

function createInput(overrides: Partial<SettlementCreateInput> = {}): SettlementCreateInput {
  return {
    guildId,
    source: 'MANUAL',
    scheduleKey: null,
    periodStart: '2026-07-13T16:00:00.000Z',
    periodEnd: '2026-07-19T16:00:00.000Z',
    cutoffAt,
    timeZone: 'Asia/Shanghai',
    currency: 'CAT',
    playerUserIds: null,
    createdByStaffId: '00000000-0000-0000-0000-000000006190',
    ...overrides
  };
}

describe('M6-US-01 settlement domain', () => {
  test('selects only confirmed USD earnings at the inclusive cutoff and keeps playerUserId identity', async () => {
    const atCutoff = earning({ id: '00000000-0000-0000-0000-000000006111', confirmedAt: cutoffAt });
    const afterCutoff = earning({ id: '00000000-0000-0000-0000-000000006112', confirmedAt: '2026-07-19T16:00:00.001Z' });
    const pending = earning({ id: '00000000-0000-0000-0000-000000006113', status: 'PENDING', confirmedAt: null });
    const nonUsd = earning({ id: '00000000-0000-0000-0000-000000006114', currency: 'EUR' as never });
    const store = new InMemorySettlementStore({ earnings: [atCutoff, afterCutoff, pending, nonUsd] });

    const preview = await previewSettlement({ store, input: createInput() });

    expect(preview.items).toEqual([
      expect.objectContaining({ playerUserId: playerA, grossAmountMinor: 10_000, netAmountMinor: 10_000 })
    ]);
    expect(preview.items[0]?.entries.map((entry) => entry.playerEarningId)).toEqual([atCutoff.id]);
  });

  test('filters by player user id and rejects currencies outside the P0 USD boundary', async () => {
    const store = new InMemorySettlementStore({ earnings: [
      earning({ id: '00000000-0000-0000-0000-000000006121', playerUserId: playerA }),
      earning({ id: '00000000-0000-0000-0000-000000006122', playerUserId: playerB })
    ] });

    const preview = await previewSettlement({ store, input: createInput({ playerUserIds: [playerB] }) });
    expect(preview.items.map((item) => item.playerUserId)).toEqual([playerB]);
    await expect(previewSettlement({ store, input: createInput({ currency: 'EUR' as never }) }))
      .rejects.toEqual(expect.objectContaining({ code: 'UNSUPPORTED_CURRENCY' }));
  });

  test('snapshots net adjustments and leaves preview storage unchanged', async () => {
    const source = earning({
      id: '00000000-0000-0000-0000-000000006131',
      amountMinor: 10_000,
      adjustments: [
        { id: '00000000-0000-0000-0000-000000006132', playerEarningId: '00000000-0000-0000-0000-000000006131', type: 'CORRECTION_CREDIT', amountMinor: 500, currency: 'CAT', createdAt: '2026-07-19T13:00:00.000Z' },
        { id: '00000000-0000-0000-0000-000000006133', playerEarningId: '00000000-0000-0000-0000-000000006131', type: 'REVERSAL_DEBIT', amountMinor: 2_000, currency: 'CAT', createdAt: '2026-07-19T14:00:00.000Z' }
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
        currency: 'CAT',
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
        currency: 'CAT',
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

  test('keeps an uncovered debit deferred until a later period can absorb it in full', async () => {
    const paid = earning({
      id: '00000000-0000-0000-0000-000000006181',
      status: 'PAID',
      paidAt: '2026-07-18T16:00:00.000Z',
      adjustments: [{
        id: '00000000-0000-0000-0000-000000006182',
        playerEarningId: '00000000-0000-0000-0000-000000006181',
        type: 'CORRECTION_DEBIT', amountMinor: 1_200, currency: 'CAT',
        createdAt: '2026-07-19T15:00:00.000Z'
      }]
    });
    const firstPositive = earning({ id: '00000000-0000-0000-0000-000000006183', amountMinor: 1_000 });
    const store = new InMemorySettlementStore({ earnings: [paid, firstPositive] });

    expect(await previewSettlement({ store, input: createInput() })).toMatchObject({
      items: [], deferredAdjustmentMinor: -1_200
    });

    store.earnings.push(earning({
      id: '00000000-0000-0000-0000-000000006184', amountMinor: 500,
      confirmedAt: '2026-07-20T12:00:00.000Z', createdAt: '2026-07-20T11:00:00.000Z'
    }));
    const later = await createSettlementBatch({ store, input: createInput({
      periodEnd: '2026-07-20T16:00:00.000Z', cutoffAt: '2026-07-20T16:00:00.000Z'
    }) });
    expect(later.items[0]).toMatchObject({ grossAmountMinor: 1_500, adjustmentAmountMinor: -1_200, netAmountMinor: 300 });
  });

  test('rejects a safe-looking pair whose computed net exceeds the safe minor-unit range', async () => {
    const source = earning({
      id: '00000000-0000-0000-0000-000000006185',
      amountMinor: Number.MAX_SAFE_INTEGER,
      adjustments: [{
        id: '00000000-0000-0000-0000-000000006186',
        playerEarningId: '00000000-0000-0000-0000-000000006185',
        type: 'CORRECTION_CREDIT', amountMinor: 1, currency: 'CAT',
        createdAt: '2026-07-19T13:00:00.000Z'
      }]
    });
    await expect(previewSettlement({ store: new InMemorySettlementStore({ earnings: [source] }), input: createInput() }))
      .rejects.toThrow(/safe integer|supported range/i);
  });
});
