import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOrderExperienceReviewStore } from '@blackcat/api/order-experience-reviews';
import { PostgresOrderReviewBroadcastStore } from '@blackcat/api/order-review-broadcast';
import type { AuditRecord } from '@blackcat/api/security';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres';
import { applyCurrentMigrations } from './support/postgres-migrations';

const guildId = '999999999999999999';
const customerDiscordId = '111111111111111111';
const staffDiscordId = '222222222222222222';
const orderId = '00000000-0000-0000-0000-000000021291';
const customerId = '00000000-0000-0000-0000-000000021292';
const playerId = '00000000-0000-0000-0000-000000021293';
const participantId = '00000000-0000-0000-0000-000000021294';
const staffUserId = '00000000-0000-0000-0000-000000021295';
const staffId = '00000000-0000-0000-0000-000000021296';
const catalogId = '00000000-0000-0000-0000-000000021297';
const legacyRatingId = '00000000-0000-0000-0000-000000021298';
const completedAt = new Date();
let isolated: IsolatedPostgres;
let pool: Pool;

describe('M21-US-02 PostgreSQL order experience reviews', () => {
  beforeAll(async () => {
    isolated = await startIsolatedPostgres('a7_review_upgrade', {
      excludeMigrations: ['000042_order_experience_reviews']
    });
    pool = isolated.pool;
    await seed();
    await applyCurrentMigrations({
      host: isolated.socketDir,
      port: isolated.port,
      database: isolated.database,
      only: ['000042_order_experience_reviews']
    });
  }, 45_000);

  afterAll(async () => isolated.stop());

  test('derives trusted targets and atomically persists reviews, comments and five-star snapshot', async () => {
    const store = new PostgresOrderExperienceReviewStore(pool);
    const context = { orderId, guildId, customerDiscordId, now: new Date(completedAt.getTime() + 1_000) };
    const businessFactsBefore = (
      await pool.query(
        `SELECT o.status::text,o.amount_minor,
                (SELECT count(*)::int FROM wallet_entries) AS wallet_entries,
                (SELECT count(*)::int FROM fund_reservations) AS reservations
           FROM orders o WHERE o.id=$1`,
        [orderId]
      )
    ).rows[0];
    const center = await store.getCenter(context);
    expect(center.targets.map((item) => item.targetKey)).toEqual([
      'order',
      `player:${participantId}`,
      `support:${staffId}`
    ]);
    expect(center.targets.find((item) => item.targetKey === `support:${staffId}`)?.review).toEqual(
      expect.objectContaining({ id: legacyRatingId, score: 4, comment: expect.objectContaining({ comment: '旧客服反馈' }) })
    );

    const low = await store.stageRatings({ ...context, targetKeys: [`player:${participantId}`], score: 1 });
    await low.commit(audit(low.data[0]!.id, 'CREATE_ORDER_EXPERIENCE_RATING'));
    expect(low.data[0]?.comment).toBeNull();

    const orderFive = await store.stageRatings({ ...context, targetKeys: ['order'], score: 5 });
    await orderFive.commit(audit(orderFive.data[0]!.id, 'CREATE_ORDER_EXPERIENCE_RATING'));
    const comment = await store.stageComment({ ...context, reviewId: orderFive.data[0]!.id, comment: ' 很满意 ' });
    await comment.commit(audit(comment.data.id, 'APPEND_ORDER_EXPERIENCE_REVIEW_COMMENT'));

    const publication = await store.stagePublication({ ...context, confirmation: 'PUBLISH_FIVE_STAR_SNAPSHOT' });
    await publication.commit(audit(orderId, 'PUBLISH_ORDER_FIVE_STAR_REVIEW'));
    const stored = await pool.query(`SELECT id,snapshot,status::text FROM order_review_publications WHERE order_id=$1`, [
      orderId
    ]);
    expect(stored.rows[0].id).toBe(publication.data.id);
    expect(stored.rows[0].snapshot.targets).toEqual([{ targetType: 'ORDER', displayName: '订单整体', score: 5 }]);
    expect(stored.rows[0].status).toBe('PENDING');
    await expect(
      pool.query(`UPDATE order_review_publications SET snapshot='{}'::jsonb WHERE order_id=$1`, [orderId])
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query(`DELETE FROM order_review_publications WHERE order_id=$1`, [orderId])).rejects.toThrow(
      /cannot be deleted/i
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::int count FROM outbox_events WHERE event_type='REVIEW_BROADCAST' AND order_id=$1`,
          [orderId]
        )
      ).rows[0].count
    ).toBe(1);
    await pool.query(
      `INSERT INTO guild_bot_configs(guild_id,version,config_json,updated_by_staff_id,updated_at)
       VALUES($1,1,$2::jsonb,$3,$4)`,
      [guildId, JSON.stringify({ review_broadcast_channel_id: '777777777777777778' }), staffId, context.now]
    );
    const broadcastStore = new PostgresOrderReviewBroadcastStore(pool);
    expect(await broadcastStore.getPublication(publication.data.id)).toMatchObject({
      id: publication.data.id,
      orderId,
      guildId,
      status: 'PENDING',
      snapshot: { targets: [{ targetType: 'ORDER', displayName: '订单整体', score: 5 }] }
    });
    expect(await broadcastStore.getBroadcastChannelId(guildId)).toBe('777777777777777778');
    await broadcastStore.markPublished({
      publicationId: publication.data.id,
      channelId: '777777777777777778',
      messageId: '666666666666666667',
      publishedAt: context.now.toISOString()
    });
    expect(
      (await pool.query(`SELECT status::text,broadcast_message_id FROM order_review_publications WHERE id=$1`, [
        publication.data.id
      ])).rows[0]
    ).toEqual({ status: 'PUBLISHED', broadcast_message_id: '666666666666666667' });
    const businessFactsAfter = (
      await pool.query(
        `SELECT o.status::text,o.amount_minor,
                (SELECT count(*)::int FROM wallet_entries) AS wallet_entries,
                (SELECT count(*)::int FROM fund_reservations) AS reservations
           FROM orders o WHERE o.id=$1`,
        [orderId]
      )
    ).rows[0];
    expect(businessFactsAfter).toEqual(businessFactsBefore);
  });

  test('allows only one concurrent score per target and blocks mutation', async () => {
    const secondOrder = '00000000-0000-0000-0000-000000021299';
    await pool.query(
      `INSERT INTO orders(id,public_id,customer_id,status,row_version,guild_id,completed_at,created_at,updated_at) VALUES($1,'P-M21-SECOND',$2,'COMPLETED',1,$3,$4,$4,$4)`,
      [secondOrder, customerId, guildId, completedAt]
    );
    const store = new PostgresOrderExperienceReviewStore(pool);
    const input = {
      orderId: secondOrder,
      guildId,
      customerDiscordId,
      now: new Date(completedAt.getTime() + 1_000),
      targetKeys: ['order'],
      score: 5
    };
    const staged = await Promise.all([store.stageRatings(input), store.stageRatings(input)]);
    const results = await Promise.allSettled(
      staged.map((item) => item.commit(audit(item.data[0]!.id, 'CREATE_ORDER_EXPERIENCE_RATING')))
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    await expect(
      pool.query(`UPDATE order_experience_reviews SET score=2 WHERE order_id=$1`, [secondOrder])
    ).rejects.toThrow(/append-only/i);
    await expect(pool.query(`DELETE FROM order_experience_reviews WHERE order_id=$1`, [secondOrder])).rejects.toThrow(
      /append-only/i
    );
  });
});

async function seed() {
  await pool.query(`
    INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${customerId}','老板','ACTIVE',1,now(),now()),('${playerId}','小黑','ACTIVE',1,now(),now()),('${staffUserId}','客服','ACTIVE',1,now(),now());
    INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      (gen_random_uuid(),'${customerId}','${guildId}','${customerDiscordId}',now(),now(),now()),
      (gen_random_uuid(),'${staffUserId}','${guildId}','${staffDiscordId}',now(),now(),now());
    INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ('${staffId}','${staffUserId}','L1_SUPPORT','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000021280','LOL-DUO','LOL','英雄联盟','DUO','双排',now(),now());
    INSERT INTO service_catalog_versions(id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES
      ('${catalogId}','00000000-0000-0000-0000-000000021280',1,'ACTIVE',60,1,100,50,5000,'CAT','${staffId}',now());
    INSERT INTO orders(id,public_id,customer_id,status,row_version,guild_id,channel_id,service_name_snapshot,completed_at,created_at,updated_at) VALUES
      ('${orderId}','P-M21-REVIEW','${customerId}','COMPLETED',10,'${guildId}','777777777777777777','英雄联盟双排','${completedAt.toISOString()}','${completedAt.toISOString()}','${completedAt.toISOString()}');
    INSERT INTO order_participants(id,order_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,created_at,updated_at) VALUES
      ('${participantId}','${orderId}','${playerId}','${catalogId}','ACTIVE',1,'小黑','LOL','英雄联盟','DUO','双排',60,1,100,100,'PERCENT_BPS',5000,'CATALOG_DEFAULT',50,now(),now());
    INSERT INTO order_channel_message_events(id,order_id,order_public_id,guild_id,channel_id,discord_message_id,event_id,event_type,author_discord_id,author_display_name,author_is_bot,content_snapshot,observed_at) VALUES
      ('00000000-0000-0000-0000-000000021281','${orderId}','P-M21-REVIEW','${guildId}','777777777777777777','555555555555555555','CREATED:555555555555555555','CREATED','${staffDiscordId}','客服',false,'我来处理','${completedAt.toISOString()}');
    INSERT INTO staff_tasks(id,public_id,type,reason_code,status,row_version,order_id,context_snapshot,response_status,response_due_at,first_responded_at,first_response_event_id,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000021282','T-M21-REVIEW','ORDER_ASSIST','CUSTOMER_HELP','RESOLVED',2,'${orderId}','{}','MET','${completedAt.toISOString()}','${completedAt.toISOString()}','00000000-0000-0000-0000-000000021281','${completedAt.toISOString()}','${completedAt.toISOString()}');
    INSERT INTO order_support_ratings(id,order_id,customer_id,attributed_staff_id,score,comment,expires_at,created_at) VALUES
      ('${legacyRatingId}','${orderId}','${customerId}','${staffId}',4,'旧客服反馈','${new Date(completedAt.getTime() + 86_400_000).toISOString()}','${completedAt.toISOString()}');
  `);
}

function audit(targetId: string, action: string): AuditRecord {
  return {
    id: randomUUID(),
    actorId: customerId,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT_SERVICE',
    interactionId: '888888888888888888',
    permissionCode: 'order.experience_review.create',
    action,
    targetType: 'order_experience_review',
    targetId,
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: randomUUID(),
    approvalRequestId: null,
    occurredAt: new Date(completedAt.getTime() + 1_000).toISOString()
  };
}
