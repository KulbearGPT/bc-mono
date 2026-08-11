import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { PostgresAccountStore } from '@blackcat/api/accounts';
import { PostgresCustomerProfileStore } from '@blackcat/api/customer-profiles';
import { PostgresOnboardingStore } from '@blackcat/api/onboarding';
import {
  PostgresAuditSink,
  PostgresIdempotencyStore,
  type AuditRecord,
  type StaffAccount,
  type StaffLevel
} from '@blackcat/api/security';
import { PostgresWalletStore } from '@blackcat/api/wallet';
import {
  expectAppendOnlyDelta,
  expectAuditAtomicity,
  expectGuildIsolation,
  expectIdempotentReplay,
  expectNoBusinessWrites,
  expectPrivacyAllowlist,
  expectWalletInvariant,
  snapshotBusinessFacts
} from '../support/non-ui-assertions';
import { startIsolatedPostgres, type IsolatedPostgres } from '../support/isolated-postgres';
import { createActorFixture, createGuildFixture, stableSnowflake, stableUuid } from '../support/non-ui-fixtures/actors';

const now = new Date('2026-08-14T12:00:00.000Z');
const env = {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost',
  BOT_SERVICE_TOKEN: 'valid-bot-token',
  PAGINATION_CURSOR_SIGNING_SECRET: 'nui-a1-account-wallet-signing-secret-32-bytes'
};
let database: IsolatedPostgres;
let pool: Pool;

interface Scenario {
  id: string;
  guildId: string;
  otherGuildId: string;
  customerId: string;
  customerDiscordId: string;
  staffUserId: string;
  staffId: string;
  staffDiscordId: string;
  playerRoleId: string;
  applicantRoleId: string;
}

