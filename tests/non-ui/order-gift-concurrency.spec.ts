import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { InMemoryAccountStore } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import {
  PostgresGiftStore,
  type GiftRequestRecord,
  type GiftReservationRecord,
  type GiftStaffTaskRecord
} from '@blackcat/api/gifts';
import { PostgresOrderStore, prepareSubmitOrder } from '@blackcat/api/orders';
import { InMemoryAuditSink, type ActorContext, type AuditRecord } from '@blackcat/api/security';
import { PostgresWalletStore } from '@blackcat/api/wallet';
import { seedGiftAutomationScenario, type GiftAutomationSeed } from '../support/gift-automation-fixture';
import { startIsolatedPostgres, type IsolatedPostgres } from '../support/isolated-postgres';
import { stableUuid } from '../support/non-ui-fixtures/actors';
import { TestWalletFunding } from '../support/wallet-fixture';

const now = new Date('2026-08-14T18:00:00.000Z');
const amountMinor = 5_200;
let database: IsolatedPostgres;
let pool: Pool;

describe('NUI-A3 order and gift shared-funds concurrency', () => {
  beforeAll(async () => {
    database = await startIsolatedPostgres('gift_a3_order_gift');
    pool = database.pool;
  }, 40_000);

  afterAll(async () => database.stop());

  test('BNUI-ORD-004 serializes order and gift reservations against one exact CAT balance', async () => {
    const seed = await seedGiftAutomationScenario(pool, {
      sequence: 73,
      now,
      balanceMinor: amountMinor,
      priceMinor: amountMinor
    });
    const catalog = await seedOrderDraft(seed);
    const orderStore = new PostgresOrderStore({ pool });
    const preparedOrder = await prepareSubmitOrder({
      accountStore: new InMemoryAccountStore({ bindings: [seed.customerBinding] }),
      catalogStore: new InMemoryServiceCatalogStore({ records: [catalog] }),
      orderStore,
      walletFunding: new TestWalletFunding(amountMinor),
      actor: customerActor(seed),
      orderId: orderId(seed),
      input: { expectedVersion: 1 },
      idempotencyKey: 'nui:a3:order-gift:order',
      now
    });
    await installOrderReservationBarrier();
    const blocker = await pool.connect();
    await blocker.query('SELECT pg_advisory_lock(73004)');

    try {
      const order = orderStore.commitSubmit({
        order: preparedOrder.order,
        expectedVersion: 1,
        ledgerBalanceMinor: preparedOrder.ledgerBalanceMinor,
        orderEvent: preparedOrder.orderEvent,
        reservation: preparedOrder.reservation,
        reservationEvent: preparedOrder.reservationEvent,
        externalTransactions: preparedOrder.externalTransactions,
        auditRecord: audit(seed, 'SUBMIT_ORDER', orderId(seed)),
        auditSink: new InMemoryAuditSink()
      });
      await waitForBlockedQueries(1);
      const giftItem = buildGiftItem(seed);
      const gift = new PostgresGiftStore(pool).commitCreateBatch({
        items: [giftItem],
        ledgerBalanceMinor: amountMinor,
        standalonePlayerProfileId: seed.playerProfileId,
        expectedGuildId: seed.guildId,
        now,
        auditRecord: audit(seed, 'CREATE_GIFT_REQUEST', giftItem.request.id),
        auditSink: new InMemoryAuditSink()
      });
      await waitForBlockedQueries(2);
      await blocker.query('SELECT pg_advisory_unlock(73004)');
      const outcomes = await Promise.allSettled([gift, order]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

      const facts = await pool.query(
        `SELECT
          (SELECT count(*)::int FROM fund_reservations WHERE user_id=$1 AND status='ACTIVE') active_reservations,
          (SELECT COALESCE(sum(amount_minor),0)::int FROM fund_reservations WHERE user_id=$1 AND status='ACTIVE') reserved_minor,
          (SELECT count(*)::int FROM gift_requests WHERE sender_id=$1) gifts,
          (SELECT status::text FROM orders WHERE id=$2) order_status`,
        [seed.customerId, orderId(seed)]
      );
      expect(facts.rows[0]).toMatchObject({ active_reservations: 1, reserved_minor: amountMinor });
      expect([facts.rows[0].gifts, facts.rows[0].order_status]).toEqual(
        facts.rows[0].gifts === 1 ? [1, 'DRAFT'] : [0, 'PENDING_DISPATCH']
      );
      await expect(
        new PostgresWalletStore({ pool }).getBalance({ userId: seed.customerId, now })
      ).resolves.toMatchObject({
        ledgerBalanceMinor: amountMinor,
        reservedMinor: amountMinor,
        availableMinor: 0,
        currency: 'CAT'
      });
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(73004)').catch(() => undefined);
      blocker.release();
    }
  }, 30_000);
});

async function seedOrderDraft(seed: GiftAutomationSeed): Promise<ServiceCatalogRecord> {
  const offeringId = stableUuid('BNUI-ORD-004:offering');
  const catalogId = stableUuid('BNUI-ORD-004:catalog');
  await pool.query(
    `INSERT INTO service_offerings
      (id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at)
     VALUES($1,'NUI-A3-DELTA-TECH','DELTA','三角洲行动','TECH','技术护航','NA',$2,$2)`,
    [offeringId, now]
  );
  await pool.query(
    `INSERT INTO service_catalog_versions
      (id,service_offering_id,version,status,active_offering_key,billing_unit_minutes,minimum_units,
       customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,
       activated_at,created_at)
     VALUES($1,$2,1,'ACTIVE',$2,60,1,$3,3120,6000,'CAT',$4,$5,$5)`,
    [catalogId, offeringId, amountMinor, seed.staffId, now]
  );
  await pool.query(
    `INSERT INTO orders
      (id,public_id,customer_id,active_customer_slot_id,status,row_version,service_catalog_version_id,catalog_version,
       game_code_snapshot,service_code_snapshot,region_code_snapshot,billing_unit_minutes,unit_count,
       customer_unit_price_minor,player_unit_payout_minor,amount_minor,expected_player_earning_minor,currency,guild_id,
       channel_id,panel_message_id,created_at,updated_at)
     VALUES($1,'P-NUI-A3-RACE',$2,$2,'DRAFT',1,$3,1,'三角洲行动','技术护航','NA',60,1,$4,3120,$4,3120,
       'CAT',$5,'900000000000007301','900000000000007302',$6,$6)`,
    [orderId(seed), seed.customerId, catalogId, amountMinor, seed.guildId, now]
  );
  return {
    id: catalogId,
    offeringKey: 'NUI-A3-DELTA-TECH',
    serviceOfferingId: offeringId,
    game: '三角洲行动',
    service: '技术护航',
    region: 'NA',
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: amountMinor,
    playerUnitPayoutMinor: 3120,
    defaultPlayerPayoutBps: 6000,
    currency: 'CAT',
    status: 'ACTIVE',
    version: 1,
    createdByStaffId: seed.staffId,
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    retiredAt: null
  };
}

async function installOrderReservationBarrier(): Promise<void> {
  await pool.query(`CREATE FUNCTION nui_a3_block_order_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_type = 'ORDER' THEN PERFORM pg_advisory_xact_lock(73004); END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER nui_a3_block_order_reservation
    BEFORE INSERT ON fund_reservations FOR EACH ROW EXECUTE FUNCTION nui_a3_block_order_reservation()`);
}

async function waitForBlockedQueries(minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock'`,
      []
    );
    if ((waiting.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const activity = await pool.query<{ query: string; wait_event_type: string | null; wait_event: string | null }>(
    `SELECT query,wait_event_type,wait_event FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND datname=current_database()`
  );
  throw new Error(
    `Expected ${minimum} blocked transactions: ${JSON.stringify(activity.rows)} ` +
      `pool=${pool.totalCount}/${pool.idleCount}/${pool.waitingCount}`
  );
}

function orderId(seed: GiftAutomationSeed): string {
  return stableUuid(`BNUI-ORD-004:${seed.customerId}:order`);
}

function customerActor(seed: GiftAutomationSeed): ActorContext {
  return {
    actorUserId: seed.customerId,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    guildId: seed.guildId,
    discordUserId: seed.customerDiscordId,
    interactionId: '900000000000007398',
    permissionsVersion: null
  };
}

function buildGiftItem(seed: GiftAutomationSeed): {
  request: GiftRequestRecord;
  reservation: GiftReservationRecord;
  staffTask: GiftStaffTaskRecord;
} {
  const requestId = stableUuid('BNUI-ORD-004:gift-request');
  const reservationId = stableUuid('BNUI-ORD-004:gift-reservation');
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  const request: GiftRequestRecord = {
    id: requestId,
    publicId: 'G-NUI-A3-RACE',
    guildId: seed.guildId,
    origin: 'STANDALONE',
    senderVisibility: 'PUBLIC',
    initiatorMode: 'CUSTOMER_SELF',
    orderId: null,
    participantId: null,
    giftCatalogVersionId: seed.catalogVersionId,
    senderId: seed.customerId,
    receiverId: seed.playerId,
    status: 'PENDING_REVIEW',
    version: 1,
    giftCodeSnapshot: 'GIFT_73',
    giftNameSnapshot: '测试礼物 73',
    priceMinor: amountMinor,
    currency: 'CAT',
    broadcastTemplateSnapshot: '{sender_name} 向 {receiver_name} 送出 {gift_name}',
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  const reservation: GiftReservationRecord = {
    id: reservationId,
    userId: seed.customerId,
    sourceType: 'GIFT',
    orderId: null,
    giftRequestId: requestId,
    mode: 'LOCAL_RESERVATION',
    provider: null,
    providerHoldRef: null,
    amountMinor,
    currency: 'CAT',
    status: 'ACTIVE',
    version: 2,
    idempotencyKey: 'nui:a3:order-gift:gift',
    expiresAt,
    activatedAt: now.toISOString(),
    settledAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  return {
    request,
    reservation,
    staffTask: {
      id: stableUuid('BNUI-ORD-004:gift-task'),
      publicId: 'T-NUI-A3-RACE',
      type: 'GIFT_REVIEW',
      reasonCode: 'GIFT_REQUESTED',
      status: 'OPEN',
      version: 1,
      orderId: null,
      giftRequestId: requestId,
      voiceChannelId: null,
      contextSnapshot: {
        source: 'STANDALONE',
        orderId: null,
        orderPublicId: null,
        channelId: null,
        voiceChannelId: null,
        senderId: seed.customerId,
        receiverId: seed.playerId,
        giftCode: 'GIFT_73',
        giftName: '测试礼物 73',
        priceMinor: amountMinor,
        currency: 'CAT',
        reservationId
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    }
  };
}

function audit(seed: GiftAutomationSeed, action: string, targetId: string): AuditRecord {
  return {
    id: stableUuid(`BNUI-ORD-004:audit:${action}`),
    actorId: seed.customerId,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    interactionId: '900000000000007398',
    permissionCode: action === 'SUBMIT_ORDER' ? 'order.submit' : 'gift.request',
    action,
    targetType: action === 'SUBMIT_ORDER' ? 'order' : 'gift_request',
    targetId,
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: `req-${action.toLowerCase()}`,
    approvalRequestId: null,
    occurredAt: now.toISOString(),
    changes: []
  };
}
