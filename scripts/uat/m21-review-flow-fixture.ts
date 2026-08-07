import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type M21ReviewUatFixtureInput = {
  runId: string;
  guildId: string;
  customerDiscordId: string;
  interactionChannelId: string;
  reviewChannelId: string;
  completedAt: Date;
};

export type M21ReviewUatFixture = {
  runId: string;
  orderId: string;
  orderPublicId: string;
  customerId: string;
  playerTargetKeys: [string, string, string];
  supportTargetKey: string;
  interactionChannelId: string;
  reviewChannelId: string;
};

type CheckpointInput = {
  runId: string;
  guildId: string;
  customerDiscordId: string;
  reviewChannelId: string;
};

type FinalCheckpointInput = CheckpointInput & {
  visibleReviewMessageIds: string[];
  renderedReviewCards: string[];
};

export async function prepareM21ReviewUatFixture(
  pool: Pool,
  input: M21ReviewUatFixtureInput
): Promise<M21ReviewUatFixture> {
  validateFixtureInput(input);
  await assertIsolatedUatDatabase(pool);
  const ids = fixtureIds(input.runId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const user of [
      [ids.customerId, 'M21 UAT 老板'],
      [ids.playerIds[0], '陪玩 A'],
      [ids.playerIds[1], '陪玩 B'],
      [ids.playerIds[2], '陪玩 C'],
      [ids.staffUserId, 'M21 UAT 客服']
    ] as const) {
      await client.query(
        `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
         VALUES($1,$2,'ACTIVE',1,$3,$3) ON CONFLICT(id) DO NOTHING`,
        [user[0], user[1], input.completedAt]
      );
    }
    await client.query(
      `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$5,$5),($6,$7,$3,$8,$5,$5,$5)
       ON CONFLICT(user_id,guild_id) DO NOTHING`,
      [
        ids.customerDiscordAccountId,
        ids.customerId,
        input.guildId,
        input.customerDiscordId,
        input.completedAt,
        ids.staffDiscordAccountId,
        ids.staffUserId,
        ids.staffDiscordId
      ]
    );
    await client.query(
      `INSERT INTO staff_accounts
       (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
       VALUES($1,$2,'L1_SUPPORT','ACTIVE','MANUAL',1,$3,$3) ON CONFLICT(id) DO NOTHING`,
      [ids.staffId, ids.staffUserId, input.completedAt]
    );
    await client.query(
      `INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,created_at,updated_at)
       VALUES($1,$2,'M21-UAT','M21 UAT 游戏','REVIEW','评价验收服务',$3,$3) ON CONFLICT(id) DO NOTHING`,
      [ids.offeringId, `M21-UAT-${input.runId}`, input.completedAt]
    );
    await client.query(
      `INSERT INTO service_catalog_versions
       (id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,
        player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at)
       VALUES($1,$2,1,'ACTIVE',60,1,100,50,5000,'CAT',$3,$4) ON CONFLICT(id) DO NOTHING`,
      [ids.catalogId, ids.offeringId, ids.staffId, input.completedAt]
    );
    await client.query(
      `INSERT INTO orders
       (id,public_id,customer_id,status,row_version,guild_id,channel_id,service_name_snapshot,
        amount_minor,expected_player_earning_minor,currency,completed_at,created_at,updated_at)
       VALUES($1,$2,$3,'COMPLETED',10,$4,$5,'M21 UAT 三陪玩服务',300,150,'CAT',$6,$6,$6)
       ON CONFLICT(id) DO NOTHING`,
      [ids.orderId, ids.orderPublicId, ids.customerId, input.guildId, input.interactionChannelId, input.completedAt]
    );
    for (let index = 0; index < ids.participantIds.length; index += 1) {
      await insertParticipant(client, {
        id: ids.participantIds[index]!,
        orderId: ids.orderId,
        playerId: ids.playerIds[index]!,
        catalogId: ids.catalogId,
        displayName: `陪玩 ${String.fromCharCode(65 + index)}`,
        createdAt: new Date(input.completedAt.getTime() + index * 1_000)
      });
    }
    await seedProtectedBusinessFacts(client, input, ids);
    await client.query(
      `INSERT INTO order_channel_message_events
       (id,order_id,order_public_id,guild_id,channel_id,discord_message_id,event_id,event_type,
        author_discord_id,author_display_name,author_is_bot,content_snapshot,observed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'CREATED',$8,'M21 UAT 客服',false,'M21 UAT 首次响应',$9)
       ON CONFLICT(id) DO NOTHING`,
      [
        ids.responseEventId,
        ids.orderId,
        ids.orderPublicId,
        input.guildId,
        input.interactionChannelId,
        ids.responseMessageId,
        `CREATED:${ids.responseMessageId}`,
        ids.staffDiscordId,
        input.completedAt
      ]
    );
    await client.query(
      `INSERT INTO staff_tasks
       (id,public_id,type,reason_code,status,row_version,order_id,context_snapshot,response_status,response_due_at,
        first_responded_at,first_response_event_id,created_at,updated_at)
       VALUES($1,$2,'ORDER_ASSIST','CUSTOMER_HELP','RESOLVED',2,$3,'{}','MET',$4,$4,$5,$4,$4)
       ON CONFLICT(id) DO NOTHING`,
      [ids.staffTaskId, `T-M21-UAT-${input.runId.toUpperCase()}`, ids.orderId, input.completedAt, ids.responseEventId]
    );
    await client.query(
      `INSERT INTO guild_bot_configs(guild_id,version,config_json,updated_by_staff_id,updated_at)
       VALUES($1,1,jsonb_build_object('review_broadcast_channel_id',$2::text),$3,$4)
       ON CONFLICT(guild_id) DO UPDATE SET
         config_json=jsonb_set(guild_bot_configs.config_json,'{review_broadcast_channel_id}',to_jsonb($2::text),true),
         updated_by_staff_id=$3,updated_at=$4`,
      [input.guildId, input.reviewChannelId, ids.staffId, input.completedAt]
    );
    await assertPreparedRows(client, input, ids);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return publicFixture(input, ids);
}

