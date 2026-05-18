import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemorySettlementStore,
  createSettlementBatch,
  type SettlementBatchRecord,
  type SettlementCandidateEarning,
  type SettlementCreateInput
} from '@blackcat/api/settlements';
import type { AuditRecord, AuditSink, StaffAccount } from '@blackcat/api/security';

const env = {
  NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const guildId = '900000000000006200';
const now = new Date('2026-07-19T18:00:00.000Z');
const makerId = '00000000-0000-0000-0000-000000006291';
const checkerId = '00000000-0000-0000-0000-000000006292';
const l2Id = '00000000-0000-0000-0000-000000006293';
const playerA = '00000000-0000-0000-0000-000000006201';
const playerB = '00000000-0000-0000-0000-000000006202';

function account(staffId: string, level: StaffAccount['level']): StaffAccount {
  return { staffId, userId: staffId, level, permissionsVersion: 1, status: 'ACTIVE' };
}

function headers(discordUserId: string, key?: string, source = 'DASHBOARD') {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': source,
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId,
    ...(key ? { 'idempotency-key': key } : {})
  };
}

function earning(id: string, playerUserId: string, amountMinor: number): SettlementCandidateEarning {
  return {
    id, orderId: id, playerUserId, amountMinor, currency: 'CNY', status: 'CONFIRMED',
    playerDisplayName: playerUserId === playerA ? '陪玩甲' : '陪玩乙',
    playerDiscordUserId: playerUserId === playerA ? '900000000000006201' : '900000000000006202',
    externalAccountDisplay: playerUserId === playerA ? 'provider:***1001' : 'provider:***1002',
    confirmedAt: '2026-07-19T12:00:00.000Z', paidAt: null,
    createdAt: '2026-07-19T11:00:00.000Z', adjustments: []
  };
}

function batchInput(source: 'MANUAL' | 'SCHEDULED' = 'MANUAL'): SettlementCreateInput {
  return {
    source, scheduleKey: source === 'SCHEDULED' ? 'weekly-cny' : null,
    periodStart: '2026-07-13T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
    cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CNY',
    playerUserIds: null, createdByStaffId: makerId
  };
}

async function fixture(input: {
  stepUp?: boolean;
  amountA?: number;
  amountB?: number;
  source?: 'MANUAL' | 'SCHEDULED';
  auditSink?: AuditSink;
  externalAccountA?: string;
  externalAccountB?: string;
} = {}) {
  const store = new InMemorySettlementStore({ earnings: [
    { ...earning('00000000-0000-0000-0000-000000006211', playerA, input.amountA ?? 300_000),
      externalAccountDisplay: input.externalAccountA ?? 'provider:***1001' },
    { ...earning('00000000-0000-0000-0000-000000006212', playerB, input.amountB ?? 250_000),
      externalAccountDisplay: input.externalAccountB ?? 'provider:***1002' }
  ] });
  const batch = await createSettlementBatch({ store, input: batchInput(input.source) });
  const staff = new Map<string, StaffAccount>([
    ['maker', account(makerId, 'L4_ADMIN_OWNER')],
    ['checker', account(checkerId, 'L4_ADMIN_OWNER')],
    ['operator', account(checkerId, 'L3_OPERATIONS')],
    ['supervisor', account(l2Id, 'L2_SUPERVISOR')]
  ]);
  const server = buildApiServer({
    env,
    security: {
      staffDirectory: { resolveByDiscord: ({ discordUserId }) => staff.get(discordUserId) ?? null },
      stepUpVerifier: { verify: () => input.stepUp ?? true }, auditSink: input.auditSink
    },
    settlements: {
      store, now: () => now, manualDualReviewFromMinor: 400_000, l4ReviewFromMinor: 500_000
    }
  });
  return { server, store, batch };
}