describe('NUI-A1 account, onboarding and CAT wallet automation', () => {
  beforeAll(async () => {
    database = await startIsolatedPostgres('a1_account_wallet');
    pool = database.pool;
  }, 40_000);

  afterAll(async () => database.stop());

  test('BNUI-ACC-001 registers one trusted Discord account, CAT wallet and role task with idempotent audit', async () => {
    const scenario = scenarioFixture('BNUI-ACC-001', 1);
    await seedStaffAndConfig(scenario);
    const server = onboardingServer();
    const headers = botHeaders(scenario.customerDiscordId, scenario.guildId, 'nui:a1:register:1');
    const payload = {
      displayName: '可信新人',
      userId: stableUuid('forged-user'),
      guildId: scenario.otherGuildId,
      discordUserId: stableSnowflake('forged-discord-user')
    };

    const first = await server.inject({ method: 'POST', url: '/api/v1/me/player-registration', headers, payload });
    const replay = await server.inject({ method: 'POST', url: '/api/v1/me/player-registration', headers, payload });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().data).toEqual(first.json().data);
    expect(first.json().data).toMatchObject({
      guildId: scenario.guildId,
      discordUserId: scenario.customerDiscordId,
      playerRoleId: scenario.playerRoleId,
      roleSyncStatus: 'PENDING'
    });
    const facts = await pool.query(
      `SELECT
      (SELECT count(*)::int FROM users u JOIN discord_accounts d ON d.user_id=u.id
        WHERE d.guild_id=$1 AND d.discord_user_id=$2) users,
      (SELECT count(*)::int FROM wallet_accounts w JOIN discord_accounts d ON d.user_id=w.user_id
        WHERE d.guild_id=$1 AND d.discord_user_id=$2 AND w.currency='CAT') wallets,
      (SELECT count(*)::int FROM discord_product_role_tasks
        WHERE guild_id=$1 AND discord_user_id=$2 AND role_id=$3) role_tasks,
      (SELECT count(*)::int FROM audit_logs WHERE action='REGISTER_DISCORD_PLAYER' AND outcome='SUCCEEDED') audits`,
      [scenario.guildId, scenario.customerDiscordId, scenario.playerRoleId]
    );
    expect(facts.rows[0]).toEqual({ users: 1, wallets: 1, role_tasks: 1, audits: 1 });
    expectAuditAtomicity({ businessWrites: 3, successAuditWrites: 1, rejectedAuditWrites: 0 });
    await server.close();
  });

  test('BNUI-ACC-002 creates one pending companion application and rejects an untrusted source with zero writes', async () => {
    const scenario = scenarioFixture('BNUI-ACC-002', 2);
    await seedStaffAndConfig(scenario);
    const server = onboardingServer();
    const headers = botHeaders(scenario.customerDiscordId, scenario.guildId, 'nui:a1:companion:2');
    const payload = { displayName: '陪玩申请人' };
    const first = await server.inject({ method: 'POST', url: '/api/v1/me/companion-application', headers, payload });
    const replay = await server.inject({ method: 'POST', url: '/api/v1/me/companion-application', headers, payload });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().data).toEqual(first.json().data);

    const before = await snapshotBusinessFacts(pool, [
      'companion_review_events',
      'discord_accounts',
      'discord_product_role_tasks',
      'player_profiles',
      'users',
      'wallet_accounts'
    ]);
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/me/companion-application',
      headers: { ...headers, 'x-client-source': 'DASHBOARD', 'idempotency-key': 'nui:a1:companion:untrusted' },
      payload: { displayName: '伪造来源' }
    });
    expect(rejected.statusCode).toBe(403);
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, Object.keys(before)));
    const facts = await pool.query(
      `SELECT
      (SELECT count(*)::int FROM player_profiles p JOIN discord_accounts d ON d.user_id=p.user_id
        WHERE d.guild_id=$1 AND d.discord_user_id=$2 AND p.review_status='PENDING_REVIEW') profiles,
      (SELECT count(*)::int FROM companion_review_events e JOIN player_profiles p ON p.id=e.player_profile_id
        JOIN discord_accounts d ON d.user_id=p.user_id WHERE d.guild_id=$1 AND d.discord_user_id=$2) events,
      (SELECT count(*)::int FROM discord_product_role_tasks
        WHERE guild_id=$1 AND discord_user_id=$2) role_tasks`,
      [scenario.guildId, scenario.customerDiscordId]
    );
    expect(facts.rows[0]).toEqual({ profiles: 1, events: 1, role_tasks: 2 });
    await server.close();
  });

  test('BNUI-ACC-003 keeps current-user profile and paginated orders private to the trusted Guild actor', async () => {
    const scenario = scenarioFixture('BNUI-ACC-003', 3);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    await seedOrders(scenario, 2);
    const wallet = new PostgresWalletStore({ pool });
    await commitTopUp(wallet, scenario, 5_000, 'profile-credit');
    const server = accountServer(scenario, wallet);
    const headers = botHeaders(scenario.customerDiscordId, scenario.guildId, 'nui:a1:profile:read');

    const current = await server.inject({ method: 'GET', url: '/api/v1/me', headers });
    const profile = await server.inject({ method: 'GET', url: '/api/v1/me/profile', headers });
    const firstPage = await server.inject({ method: 'GET', url: '/api/v1/me/orders?limit=1', headers });
    expect(current.statusCode, current.body).toBe(200);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().data.items).toHaveLength(1);
    expect(firstPage.json().data.nextCursor).toEqual(expect.any(String));
    const secondPage = await server.inject({
      method: 'GET',
      url: `/api/v1/me/orders?limit=1&cursor=${encodeURIComponent(firstPage.json().data.nextCursor as string)}`,
      headers
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().data.items).toHaveLength(1);
    expect(secondPage.json().data.nextCursor).toBeNull();
    expect(
      new Set([...firstPage.json().data.items, ...secondPage.json().data.items].map((item: { id: string }) => item.id))
        .size
    ).toBe(2);
    expect(profile.json().data).toMatchObject({
      user: { userId: scenario.customerId, discordUserId: scenario.customerDiscordId },
      balance: { currency: 'CAT', ledgerBalanceMinor: 5_000, availableMinor: 5_000 }
    });
    expect(profile.body).not.toMatch(/internalNotes|authorStaffId|receiptNumber|beneficiaryUserId|idempotencyKey/u);

    const crossGuild = await server.inject({
      method: 'GET',
      url: '/api/v1/me/profile',
      headers: botHeaders(scenario.customerDiscordId, scenario.otherGuildId, 'nui:a1:profile:cross-guild')
    });
    expect([403, 404]).toContain(crossGuild.statusCode);
    expectGuildIsolation({ listRows: [], detailVisible: false, businessWriteDelta: 0 });
    await server.close();
  });

  test('BNUI-WLT-001 calculates one CAT balance from append-only entries and active order plus gift reservations', async () => {
    const scenario = scenarioFixture('BNUI-WLT-001', 4);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    const wallet = new PostgresWalletStore({ pool });
    await commitTopUp(wallet, scenario, 10_000, 'balance-credit');
    await seedOrderAndGiftReservations(scenario, 1_200, 800);

    const balance = await wallet.getBalance({ userId: scenario.customerId, now });
    expect(balance).toMatchObject({
      ledgerBalanceMinor: 10_000,
      reservedMinor: 2_000,
      availableMinor: 8_000,
      currency: 'CAT'
    });
    expectWalletInvariant(balance);
    expectPrivacyAllowlist(balance, [
      'ledgerBalanceMinor',
      'reservedMinor',
      'availableMinor',
      'currency',
      'calculatedAt',
      'version'
    ]);
  });

  test('BNUI-WLT-002 credits USD cents as CAT once, rejects duplicate receipts and exposes only paginated public entries', async () => {
    const scenario = scenarioFixture('BNUI-WLT-002', 5);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    const wallet = new PostgresWalletStore({ pool });
    const first = await commitTopUp(wallet, scenario, 1_234, 'receipt-once');
    expect(first).toMatchObject({
      paidAmountUsdCents: 1_234,
      paidCurrency: 'USD',
      rateCatPerUsd: 10,
      creditedCatSubunits: 1_234,
      currency: 'CAT'
    });
    const duplicate = await wallet.stageCreateTopUp(
      topUpInput(scenario, 500, 'receipt-duplicate', {
        paymentChannel: first.paymentMethod,
        externalTransactionId: first.receiptNumber
      })
    );
    await expect(
      duplicate.commit(walletAudit(scenario, 'duplicate-receipt', 'CREATE_ADMIN_TOP_UP'))
    ).rejects.toMatchObject({ code: 'DUPLICATE_EXTERNAL_TRANSACTION' });
    const page = await wallet.listEntries({ userId: scenario.customerId, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ entryType: 'TOP_UP_CREDIT', amountMinor: 1_234, currency: 'CAT' });
    expect(JSON.stringify(page)).not.toMatch(/receipt|payment|note|storageKey|sha256/iu);
    const facts = await pool.query(
      `SELECT count(*)::int topups,
      bool_and(paid_currency='USD' AND rate_cat_per_usd=10 AND credited_cat_subunits=paid_amount_usd_cents) valid_evidence
      FROM top_ups t JOIN wallet_accounts w ON w.id=t.wallet_account_id WHERE w.user_id=$1`,
      [scenario.customerId]
    );
    expect(facts.rows[0]).toEqual({ topups: 1, valid_evidence: true });
  });

  test('BNUI-WLT-003 denies L1, stale step-up and invalid top-up input without wallet business writes', async () => {
    const scenario = scenarioFixture('BNUI-WLT-003', 6);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    const tables = ['external_refund_debits', 'top_ups', 'wallet_accounts', 'wallet_entries'];
    const before = await snapshotBusinessFacts(pool, tables);
    const l1 = walletServer(scenario, 'L1_SUPPORT', true);
    const stale = walletServer(scenario, 'L2_SUPERVISOR', false);
    const l2 = walletServer(scenario, 'L2_SUPERVISOR', true);
    const payload = {
      paidAmountUsdCents: 100,
      paymentMethod: 'BANK_TRANSFER',
      receiptNumber: 'nui-a1-denied',
      paidAt: now.toISOString(),
      note: 'receipt checked',
      reasonCode: 'MANUAL_TOP_UP'
    };
    const denied = await l1.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${scenario.customerId}/top-ups`,
      headers: dashboardHeaders('nui:a1:l1-denied'),
      payload
    });
    const stepUp = await stale.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${scenario.customerId}/top-ups`,
      headers: dashboardHeaders('nui:a1:stepup-denied'),
      payload: { ...payload, receiptNumber: 'nui-a1-stale' }
    });
    const invalid = await l2.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${scenario.customerId}/top-ups`,
      headers: dashboardHeaders('nui:a1:invalid-denied'),
      payload: { ...payload, paidAmountUsdCents: 0, receiptNumber: '' }
    });
    const nonUsd = await l2.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${scenario.customerId}/top-ups`,
      headers: dashboardHeaders('nui:a1:currency-denied'),
      payload: { ...payload, paidCurrency: 'CAT', receiptNumber: 'nui-a1-non-usd' }
    });
    expect(denied.statusCode).toBe(403);
    expect(stepUp.statusCode).toBe(428);
    expect([400, 422]).toContain(invalid.statusCode);
    expect(nonUsd.statusCode).toBe(400);
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, tables));
    const rejectedAudits = await pool.query(
      `SELECT outcome::text,count(*)::int count FROM audit_logs
      WHERE action='CREATE_ADMIN_TOP_UP' AND target_id=$1 GROUP BY outcome ORDER BY outcome`,
      [scenario.customerId]
    );
    expect(rejectedAudits.rows).toEqual([
      { outcome: 'FAILED', count: 2 },
      { outcome: 'REJECTED', count: 2 }
    ]);
    await Promise.all([l1.close(), stale.close(), l2.close()]);
  });

  test('BNUI-WLT-004 rejects an overdrawn offline refund then appends one valid non-negative debit and audit', async () => {
    const scenario = scenarioFixture('BNUI-WLT-004', 7);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    const wallet = new PostgresWalletStore({ pool });
    await commitTopUp(wallet, scenario, 1_000, 'refund-credit');
    const before = await snapshotBusinessFacts(pool, ['external_refund_debits', 'wallet_entries']);
    await expect(
      wallet.stageCreateExternalRefundDebit(refundInput(scenario, 1_001, 2, 'refund-too-large'))
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_BALANCE' });
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, Object.keys(before)));

    const valid = await wallet.stageCreateExternalRefundDebit(refundInput(scenario, 400, 2, 'refund-valid'));
    await valid.commit(walletAudit(scenario, 'refund-valid', 'CREATE_ADMIN_CASH_REFUND_DEBIT'));
    const after = await snapshotBusinessFacts(pool, Object.keys(before));
    expectAppendOnlyDelta(before, after, { external_refund_debits: 1, wallet_entries: 1 });
    await expect(
      pool.query(`UPDATE wallet_entries SET amount_minor=1 WHERE id=$1`, [valid.data.walletEntry.id])
    ).rejects.toThrow(/append-only|immutable/u);
    await expect(pool.query(`DELETE FROM wallet_entries WHERE id=$1`, [valid.data.walletEntry.id])).rejects.toThrow(
      /append-only|immutable/u
    );
    await expect(
      pool.query(`UPDATE external_refund_debits SET note='rewritten' WHERE id=$1`, [valid.data.id])
    ).rejects.toThrow(/append-only|immutable/u);
    const balance = await wallet.getBalance({ userId: scenario.customerId, now });
    expect(balance).toMatchObject({ ledgerBalanceMinor: 600, reservedMinor: 0, availableMinor: 600, currency: 'CAT' });
    expectWalletInvariant(balance);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int count FROM audit_logs
      WHERE action='CREATE_ADMIN_CASH_REFUND_DEBIT' AND target_id=$1`,
          [scenario.customerId]
        )
      ).rows[0].count
    ).toBe(1);
  });

  test('BNUI-WLT-005 converges a lost-response replay and concurrent refund race to one credit and one debit', async () => {
    const scenario = scenarioFixture('BNUI-WLT-005', 8);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    const server = walletServer(scenario, 'L2_SUPERVISOR', true);
    const topUpHeaders = dashboardHeaders('nui:a1:lost-response');
    const payload = {
      paidAmountUsdCents: 1_000,
      paymentMethod: 'ZELLE',
      receiptNumber: 'nui-a1-lost-response',
      paidAt: now.toISOString(),
      note: 'response intentionally discarded',
      reasonCode: 'MANUAL_TOP_UP'
    };
    const first = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${scenario.customerId}/top-ups`,
      headers: topUpHeaders,
      payload
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${scenario.customerId}/top-ups`,
      headers: topUpHeaders,
      payload
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    const firstId = first.json().data.id as string;
    const replayId = replay.json().data.id as string;
    expectIdempotentReplay({
      firstObjectId: firstId,
      replayObjectId: replayId,
      firstSideEffectCount: 1,
      replaySideEffectCount: 1
    });

    const debitPayload = (receiptNumber: string) => ({
      amountMinor: 700,
      paymentChannel: 'ZELLE',
      externalTransactionId: receiptNumber,
      refundedAt: now.toISOString(),
      note: 'offline refund completed',
      expectedWalletVersion: 2
    });
    const [left, right] = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${scenario.customerId}/external-refund-debits`,
        headers: dashboardHeaders('nui:a1:refund-race:left'),
        payload: debitPayload('nui-a1-race-left')
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${scenario.customerId}/external-refund-debits`,
        headers: dashboardHeaders('nui:a1:refund-race:right'),
        payload: debitPayload('nui-a1-race-right')
      })
    ]);
    const raceStatuses = [left.statusCode, right.statusCode];
    expect(raceStatuses.filter((status) => status === 201)).toHaveLength(1);
    expect(raceStatuses.filter((status) => status === 409 || status === 422)).toHaveLength(1);
    const facts = await pool.query(
      `SELECT
      (SELECT count(*)::int FROM top_ups t JOIN wallet_accounts w ON w.id=t.wallet_account_id WHERE w.user_id=$1) topups,
      (SELECT count(*)::int FROM external_refund_debits d JOIN wallet_accounts w ON w.id=d.wallet_account_id WHERE w.user_id=$1) debits,
      (SELECT count(*)::int FROM wallet_entries e JOIN wallet_accounts w ON w.id=e.wallet_account_id WHERE w.user_id=$1) entries`,
      [scenario.customerId]
    );
    expect(facts.rows[0]).toEqual({ topups: 1, debits: 1, entries: 2 });
    expectWalletInvariant(await new PostgresWalletStore({ pool }).getBalance({ userId: scenario.customerId, now }));
    await server.close();
  });

  test('BNUI-WLT-006 keeps payment providers and webhooks retired with unknown routes and zero business writes', async () => {
    const scenario = scenarioFixture('BNUI-WLT-006', 9);
    await seedCustomerAndStaff(scenario, 'L2_SUPERVISOR');
    const server = walletServer(scenario, 'L2_SUPERVISOR', true);
    const tables = ['external_refund_debits', 'top_ups', 'wallet_accounts', 'wallet_entries'];
    const before = await snapshotBusinessFacts(pool, tables);
    for (const url of ['/api/v1/webhooks/payment', '/api/v1/payment/webhook', '/api/v1/funding/provider/balance']) {
      const response = await server.inject({
        method: 'POST',
        url,
        headers: dashboardHeaders(`nui:a1:retired:${url.length}`),
        payload: {}
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
    }
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, tables));
    const routes = server.printRoutes().toLowerCase();
    expect(routes).not.toMatch(/payment.*webhook|webhook.*payment|provider.*balance/u);
    const [serverSource, productionEntry] = await Promise.all([
      readFile('apps/api/src/server.ts', 'utf8'),
      readFile('apps/api/src/index.ts', 'utf8')
    ]);
    expect(`${serverSource}\n${productionEntry}`).not.toMatch(
      /registerPaymentWebhook|createProviderBalance|FundingAdapter/u
    );
    await server.close();
  });
});

function scenarioFixture(id: string, sequence: number): Scenario {
  const actors = createActorFixture(id, sequence);
  const guilds = createGuildFixture(id, sequence);
  return {
    id,
    guildId: guilds.primary.discordGuildId,
    otherGuildId: guilds.secondary.discordGuildId,
    customerId: actors.customerId,
    customerDiscordId: actors.discordCustomerId,
    staffUserId: actors.staffL2Id,
    staffId: stableUuid(`${id}:${sequence}:staff-account`),
    staffDiscordId: stableSnowflake(`${id}:${sequence}:staff-discord`),
    playerRoleId: stableSnowflake(`${id}:${sequence}:player-role`),
    applicantRoleId: stableSnowflake(`${id}:${sequence}:applicant-role`)
  };
}

async function seedStaffAndConfig(scenario: Scenario, level: StaffLevel = 'L2_SUPERVISOR'): Promise<void> {
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
    VALUES($1,$2,'ACTIVE',1,$3,$3)`,
    [scenario.staffUserId, `${scenario.id} staff`, now]
  );
  await pool.query(
    `INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES($1,$2,$3,'ACTIVE','MANUAL',1,$4,$4)`,
    [scenario.staffId, scenario.staffUserId, level, now]
  );
  await pool.query(
    `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,$5)`,
    [
      stableUuid(`${scenario.id}:staff-discord-account`),
      scenario.staffUserId,
      scenario.guildId,
      scenario.staffDiscordId,
      now
    ]
  );
  await pool.query(
    `INSERT INTO guild_bot_configs(guild_id,version,config_json,updated_by_staff_id,updated_at)
    VALUES($1,1,$2::jsonb,$3,$4)`,
    [
      scenario.guildId,
      JSON.stringify({ player_role_id: scenario.playerRoleId, companion_applicant_role_id: scenario.applicantRoleId }),
      scenario.staffId,
      now
    ]
  );
}