export async function verifyM21ReviewInternalCheckpoint(pool: Pool, input: CheckpointInput) {
  validateCheckpointInput(input);
  await assertIsolatedUatDatabase(pool);
  const facts = await loadFacts(pool, input);
  assertExpectedRatings(facts);
  if (facts.publication) throw new Error('Internal-save checkpoint already has a public review snapshot.');
  if (facts.reviewBroadcastCount !== 0) throw new Error('Internal-save checkpoint already has a review broadcast job.');
  assertBusinessFactsUnchanged(facts);
  return {
    acceptanceId: 'AT-REVIEW-002',
    runId: input.runId,
    orderId: facts.orderId,
    orderScore: facts.scores.order,
    playerScores: facts.scores.players,
    supportScore: facts.scores.support,
    commentCount: facts.commentCount,
    publicationCount: 0,
    reviewBroadcastCount: 0,
    businessFactsUnchanged: true,
    protectedFacts: facts.protectedFacts,
    status: 'PASS'
  };
}

export async function bindM21ReviewUatEntryMessage(
  pool: Pool,
  input: { runId: string; guildId: string; interactionChannelId: string; entryMessageId: string }
) {
  if (!/^[a-z0-9]{4,12}$/u.test(input.runId)) throw new Error('runId must contain 4-12 lowercase letters or digits.');
  assertSnowflake(input.guildId, 'guildId');
  assertSnowflake(input.interactionChannelId, 'interactionChannelId');
  assertSnowflake(input.entryMessageId, 'entryMessageId');
  await assertIsolatedUatDatabase(pool);
  const ids = fixtureIds(input.runId);
  const result = await pool.query(
    `UPDATE orders SET panel_message_id=$2,updated_at=now()
      WHERE id=$1 AND guild_id=$3 AND channel_id=$4 RETURNING id`,
    [ids.orderId, input.entryMessageId, input.guildId, input.interactionChannelId]
  );
  if (!result.rows[0]) throw new Error('M21 review UAT order could not bind its Discord entry message.');
}