async function submit(f: Awaited<ReturnType<typeof fixture>>, actor = 'maker', version = 1, key = `m6:submit:${actor}:0001`) {
  return f.server.inject({
    method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/submit`,
    headers: headers(actor, key),
    payload: { expectedVersion: version, reasonCode: 'WEEKLY_REVIEW' }
  });
}

async function approve(f: Awaited<ReturnType<typeof fixture>>, actor: string, version: number) {
  return f.server.inject({
    method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/approve`,
    headers: headers(actor, `m6:approve:${actor}:0001`),
    payload: { expectedVersion: version, reasonCode: 'PAYMENT_LIST_CHECKED' }
  });
}

describe('M6-US-02 settlement review, export, and payment API', () => {
  test('rejects malformed settlement dates as validation errors', async () => {
    const f = await fixture();
    const response = await f.server.inject({
      method: 'POST', url: '/api/v1/admin/settlement-batches/preview', headers: headers('operator'),
      payload: { ...batchInput(), periodStart: 'not-a-date' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  test('is Dashboard-only, gives L2 read access, and keeps management at L3+', async () => {
    const f = await fixture();
    const listed = await f.server.inject({ method: 'GET', url: '/api/v1/admin/settlement-batches', headers: headers('supervisor') });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: { items: [{ id: f.batch.id }], nextCursor: null } });

    const denied = await submit(f, 'supervisor');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });

    const bot = await f.server.inject({ method: 'GET', url: '/api/v1/admin/settlement-batches', headers: headers('checker', undefined, 'DISCORD_BOT') });
    expect(bot.statusCode).toBe(403);
    expect(bot.json()).toMatchObject({ error: { code: 'CLIENT_SOURCE_NOT_ACCEPTED' } });
  });

  test('requires recent step-up, a reason, an idempotency key, and the current version for review writes', async () => {
    const f = await fixture({ stepUp: false });
    expect((await submit(f)).statusCode).toBe(428);

    const active = await fixture();
    const missingReason = await active.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${active.batch.id}/submit`,
      headers: headers('maker', 'm6:submit:no-reason'), payload: { expectedVersion: 1 }
    });
    expect(missingReason.statusCode).toBe(400);
    expect(missingReason.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    expect((await submit(active, 'maker', 99, 'm6:submit:stale:0001')).statusCode).toBe(409);
    const submitted = await submit(active);
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ data: { status: 'PENDING_REVIEW', version: 2 } });
    const replay = await submit(active);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(active.store.batches[0]?.version).toBe(2);
  });

  test('enforces manual high-value maker-checker and L4 threshold by actor identity, not inherited role', async () => {
    const f = await fixture();
    await submit(f);

    const selfApproval = await approve(f, 'maker', 2);
    expect(selfApproval.statusCode).toBe(403);
    expect(selfApproval.json()).toMatchObject({ error: { code: 'MAKER_CHECKER_REQUIRED' } });

    const l3Approval = await approve(f, 'operator', 2);
    expect(l3Approval.statusCode).toBe(403);
    expect(l3Approval.json()).toMatchObject({ error: { code: 'L4_APPROVAL_REQUIRED' } });

    const approved = await approve(f, 'checker', 2);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ data: { status: 'APPROVED', version: 3, approvedByStaffId: checkerId } });
  });

  test('allows creator review for scheduled and below-threshold manual batches', async () => {
    const scheduled = await fixture({ source: 'SCHEDULED', amountA: 20_000, amountB: 10_000 });
    await submit(scheduled);
    expect((await approve(scheduled, 'maker', 2)).statusCode).toBe(200);

    const manual = await fixture({ amountA: 20_000, amountB: 10_000 });
    await submit(manual);
    expect((await approve(manual, 'maker', 2)).statusCode).toBe(200);
  });

  test('exports deterministic UTF-8 BOM RFC4180 CSV with fixed columns and no bank data', async () => {
    const f = await fixture({ amountA: 20_000, amountB: 10_000 });
    await submit(f);
    await approve(f, 'checker', 2);
    const response = await f.server.inject({
      method: 'GET', url: `/api/v1/admin/settlement-batches/${f.batch.id}/exports/TRANSFER_LIST`,
      headers: headers('checker')
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/u);
    expect(response.body.charCodeAt(0)).toBe(0xfeff);
    const lines = response.body.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('batch_public_id,period_start,period_end,player_user_id,player_display_name,discord_user_id,external_account_display,currency,gross_amount,adjustment_amount,net_amount,payment_status');
    expect(lines[1]).toContain(`${playerA},陪玩甲,900000000000006201,provider:***1001,CNY,200.00,0.00,200.00,PENDING`);
    expect(lines[2]).toContain(`${playerB},陪玩乙,900000000000006202,provider:***1002,CNY,100.00,0.00,100.00,PENDING`);
    expect(response.body.toLowerCase()).not.toMatch(/bank|card|account_number|银行卡|收款账号/u);
    expect(f.store.batches[0]?.status).toBe('APPROVED');
  });

  test('never exposes a complete short external account and reveals only the last four of longer values', async () => {
    const f = await fixture({
      amountA: 20_000,
      amountB: 10_000,
      externalAccountA: 'provider:1234',
      externalAccountB: 'provider:12345'
    });
    await submit(f);
    await approve(f, 'checker', 2);
    const response = await f.server.inject({
      method: 'GET', url: `/api/v1/admin/settlement-batches/${f.batch.id}/exports/TRANSFER_LIST`,
      headers: headers('checker')
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`${playerA},陪玩甲,900000000000006201,provider:***,CNY`);
    expect(response.body).toContain(`${playerB},陪玩乙,900000000000006202,provider:***2345,CNY`);
    expect(response.body).not.toContain('provider:1234');
    expect(response.body).not.toContain('provider:12345');
  });

  test('stages submit, approve, payment results, and void until the success audit is durable', async () => {
    const auditSink = new FailNextSuccessAuditSink();
    const f = await fixture({ amountA: 20_000, amountB: 10_000, auditSink });

    auditSink.failNextSuccess = true;
    expect((await submit(f)).statusCode).toBe(500);
    expect(f.store.batches[0]).toMatchObject({ status: 'DRAFT', version: 1 });
    expect((await submit(f)).statusCode).toBe(200);

    auditSink.failNextSuccess = true;
    expect((await approve(f, 'checker', 2)).statusCode).toBe(500);
    expect(f.store.batches[0]).toMatchObject({ status: 'PENDING_REVIEW', version: 2 });
    expect((await approve(f, 'checker', 2)).statusCode).toBe(200);

    const item = f.store.batches[0]!.items[0]!;
    const paymentPayload = { expectedBatchVersion: 3, results: [{
      settlementItemId: item.id, expectedVersion: 1, result: 'SUCCEEDED',
      amountMinor: item.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-STAGED'
    }] };
    auditSink.failNextSuccess = true;
    expect((await postResults(f, 'm6:payment:staged:01', paymentPayload)).statusCode).toBe(500);
    expect(f.store.batches[0]).toMatchObject({ status: 'APPROVED', version: 3 });
    expect(f.store.earnings.every((candidate) => candidate.status === 'CONFIRMED')).toBe(true);
    expect((await postResults(f, 'm6:payment:staged:01', paymentPayload)).statusCode).toBe(200);

    const voidFixture = await fixture({ amountA: 20_000, amountB: 10_000, auditSink });
    auditSink.failNextSuccess = true;
    const voidRequest = () => voidFixture.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${voidFixture.batch.id}/void`,
      headers: headers('checker', 'm6:void:staged:0001'),
      payload: { expectedVersion: 1, reasonCode: 'GENERATED_IN_ERROR' }
    });
    expect((await voidRequest()).statusCode).toBe(500);
    expect(voidFixture.store.batches[0]).toMatchObject({ status: 'DRAFT', version: 1 });
    expect((await voidRequest()).statusCode).toBe(200);
  });

  test('keeps export pure read when success audit append fails', async () => {
    let failAudit = false;
    const f = await fixture({
      amountA: 20_000, amountB: 10_000,
      auditSink: { append: () => { if (failAudit) { failAudit = false; throw new Error('audit unavailable'); } } }
    });
    await submit(f);
    await approve(f, 'checker', 2);
    failAudit = true;
    const response = await f.server.inject({
      method: 'GET', url: `/api/v1/admin/settlement-batches/${f.batch.id}/exports/TRANSFER_LIST`,
      headers: headers('checker')
    });
    expect(response.statusCode).toBe(500);
    expect(f.store.batches[0]).toMatchObject({ status: 'APPROVED', version: 3, exportedAt: null });
  });

  test('does not publish settlement writes when success audit cannot be appended', async () => {
    let failAudit = true;
    const f = await fixture({ auditSink: { append: () => { if (failAudit) throw new Error('audit unavailable'); } } });
    const failed = await submit(f, 'maker', 1, 'm6:submit:audit-failure');
    expect(failed.statusCode).toBe(500);
    expect(f.store.batches[0]).toMatchObject({ status: 'DRAFT', version: 1 });

    failAudit = false;
    const retried = await submit(f, 'maker', 1, 'm6:submit:audit-failure');
    expect(retried.statusCode).toBe(200);
    expect(f.store.batches[0]).toMatchObject({ status: 'PENDING_REVIEW', version: 2 });
  });

  test('does not create a batch when its success audit cannot be committed', async () => {
    let failAudit = true;
    const store = new InMemorySettlementStore({ earnings: [earning('00000000-0000-0000-0000-000000006219', playerA, 20_000)] });
    const server = buildApiServer({ env, security: {
      staffDirectory: { resolveByDiscord: () => account(makerId, 'L4_ADMIN_OWNER') },
      stepUpVerifier: { verify: () => true }, auditSink: { append: () => { if (failAudit) throw new Error('audit unavailable'); } }
    }, settlements: { store, now: () => now, manualDualReviewFromMinor: 400_000, l4ReviewFromMinor: 500_000 } });
    const request = () => server.inject({ method: 'POST', url: '/api/v1/admin/settlement-batches',
      headers: headers('maker', 'm6:create:audit-failure:2'), payload: { ...batchInput(), playerUserIds: undefined } });
    expect((await request()).statusCode).toBe(500);
    expect(store.batches).toHaveLength(0);
    failAudit = false;
    const retry = await request();
    expect(retry.statusCode, retry.body).toBe(201);
    expect(store.batches).toHaveLength(1);
  });

  test('records whole-item results append-only, supports failed retry, and pays only successful earnings', async () => {
    const f = await fixture({ amountA: 20_000, amountB: 10_000 });
    await submit(f);
    await approve(f, 'checker', 2);
    await f.server.inject({ method: 'GET', url: `/api/v1/admin/settlement-batches/${f.batch.id}/exports/TRANSFER_LIST`, headers: headers('checker') });
    const [firstItem, secondItem] = f.store.batches[0]!.items;

    const first = await f.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/payment-results`,
      headers: headers('checker', 'm6:payment:batch:0001'),
      payload: { expectedBatchVersion: 3, results: [
        { settlementItemId: firstItem!.id, expectedVersion: 1, result: 'SUCCEEDED', amountMinor: firstItem!.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-001' },
        { settlementItemId: secondItem!.id, expectedVersion: 1, result: 'FAILED', amountMinor: 0, currency: 'CNY', note: 'provider rejected row' }
      ] }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ data: { status: 'PARTIALLY_PAID', items: [
      { paymentStatus: 'SUCCEEDED', paymentResults: [{ result: 'SUCCEEDED' }] },
      { paymentStatus: 'FAILED', paymentResults: [{ result: 'FAILED' }] }
    ] } });
    expect(f.store.earnings.find((item) => item.playerUserId === playerA)?.status).toBe('PAID');
    expect(f.store.earnings.find((item) => item.playerUserId === playerB)?.status).toBe('CONFIRMED');

    const voidPartial = await f.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/void`,
      headers: headers('checker', 'm6:void:partial:0001'),
      payload: { expectedVersion: 5, reasonCode: 'PAYMENT_STARTED', note: 'must remain immutable' }
    });
    expect(voidPartial.statusCode).toBe(409);
    expect(f.store.batches[0]?.status).toBe('PARTIALLY_PAID');

    const replay = await f.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/payment-results`,
      headers: headers('checker', 'm6:payment:batch:0001'),
      payload: { expectedBatchVersion: 3, results: [
        { settlementItemId: firstItem!.id, expectedVersion: 1, result: 'SUCCEEDED', amountMinor: firstItem!.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-001' },
        { settlementItemId: secondItem!.id, expectedVersion: 1, result: 'FAILED', amountMinor: 0, currency: 'CNY', note: 'provider rejected row' }
      ] }
    });
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(f.store.batches[0]!.items.flatMap((item) => item.paymentResults)).toHaveLength(2);

    const retry = await f.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/payment-results`,
      headers: headers('checker', 'm6:payment:batch:0002'),
      payload: { expectedBatchVersion: 5, results: [
        { settlementItemId: secondItem!.id, expectedVersion: 2, result: 'SUCCEEDED', amountMinor: secondItem!.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-002' }
      ] }
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ data: { status: 'PAID' } });
    expect(f.store.earnings.every((item) => item.status === 'PAID')).toBe(true);
  });

  test('rejects partial successful amounts, missing evidence, duplicate success, and stale item versions', async () => {
    const f = await approvedAndExported();
    const item = f.store.batches[0]!.items[0]!;
    const base = { expectedBatchVersion: 3, results: [{ settlementItemId: item.id, expectedVersion: 1, result: 'SUCCEEDED', amountMinor: item.netAmountMinor - 1, currency: 'CNY', note: 'wrong amount' }] };
    expect((await postResults(f, 'm6:payment:invalid:01', base)).statusCode).toBe(400);
    expect((await postResults(f, 'm6:payment:invalid:02', { ...base, results: [{ ...base.results[0], amountMinor: item.netAmountMinor, note: '' }] })).statusCode).toBe(400);
    expect((await postResults(f, 'm6:payment:valid:0001', { ...base, results: [{ ...base.results[0], amountMinor: item.netAmountMinor, note: 'paid externally' }] })).statusCode).toBe(200);
    expect((await postResults(f, 'm6:payment:duplicate:1', { expectedBatchVersion: 5, results: [{ ...base.results[0], expectedVersion: 2, amountMinor: item.netAmountMinor, note: 'duplicate' }] })).statusCode).toBe(409);
  });

  test('restricts void to L4 and preserves the terminal batch history', async () => {
    const f = await fixture({ amountA: 20_000, amountB: 10_000 });
    const l3 = await f.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/void`,
      headers: headers('operator', 'm6:void:operator:01'),
      payload: { expectedVersion: 1, reasonCode: 'GENERATED_IN_ERROR', note: 'No replacement required.' }
    });
    expect(l3.statusCode).toBe(403);
    const voided = await f.server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/void`,
      headers: headers('checker', 'm6:void:checker:01'),
      payload: { expectedVersion: 1, reasonCode: 'GENERATED_IN_ERROR', note: 'No replacement required.' }
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json()).toMatchObject({ data: { status: 'VOIDED', version: 2 } });
    expect((await submit(f, 'checker', 2)).statusCode).toBe(409);
  });
});

async function approvedAndExported() {
  const f = await fixture({ amountA: 20_000, amountB: 10_000 });
  await submit(f);
  await approve(f, 'checker', 2);
  await f.server.inject({ method: 'GET', url: `/api/v1/admin/settlement-batches/${f.batch.id}/exports/TRANSFER_LIST`, headers: headers('checker') });
  return f;
}

function postResults(f: Awaited<ReturnType<typeof fixture>>, key: string, payload: unknown) {
  return f.server.inject({
    method: 'POST', url: `/api/v1/admin/settlement-batches/${f.batch.id}/payment-results`,
    headers: headers('checker', key), payload
  });
}

class FailNextSuccessAuditSink implements AuditSink {
  failNextSuccess = false;
  readonly records: AuditRecord[] = [];

  append(record: AuditRecord): void {
    if (record.outcome === 'SUCCEEDED' && this.failNextSuccess) {
      this.failNextSuccess = false;
      throw new Error('audit unavailable');
    }
    this.records.push(record);
  }
}