async function seedCustomerAndStaff(scenario: Scenario, level: StaffLevel): Promise<void> {
  await seedStaffAndConfig(scenario, level);
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
    VALUES($1,$2,'ACTIVE',1,$3,$3)`,
    [scenario.customerId, `${scenario.id} customer`, now]
  );
  await pool.query(
    `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,$5,$5)`,
    [
      stableUuid(`${scenario.id}:customer-discord-account`),
      scenario.customerId,
      scenario.guildId,
      scenario.customerDiscordId,
      now
    ]
  );
}

async function seedOrders(scenario: Scenario, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const createdAt = new Date(now.getTime() - index * 1_000);
    await pool.query(
      `INSERT INTO orders(id,public_id,customer_id,status,row_version,amount_minor,currency,guild_id,completed_at,created_at,updated_at)
      VALUES($1,$2,$3,'COMPLETED',1,$4,'CAT',$5,$6,$6,$6)`,
      [
        stableUuid(`${scenario.id}:order:${index}`),
        `P-A1-${scenario.id.slice(-3)}-${index}`,
        scenario.customerId,
        100 + index,
        scenario.guildId,
        createdAt
      ]
    );
  }
}

async function seedOrderAndGiftReservations(
  scenario: Scenario,
  orderAmount: number,
  giftAmount: number
): Promise<void> {
  const receiverId = stableUuid(`${scenario.id}:receiver`);
  const orderId = stableUuid(`${scenario.id}:reservation-order`);
  const itemId = stableUuid(`${scenario.id}:gift-item`);
  const catalogVersionId = stableUuid(`${scenario.id}:gift-version`);
  const giftId = stableUuid(`${scenario.id}:gift-request`);
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
    VALUES($1,'reservation receiver','ACTIVE',1,$2,$2)`,
    [receiverId, now]
  );
  await pool.query(
    `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,currency,guild_id,created_at,updated_at)
    VALUES($1,$2,$3,$3,'DRAFT',1,$4,'CAT',$5,$6,$6)`,
    [orderId, `P-${scenario.id.slice(-7)}`, scenario.customerId, orderAmount + giftAmount, scenario.guildId, now]
  );
  await pool.query(`INSERT INTO gift_catalog_items(id,code,created_at,updated_at) VALUES($1,$2,$3,$3)`, [
    itemId,
    `A1_${scenario.id.slice(-7)}`,
    now
  ]);
  await pool.query(
    `INSERT INTO gift_catalog_versions(id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,
    broadcast_template,created_by_staff_id,activated_at,created_at)
    VALUES($1,$2,1,'ACTIVE',$2,'A1 gift',$3,'CAT','{sender_name} -> {receiver_name}: {gift_name}',$4,$5,$5)`,
    [catalogVersionId, itemId, giftAmount, scenario.staffId, now]
  );
  await pool.query(
    `INSERT INTO gift_requests(id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,
    gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,expires_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'PENDING_REVIEW',1,'A1_GIFT','A1 gift',$7,'CAT','{gift_name}',$8,$9,$9)`,
    [
      giftId,
      `G-${scenario.id.slice(-7)}`,
      orderId,
      catalogVersionId,
      scenario.customerId,
      receiverId,
      giftAmount,
      new Date(now.getTime() + 60_000),
      now
    ]
  );
  await pool.query(
    `INSERT INTO fund_reservations(id,user_id,source_type,order_id,gift_request_id,mode,amount_minor,currency,status,row_version,
    idempotency_key,expires_at,activated_at,created_at,updated_at) VALUES
    ($1,$2,'ORDER',$3,NULL,'LOCAL_RESERVATION',$4,'CAT','ACTIVE',1,$5,$6,$7,$7,$7),
    ($8,$2,'GIFT',NULL,$9,'LOCAL_RESERVATION',$10,'CAT','ACTIVE',1,$11,$6,$7,$7,$7)`,
    [
      stableUuid(`${scenario.id}:order-reservation`),
      scenario.customerId,
      orderId,
      orderAmount,
      `${scenario.id}:reserve:order`,
      new Date(now.getTime() + 60_000),
      now,
      stableUuid(`${scenario.id}:gift-reservation`),
      giftId,
      giftAmount,
      `${scenario.id}:reserve:gift`
    ]
  );
}