export async function requeueM21ReviewUatBroadcast(
  pool: Pool,
  input: { runId: string; guildId: string; customerDiscordId: string }
) {
  const state = await getM21ReviewUatBroadcastState(pool, input);
  const result = await pool.query<{ status: string }>(
    `UPDATE outbox_events SET
       status='PENDING',attempt_count=0,available_at=now(),locked_at=NULL,locked_by=NULL,
       completed_at=NULL,last_error=NULL,row_version=row_version+1,updated_at=now()
      WHERE id=$1 RETURNING status::text`,
    [state.outboxId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('M21 review UAT broadcast could not be requeued.');
  return {
    ...state,
    outboxStatus: row.status
  };
}

export async function getM21ReviewUatBroadcastState(
  pool: Pool,
  input: { runId: string; guildId: string; customerDiscordId: string }
) {
  if (!/^[a-z0-9]{4,12}$/u.test(input.runId)) throw new Error('runId must contain 4-12 lowercase letters or digits.');
  assertSnowflake(input.guildId, 'guildId');
  assertSnowflake(input.customerDiscordId, 'customerDiscordId');
  await assertIsolatedUatDatabase(pool);
  const ids = fixtureIds(input.runId);
  const result = await pool.query<{ outbox_id: string; broadcast_message_id: string | null }>(
    `SELECT event.id outbox_id,published.broadcast_message_id
       FROM order_review_publications published
       JOIN orders o ON o.id=published.order_id
       JOIN discord_accounts account ON account.user_id=o.customer_id AND account.guild_id=o.guild_id
       JOIN outbox_events event ON event.aggregate_id=published.id
        AND event.event_type='REVIEW_BROADCAST' AND event.order_id=published.order_id
      WHERE published.order_id=$1 AND o.guild_id=$2 AND account.discord_user_id=$3`,
    [ids.orderId, input.guildId, input.customerDiscordId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('M21 review UAT broadcast cannot be inspected before publication.');
  return {
    runId: input.runId,
    orderId: ids.orderId,
    outboxId: row.outbox_id,
    previousMessageId: row.broadcast_message_id
  };
}

export async function verifyM21ReviewFinalCheckpoint(pool: Pool, input: FinalCheckpointInput) {
  validateCheckpointInput(input);
  if (!Array.isArray(input.visibleReviewMessageIds) || !Array.isArray(input.renderedReviewCards))
    throw new Error('Discord review evidence is invalid.');
  await assertIsolatedUatDatabase(pool);
  const facts = await loadFacts(pool, input);
  assertExpectedRatings(facts);
  assertBusinessFactsUnchanged(facts);
  if (!facts.publication || facts.publication.status !== 'PUBLISHED')
    throw new Error('Final checkpoint does not have a published review snapshot.');
  if (facts.publication.broadcast_channel_id !== input.reviewChannelId)
    throw new Error('Published review used an unexpected Discord channel.');
  if (!facts.publication.broadcast_message_id) throw new Error('Published review has no Discord message ID.');
  const snapshot = validatePublicSnapshot(facts.publication.snapshot, facts.orderPublicId);
  if (facts.reviewBroadcastCount !== 1 || facts.completedReviewBroadcastCount !== 1)
    throw new Error('Final checkpoint review broadcast did not converge to one completed Outbox job.');
  if (
    input.visibleReviewMessageIds.length !== 1 ||
    input.visibleReviewMessageIds[0] !== facts.publication.broadcast_message_id ||
    input.renderedReviewCards.length !== 1
  )
    throw new Error('Discord review channel did not converge to one persisted review card.');
  const rendered = input.renderedReviewCards[0]!;
  for (const required of ['老板五星好评', facts.orderPublicId, '订单整体']) {
    if (!rendered.includes(required)) throw new Error(`Discord review card omitted ${required}.`);
  }
  for (const forbidden of [
    '陪玩 A',
    '陪玩 B',
    '陪玩 C',
    '猫舍前台',
    'private-m21-comment-sentinel',
    input.customerDiscordId,
    '钱包',
    'CAT'
  ]) {
    if (rendered.includes(forbidden)) throw new Error(`Discord review card leaked ${forbidden}.`);
  }
  return {
    acceptanceId: 'AT-REVIEW-003',
    runId: input.runId,
    orderId: facts.orderId,
    publicationStatus: facts.publication.status,
    broadcastMessageId: facts.publication.broadcast_message_id,
    publicTargetCount: snapshot.targets.length,
    visibleReviewMessageCount: input.visibleReviewMessageIds.length,
    privateFieldsAbsent: true,
    businessFactsUnchanged: true,
    protectedFacts: facts.protectedFacts,
    status: 'PASS'
  };
}

export async function assertIsolatedUatDatabase(pool: Pool): Promise<string> {
  const result = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name');
  const databaseName = result.rows[0]?.database_name ?? '';
  if (!databaseName.includes('_uat'))
    throw new Error('M21 review UAT requires an isolated database name containing _uat.');
  return databaseName;
}

function fixtureIds(runId: string) {
  const participantIds = [
    uuid(runId, 'participant-a'),
    uuid(runId, 'participant-b'),
    uuid(runId, 'participant-c')
  ] as const;
  return {
    customerId: uuid(runId, 'customer'),
    customerDiscordAccountId: uuid(runId, 'customer-discord'),
    playerIds: [uuid(runId, 'player-a'), uuid(runId, 'player-b'), uuid(runId, 'player-c')] as const,
    participantIds,
    staffUserId: uuid(runId, 'staff-user'),
    staffId: uuid(runId, 'staff'),
    staffDiscordAccountId: uuid(runId, 'staff-discord-account'),
    staffDiscordId: syntheticSnowflake(runId, 'staff-discord'),
    offeringId: uuid(runId, 'offering'),
    catalogId: uuid(runId, 'catalog'),
    orderId: uuid(runId, 'order'),
    orderPublicId: `P-M21-UAT-${runId.toUpperCase()}`,
    responseEventId: uuid(runId, 'response-event'),
    responseMessageId: syntheticSnowflake(runId, 'response-message'),
    staffTaskId: uuid(runId, 'staff-task'),
    walletAccountId: uuid(runId, 'wallet-account'),
    topUpWalletEntryId: uuid(runId, 'wallet-topup'),
    captureWalletEntryId: uuid(runId, 'wallet-capture'),
    reservationId: uuid(runId, 'reservation'),
    reservationCreatedEventId: uuid(runId, 'reservation-created'),
    reservationCapturedEventId: uuid(runId, 'reservation-captured'),
    consumptionId: uuid(runId, 'consumption'),
    earningIds: [uuid(runId, 'earning-a'), uuid(runId, 'earning-b'), uuid(runId, 'earning-c')] as const,
    referralProgramId: uuid(runId, 'referral-program'),
    attributionId: uuid(runId, 'attribution'),
    commissionId: uuid(runId, 'commission'),
    dispatchId: uuid(runId, 'dispatch'),
    riskEventId: uuid(runId, 'risk')
  };
}

function publicFixture(input: M21ReviewUatFixtureInput, ids: ReturnType<typeof fixtureIds>): M21ReviewUatFixture {
  return {
    runId: input.runId,
    orderId: ids.orderId,
    orderPublicId: ids.orderPublicId,
    customerId: ids.customerId,
    playerTargetKeys: ids.participantIds.map((id) => `player:${id}`) as [string, string, string],
    supportTargetKey: `support:${ids.staffId}`,
    interactionChannelId: input.interactionChannelId,
    reviewChannelId: input.reviewChannelId
  };
}

async function insertParticipant(
  client: PoolClient,
  input: { id: string; orderId: string; playerId: string; catalogId: string; displayName: string; createdAt: Date }
) {
  await client.query(
    `INSERT INTO order_participants
     (id,order_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,
      game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,
      billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,
      compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,created_at,updated_at)
     VALUES($1,$2,$3,$4,'ACTIVE',1,$5,'M21-UAT','M21 UAT 游戏','REVIEW','评价验收服务',60,1,100,100,
            'PERCENT_BPS',5000,'CATALOG_DEFAULT',50,$6,$6) ON CONFLICT(id) DO NOTHING`,
    [input.id, input.orderId, input.playerId, input.catalogId, input.displayName, input.createdAt]
  );
}

async function seedProtectedBusinessFacts(
  client: PoolClient,
  input: M21ReviewUatFixtureInput,
  ids: ReturnType<typeof fixtureIds>
) {
  await client.query(
    `INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,created_at,updated_at)
     VALUES($1,$2,'CAT','ACTIVE',1,$3,$3) ON CONFLICT(id) DO NOTHING`,
    [ids.walletAccountId, ids.customerId, input.completedAt]
  );
  await client.query(
    `INSERT INTO wallet_entries
     (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at)
     VALUES
       ($1,$2,'TOP_UP_CREDIT','CREDIT',1000,'CAT','M21_UAT_TOPUP',$3,$4,$5),
       ($6,$2,'ORDER_CAPTURE_DEBIT','DEBIT',300,'CAT','ORDER',$7,$8,$5)
     ON CONFLICT(id) DO NOTHING`,
    [
      ids.topUpWalletEntryId,
      ids.walletAccountId,
      uuid(input.runId, 'topup-source'),
      `m21-uat:${input.runId}:wallet-topup`,
      input.completedAt,
      ids.captureWalletEntryId,
      ids.orderId,
      `m21-uat:${input.runId}:wallet-capture`
    ]
  );
  await client.query(
    `INSERT INTO fund_reservations
     (id,user_id,source_type,order_id,mode,amount_minor,currency,status,row_version,idempotency_key,
      expires_at,created_at,updated_at)
     VALUES($1,$2,'ORDER',$3,'LOCAL_RESERVATION',300,'CAT','PENDING',1,$4,$5,$6,$6)
     ON CONFLICT(id) DO NOTHING`,
    [
      ids.reservationId,
      ids.customerId,
      ids.orderId,
      `m21-uat:${input.runId}:reservation`,
      new Date(input.completedAt.getTime() + 30 * 60_000),
      input.completedAt
    ]
  );
  await client.query(
    `INSERT INTO fund_reservation_events
     (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
      idempotency_key,actor_user_id,actor_source,created_at)
     SELECT $1,$2,1,'CREATED',NULL,'ACTIVE',300,1,$3,$4,'SYSTEM_JOB',$5
     WHERE NOT EXISTS(SELECT 1 FROM fund_reservation_events WHERE id=$1)`,
    [
      ids.reservationCreatedEventId,
      ids.reservationId,
      `m21-uat:${input.runId}:reservation-created`,
      ids.customerId,
      input.completedAt
    ]
  );
  await client.query(
    `INSERT INTO fund_reservation_events
     (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
      idempotency_key,actor_user_id,actor_source,created_at)
     SELECT $1,$2,2,'CAPTURED','ACTIVE','CAPTURED',300,2,$3,$4,'SYSTEM_JOB',$5
     WHERE NOT EXISTS(SELECT 1 FROM fund_reservation_events WHERE id=$1)`,
    [
      ids.reservationCapturedEventId,
      ids.reservationId,
      `m21-uat:${input.runId}:reservation-captured`,
      ids.customerId,
      input.completedAt
    ]
  );
  await client.query(
    `INSERT INTO consumption_entries
     (id,user_id,entry_type,direction,order_id,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at)
     VALUES($1,$2,'ORDER_CHARGE','DEBIT',$3,300,'CAT','ORDER',$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
    [ids.consumptionId, ids.customerId, ids.orderId, `m21-uat:${input.runId}:consumption`, input.completedAt]
  );
  for (let index = 0; index < ids.earningIds.length; index += 1) {
    await client.query(
      `INSERT INTO player_earnings
       (id,order_id,order_participant_id,player_user_id,base_units,unit_payout_minor,amount_minor,currency,
        status,row_version,confirmed_by_staff_id,confirmed_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,1,50,50,'CAT','CONFIRMED',1,$5,$6,$6,$6) ON CONFLICT(id) DO NOTHING`,
      [
        ids.earningIds[index],
        ids.orderId,
        ids.participantIds[index],
        ids.playerIds[index],
        ids.staffId,
        input.completedAt
      ]
    );
  }
  await client.query(
    `INSERT INTO referral_program_versions
     (id,program_type,version,status,active_program_key,award_mode,rate_bps,currency,eligible_order_spend,
      eligible_gift_spend,created_by_staff_id,activated_at,created_at)
     VALUES($1,'PLAYER_LIFETIME',1,'ACTIVE','PLAYER_LIFETIME','NET_SPEND_BPS',200,'CAT',true,false,$2,$3,$3)
     ON CONFLICT(id) DO NOTHING`,
    [ids.referralProgramId, ids.staffId, input.completedAt]
  );
  await client.query(
    `INSERT INTO referral_attributions
     (id,program_version_id,beneficiary_user_id,referred_user_id,status,row_version,active_attribution_key,
      source_type,bound_by_staff_id,eligibility_checked_at,bound_at,created_at)
     VALUES($1,$2,$3,$4,'ACTIVE',1,$4,'ADMIN_MANUAL',$5,$6,$6,$6) ON CONFLICT(id) DO NOTHING`,
    [ids.attributionId, ids.referralProgramId, ids.playerIds[0], ids.customerId, ids.staffId, input.completedAt]
  );
  await client.query(
    `INSERT INTO commissions
     (id,referral_attribution_id,beneficiary_user_id,source_consumption_entry_id,program_type_snapshot,
      program_version_snapshot,award_mode_snapshot,base_amount_minor,rate_bps,amount_minor,currency,status,
      row_version,created_at,updated_at)
     VALUES($1,$2,$3,$4,'PLAYER_LIFETIME',1,'NET_SPEND_BPS',300,200,6,'CAT','CONFIRMED',1,$5,$5)
     ON CONFLICT(id) DO NOTHING`,
    [ids.commissionId, ids.attributionId, ids.playerIds[0], ids.consumptionId, input.completedAt]
  );
  await client.query(
    `INSERT INTO dispatch_attempts
     (id,order_id,round,status,dispatch_channel_id,candidate_criteria,accepted_player_id,started_at,expires_at,
      accepted_at,finished_at,created_at,updated_at)
     VALUES($1,$2,1,'ACCEPTED',$3,'{}',$4,$5,$6,$5,$5,$5,$5) ON CONFLICT(id) DO NOTHING`,
    [
      ids.dispatchId,
      ids.orderId,
      syntheticSnowflake(input.runId, 'dispatch-channel'),
      ids.playerIds[0],
      input.completedAt,
      new Date(input.completedAt.getTime() + 5 * 60_000)
    ]
  );
  await client.query(
    `INSERT INTO risk_events(id,user_id,order_id,type,severity,source,notes,created_by_staff_id,created_at)
     VALUES($1,$2,$3,'PAYMENT_ANOMALY','LOW','M21_UAT','protected pre-existing UAT risk fact',$4,$5)
     ON CONFLICT(id) DO NOTHING`,
    [ids.riskEventId, ids.customerId, ids.orderId, ids.staffId, input.completedAt]
  );
}

async function assertPreparedRows(
  client: PoolClient,
  input: M21ReviewUatFixtureInput,
  ids: ReturnType<typeof fixtureIds>
) {
  const result = await client.query<{
    guild_id: string;
    customer_discord_id: string;
    channel_id: string;
    review_channel_id: string;
    participant_count: number;
  }>(
    `SELECT o.guild_id,da.discord_user_id AS customer_discord_id,o.channel_id,
            config.config_json->>'review_broadcast_channel_id' AS review_channel_id,
            (SELECT count(*)::int FROM order_participants p WHERE p.order_id=o.id AND p.status='ACTIVE') participant_count
       FROM orders o
       JOIN discord_accounts da ON da.user_id=o.customer_id AND da.guild_id=o.guild_id
       JOIN guild_bot_configs config ON config.guild_id=o.guild_id
      WHERE o.id=$1`,
    [ids.orderId]
  );
  const row = result.rows[0];
  if (
    !row ||
    row.guild_id !== input.guildId ||
    row.customer_discord_id !== input.customerDiscordId ||
    row.channel_id !== input.interactionChannelId ||
    row.review_channel_id !== input.reviewChannelId ||
    row.participant_count !== 3
  )
    throw new Error('M21 review UAT fixture conflicts with existing isolated data.');
}

async function loadFacts(pool: Pool, input: CheckpointInput) {
  const ids = fixtureIds(input.runId);
  const orderResult = await pool.query<{
    id: string;
    public_id: string;
    status: string;
    row_version: number;
    amount_minor: string;
    expected_player_earning_minor: string;
    currency: string;
    guild_id: string;
    customer_discord_id: string;
    review_channel_id: string;
  }>(
    `SELECT o.id,o.public_id,o.status::text,o.row_version,o.amount_minor::text,
            o.expected_player_earning_minor::text,o.currency,o.guild_id,da.discord_user_id customer_discord_id,
            config.config_json->>'review_broadcast_channel_id' review_channel_id
       FROM orders o
       JOIN discord_accounts da ON da.user_id=o.customer_id AND da.guild_id=o.guild_id
       JOIN guild_bot_configs config ON config.guild_id=o.guild_id
      WHERE o.id=$1`,
    [ids.orderId]
  );
  const order = orderResult.rows[0];
  if (
    !order ||
    order.guild_id !== input.guildId ||
    order.customer_discord_id !== input.customerDiscordId ||
    order.review_channel_id !== input.reviewChannelId
  )
    throw new Error('M21 review UAT fixture identity or Guild configuration is invalid.');
  const reviews = await pool.query<{ target_key: string; score: number; comment: string | null }>(
    `SELECT review.target_key,review.score,comment.comment
       FROM order_experience_reviews review
       LEFT JOIN order_experience_review_comments comment ON comment.review_id=review.id
      WHERE review.order_id=$1 ORDER BY review.target_key`,
    [ids.orderId]
  );
  const byTarget = new Map(reviews.rows.map((review) => [review.target_key, review]));
  const publicationResult = await pool.query<{
    status: string;
    snapshot: unknown;
    broadcast_channel_id: string | null;
    broadcast_message_id: string | null;
  }>(
    `SELECT status::text,snapshot,broadcast_channel_id,broadcast_message_id
       FROM order_review_publications WHERE order_id=$1`,
    [ids.orderId]
  );
  const outbox = await pool.query<{ total: number; completed: number }>(
    `SELECT count(*)::int total,count(*) FILTER(WHERE status='COMPLETED')::int completed
       FROM outbox_events WHERE event_type='REVIEW_BROADCAST' AND order_id=$1`,
    [ids.orderId]
  );
  const protectedFactsResult = await pool.query<{
    reservation_status: string | null;
    reservation_amount_minor: string | null;
    reservation_event_count: number;
    wallet_entry_count: number;
    wallet_net_minor: string;
    consumption_count: number;
    consumption_minor: string;
    earning_count: number;
    earning_minor: string;
    confirmed_earning_count: number;
    referral_attribution_count: number;
    commission_count: number;
    commission_minor: string;
    dispatch_count: number;
    risk_event_count: number;
    staff_permissions_version: number | null;
    staff_status: string | null;
  }>(
    `SELECT
      (SELECT status::text FROM fund_reservations WHERE id=$2) reservation_status,
      (SELECT amount_minor::text FROM fund_reservations WHERE id=$2) reservation_amount_minor,
      (SELECT count(*)::int FROM fund_reservation_events WHERE fund_reservation_id=$2) reservation_event_count,
      (SELECT count(*)::int FROM wallet_entries WHERE wallet_account_id=$3) wallet_entry_count,
      COALESCE((SELECT sum(CASE direction::text WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END)::text
                  FROM wallet_entries WHERE wallet_account_id=$3),'0') wallet_net_minor,
      (SELECT count(*)::int FROM consumption_entries WHERE order_id=$1) consumption_count,
      COALESCE((SELECT sum(amount_minor)::text FROM consumption_entries WHERE order_id=$1),'0') consumption_minor,
      (SELECT count(*)::int FROM player_earnings WHERE order_id=$1) earning_count,
      COALESCE((SELECT sum(amount_minor)::text FROM player_earnings WHERE order_id=$1),'0') earning_minor,
      (SELECT count(*)::int FROM player_earnings WHERE order_id=$1 AND status='CONFIRMED') confirmed_earning_count,
      (SELECT count(*)::int FROM referral_attributions WHERE id=$4) referral_attribution_count,
      (SELECT count(*)::int FROM commissions WHERE id=$5) commission_count,
      COALESCE((SELECT amount_minor::text FROM commissions WHERE id=$5),'0') commission_minor,
      (SELECT count(*)::int FROM dispatch_attempts WHERE order_id=$1) dispatch_count,
      (SELECT count(*)::int FROM risk_events WHERE order_id=$1) risk_event_count,
      (SELECT permissions_version FROM staff_accounts WHERE id=$6) staff_permissions_version,
      (SELECT status::text FROM staff_accounts WHERE id=$6) staff_status`,
    [ids.orderId, ids.reservationId, ids.walletAccountId, ids.attributionId, ids.commissionId, ids.staffId]
  );
  const protectedRow = protectedFactsResult.rows[0];
  return {
    orderId: order.id,
    orderPublicId: order.public_id,
    orderStatus: order.status,
    orderVersion: order.row_version,
    orderAmountMinor: order.amount_minor,
    orderExpectedPlayerEarningMinor: order.expected_player_earning_minor,
    orderCurrency: order.currency,
    scores: {
      order: byTarget.get('order')?.score ?? null,
      players: ids.participantIds.map((id) => byTarget.get(`player:${id}`)?.score ?? null),
      support: byTarget.get(`support:${ids.staffId}`)?.score ?? null
    },
    commentCount: reviews.rows.filter((review) => review.comment !== null).length,
    comments: reviews.rows.flatMap((review) => (review.comment === null ? [] : [review.comment])),
    publication: publicationResult.rows[0] ?? null,
    reviewBroadcastCount: outbox.rows[0]?.total ?? 0,
    completedReviewBroadcastCount: outbox.rows[0]?.completed ?? 0,
    protectedFacts: protectedRow
      ? {
          reservationStatus: protectedRow.reservation_status,
          reservationAmountMinor: protectedRow.reservation_amount_minor,
          reservationEventCount: protectedRow.reservation_event_count,
          walletEntryCount: protectedRow.wallet_entry_count,
          walletNetMinor: protectedRow.wallet_net_minor,
          consumptionCount: protectedRow.consumption_count,
          consumptionMinor: protectedRow.consumption_minor,
          earningCount: protectedRow.earning_count,
          earningMinor: protectedRow.earning_minor,
          confirmedEarningCount: protectedRow.confirmed_earning_count,
          referralAttributionCount: protectedRow.referral_attribution_count,
          commissionCount: protectedRow.commission_count,
          commissionMinor: protectedRow.commission_minor,
          dispatchCount: protectedRow.dispatch_count,
          riskEventCount: protectedRow.risk_event_count,
          staffPermissionsVersion: protectedRow.staff_permissions_version,
          staffStatus: protectedRow.staff_status
        }
      : null
  };
}

function assertExpectedRatings(facts: Awaited<ReturnType<typeof loadFacts>>) {
  if (
    facts.scores.order !== 5 ||
    JSON.stringify(facts.scores.players) !== JSON.stringify([4, 4, null]) ||
    facts.scores.support !== 2 ||
    facts.commentCount !== 1 ||
    facts.comments[0] !== 'private-m21-comment-sentinel'
  )
    throw new Error('M21 review UAT mixed rating facts do not match the acceptance scenario.');
}

function assertBusinessFactsUnchanged(facts: Awaited<ReturnType<typeof loadFacts>>) {
  if (
    facts.orderStatus !== 'COMPLETED' ||
    facts.orderVersion !== 10 ||
    facts.orderAmountMinor !== '300' ||
    facts.orderExpectedPlayerEarningMinor !== '150' ||
    facts.orderCurrency !== 'CAT'
  )
    throw new Error('M21 review UAT changed the completed order fact.');
  const expectedProtectedFacts = {
    reservationStatus: 'CAPTURED',
    reservationAmountMinor: '300',
    reservationEventCount: 2,
    walletEntryCount: 2,
    walletNetMinor: '700',
    consumptionCount: 1,
    consumptionMinor: '300',
    earningCount: 3,
    earningMinor: '150',
    confirmedEarningCount: 3,
    referralAttributionCount: 1,
    commissionCount: 1,
    commissionMinor: '6',
    dispatchCount: 1,
    riskEventCount: 1,
    staffPermissionsVersion: 1,
    staffStatus: 'ACTIVE'
  };
  if (JSON.stringify(facts.protectedFacts) !== JSON.stringify(expectedProtectedFacts))
    throw new Error('M21 review UAT changed a protected business or financial fact.');
}

function validatePublicSnapshot(value: unknown, orderPublicId: string) {
  if (
    !record(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['completedAt', 'orderPublicId', 'serviceDisplayName', 'targets'])
  )
    throw new Error('Published M21 review snapshot contains an unexpected field.');
  if (value.orderPublicId !== orderPublicId || !Array.isArray(value.targets) || value.targets.length !== 1)
    throw new Error('Published M21 review snapshot has unexpected targets.');
  const target = value.targets[0];
  if (
    !record(target) ||
    JSON.stringify(Object.keys(target).sort()) !== JSON.stringify(['displayName', 'score', 'targetType']) ||
    target.targetType !== 'ORDER' ||
    target.displayName !== '订单整体' ||
    target.score !== 5
  )
    throw new Error('Published M21 review snapshot leaked a non-five-star target.');
  const serialized = JSON.stringify(value);
  for (const forbidden of ['陪玩 A', '陪玩 B', '陪玩 C', '猫舍前台', 'private-m21-comment-sentinel']) {
    if (serialized.includes(forbidden)) throw new Error(`Published M21 review snapshot leaked ${forbidden}.`);
  }
  return value as {
    orderPublicId: string;
    serviceDisplayName: string;
    completedAt: string;
    targets: Array<{ targetType: 'ORDER'; displayName: string; score: 5 }>;
  };
}

function validateFixtureInput(input: M21ReviewUatFixtureInput) {
  validateCheckpointInput(input);
  assertSnowflake(input.interactionChannelId, 'interactionChannelId');
  if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime()))
    throw new Error('completedAt is invalid.');
}

function validateCheckpointInput(input: CheckpointInput) {
  if (!/^[a-z0-9]{4,12}$/u.test(input.runId)) throw new Error('runId must contain 4-12 lowercase letters or digits.');
  assertSnowflake(input.guildId, 'guildId');
  assertSnowflake(input.customerDiscordId, 'customerDiscordId');
  assertSnowflake(input.reviewChannelId, 'reviewChannelId');
}

function assertSnowflake(value: string, field: string) {
  if (!/^\d{17,20}$/u.test(value)) throw new Error(`${field} must be a Discord snowflake.`);
}

function uuid(runId: string, key: string) {
  const bytes = createHash('sha256').update(`m21-review-uat:${runId}:${key}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.subarray(0, 16).toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function syntheticSnowflake(runId: string, key: string) {
  const value = BigInt(`0x${createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 15)}`);
  return (100_000_000_000_000_000n + (value % 800_000_000_000_000_000n)).toString();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