function onboardingServer(): FastifyInstance {
  return buildApiServer({
    env,
    security: {
      auditSink: new PostgresAuditSink({ client: pool }),
      idempotencyStore: new PostgresIdempotencyStore({ client: pool, now: () => now })
    },
    onboarding: { store: new PostgresOnboardingStore(pool), now: () => now }
  });
}

function accountServer(scenario: Scenario, wallet: PostgresWalletStore): FastifyInstance {
  const accountStore = new PostgresAccountStore({ pool });
  return buildApiServer({
    env,
    security: { auditSink: new PostgresAuditSink({ client: pool }) },
    account: {
      store: accountStore,
      profileStore: new PostgresCustomerProfileStore(pool),
      walletFunding: wallet,
      now: () => now
    }
  });
}

function walletServer(scenario: Scenario, level: StaffLevel, stepUp: boolean): FastifyInstance {
  const staff: StaffAccount = {
    staffId: scenario.staffId,
    userId: scenario.staffUserId,
    level,
    permissionsVersion: 1,
    status: 'ACTIVE'
  };
  return buildApiServer({
    env,
    security: {
      dashboardSessions: { resolve: () => ({ ok: true as const, staff, csrfToken: 'csrf' }), verifyCsrf: () => true },
      dashboardGuildId: scenario.guildId,
      stepUpVerifier: { verify: () => stepUp },
      auditSink: new PostgresAuditSink({ client: pool }),
      idempotencyStore: new PostgresIdempotencyStore({ client: pool, now: () => now })
    },
    wallet: {
      service: new PostgresWalletStore({ pool }),
      customerScope: {
        canReadCustomer: (input) => input.userId === scenario.customerId && input.guildId === scenario.guildId
      },
      now: () => now
    }
  });
}

function botHeaders(discordUserId: string, guildId: string, key: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': stableSnowflake(`${key}:interaction`),
    'idempotency-key': key
  };
}

function dashboardHeaders(key: string) {
  return {
    cookie: 'p0_session=session; p0_csrf=csrf',
    'x-csrf-token': 'csrf',
    'x-client-source': 'DASHBOARD',
    'idempotency-key': key
  };
}

function topUpInput(
  scenario: Scenario,
  amountMinor: number,
  key: string,
  override: Partial<{
    paymentChannel: string;
    externalTransactionId: string;
  }> = {}
) {
  return {
    userId: scenario.customerId,
    amountMinor,
    paymentChannel: override.paymentChannel ?? 'BANK_TRANSFER',
    externalTransactionId: override.externalTransactionId ?? `${scenario.id}:${key}`,
    paidAt: now.toISOString(),
    note: 'receipt checked',
    reasonCode: 'MANUAL_TOP_UP',
    idempotencyKey: `${scenario.id}:${key}`,
    actorStaffId: scenario.staffId,
    actorLevel: 'L2_SUPERVISOR' as const,
    now
  };
}

function refundInput(scenario: Scenario, amountMinor: number, expectedWalletVersion: number, key: string) {
  return {
    userId: scenario.customerId,
    amountMinor,
    paymentChannel: 'BANK_TRANSFER',
    externalTransactionId: `${scenario.id}:${key}`,
    refundedAt: now.toISOString(),
    note: 'offline refund completed',
    expectedWalletVersion,
    idempotencyKey: `${scenario.id}:${key}`,
    actorStaffId: scenario.staffId,
    actorLevel: 'L2_SUPERVISOR' as const,
    now
  };
}

async function commitTopUp(wallet: PostgresWalletStore, scenario: Scenario, amountMinor: number, key: string) {
  const staged = await wallet.stageCreateTopUp(topUpInput(scenario, amountMinor, key));
  await staged.commit(walletAudit(scenario, key, 'CREATE_ADMIN_TOP_UP'));
  return staged.data;
}

function walletAudit(scenario: Scenario, key: string, action: string): AuditRecord {
  return {
    id: stableUuid(`${scenario.id}:audit:${key}`),
    actorId: scenario.staffUserId,
    actorStaffId: scenario.staffId,
    actorLevel: 'L2_SUPERVISOR',
    actorSource: 'DASHBOARD',
    clientId: 'DASHBOARD',
    interactionId: null,
    permissionCode: action.includes('TOP_UP') ? 'wallet.top_up' : 'wallet.external_refund',
    action,
    targetType: 'wallet_account',
    targetId: scenario.customerId,
    outcome: 'SUCCEEDED',
    reason: 'non-ui automation',
    requestId: `req-${key}`,
    approvalRequestId: null,
    occurredAt: now.toISOString(),
    changes: [
      {
        targetType: 'wallet_entry',
        targetId: scenario.customerId,
        changeType: 'APPEND',
        beforeSnapshot: null,
        afterSnapshot: { scenarioId: scenario.id },
        changedFields: ['scenarioId']
      }
    ]
  };
}
