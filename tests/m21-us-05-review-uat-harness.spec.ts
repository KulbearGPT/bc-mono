import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrderExperienceReviewStore } from '@blackcat/api/order-experience-reviews';
import { PostgresOrderReviewBroadcastStore } from '@blackcat/api/order-review-broadcast';
import type { AuditRecord } from '@blackcat/api/security';
import {
  bindM21ReviewUatEntryMessage,
  prepareM21ReviewUatFixture,
  requeueM21ReviewUatBroadcast,
  verifyM21ReviewFinalCheckpoint,
  verifyM21ReviewInternalCheckpoint
} from '../scripts/uat/m21-review-flow-fixture.js';

const execFile = promisify(execFileCallback);
const runId = 'review05';
const guildId = '999999999999999999';
const customerDiscordId = '111111111111111111';
const interactionChannelId = '777777777777777771';
const reviewChannelId = '777777777777777772';
const firstMessageId = '666666666666666661';
let root = '';
let data = '';
let pool: Pool;

describe('M21-US-05 isolated external-UAT harness', () => {
  beforeAll(async () => {
    const port = 63_100 + (process.pid % 20);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m21-uat-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m21_review_uat']);
    for (const migration of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', [
        '-h',
        root,
        '-p',
        String(port),
        '-d',
        'blackcat_m21_review_uat',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        `database/prisma/migrations/${migration}/migration.sql`
      ]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m21_review_uat', max: 5 });
  }, 45_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('ships explicit isolated-database, SANDBOX and cleanup guards', async () => {
    const script = await readFile('scripts/uat/m21-review-flow-uat.ts', 'utf8');
    const databaseScript = await readFile('scripts/uat/m21-review-flow-db.sh', 'utf8');
    const serviceScript = await readFile('scripts/uat/m21-review-flow-services.sh', 'utf8');
    expect(script).toContain("M21_UAT_CONFIRM !== 'USE_ISOLATED_REVIEW_UAT'");
    expect(script).toContain("BUSINESS_ENV !== 'SANDBOX'");
    expect(script).toContain("includes('_uat')");
    expect(script).toContain("case 'check-internal'");
    expect(script).toContain("case 'verify-final'");
    expect(script).toContain("case 'requeue-broadcast'");
    expect(script).toContain("case 'delete-and-requeue'");
    expect(script).toContain("case 'cleanup'");
    expect(script).toContain('`bc:r:${fixture.orderId}:o`');
    expect(script).toContain("channel.delete('M21 review flow UAT cleanup')");
    expect(databaseScript).toContain('CREATE_OR_DROP_ISOLATED_M21_UAT');
    expect(databaseScript).toContain('database_name" != *"_uat"*');
    expect(databaseScript).toContain('prisma migrate deploy');
    expect(databaseScript).toContain('DROP DATABASE IF EXISTS');
    expect(serviceScript).toContain('M21_UAT_RUNTIME_DATABASE_URL');
    expect(serviceScript).toContain('REVIEW_CONTINUATION_SIGNING_SECRET');
    expect(serviceScript).toContain('env -u PORT');
    expect(serviceScript).toContain('npm run start:web');
    expect(serviceScript).toContain('npm run start:worker');
    expect(serviceScript).toContain('npm run start:bot');
  });

  test('seeds a trusted three-player/support fixture and verifies internal-save plus final privacy facts', async () => {
    const completedAt = new Date('2026-08-13T08:00:00.000Z');
    const fixture = await prepareM21ReviewUatFixture(pool, {
      runId,
      guildId,
      customerDiscordId,
      interactionChannelId,
      reviewChannelId,
      completedAt
    });
    const repeated = await prepareM21ReviewUatFixture(pool, {
      runId,
      guildId,
      customerDiscordId,
      interactionChannelId,
      reviewChannelId,
      completedAt
    });
    expect(repeated).toEqual(fixture);
    await bindM21ReviewUatEntryMessage(pool, {
      runId,
      guildId,
      interactionChannelId,
      entryMessageId: firstMessageId
    });
    expect(
      (
        await pool.query(`SELECT panel_message_id,amount_minor::text,currency FROM orders WHERE id=$1`, [
          fixture.orderId
        ])
      ).rows[0]
    ).toEqual({ panel_message_id: firstMessageId, amount_minor: '300', currency: 'CAT' });

    const store = new PostgresOrderExperienceReviewStore(pool);
    const context = {
      orderId: fixture.orderId,
      guildId,
      customerDiscordId,
      now: new Date(completedAt.getTime() + 60_000)
    };
    const initial = await store.getCenter(context);
    expect(initial.targets.map((target) => [target.targetKey, target.displayName])).toEqual([
      ['order', '订单整体'],
      [fixture.playerTargetKeys[0], '陪玩 A'],
      [fixture.playerTargetKeys[1], '陪玩 B'],
      [fixture.playerTargetKeys[2], '陪玩 C'],
      [fixture.supportTargetKey, '猫舍前台']
    ]);

    const overall = await store.stageRatings({ ...context, targetKeys: ['order'], score: 5 });
    await overall.commit(audit(fixture.customerId, overall.data[0]!.id, 'CREATE_ORDER_EXPERIENCE_RATING'));
    const players = await store.stageRatings({
      ...context,
      targetKeys: fixture.playerTargetKeys.slice(0, 2),
      score: 4
    });
    await players.commit(audit(fixture.customerId, fixture.orderId, 'CREATE_ORDER_EXPERIENCE_RATING'));
    const support = await store.stageRatings({ ...context, targetKeys: [fixture.supportTargetKey], score: 2 });
    await support.commit(audit(fixture.customerId, support.data[0]!.id, 'CREATE_ORDER_EXPERIENCE_RATING'));
    const comment = await store.stageComment({
      ...context,
      reviewId: support.data[0]!.id,
      comment: 'private-m21-comment-sentinel'
    });
    await comment.commit(audit(fixture.customerId, comment.data.id, 'APPEND_ORDER_EXPERIENCE_REVIEW_COMMENT'));

    await expect(
      verifyM21ReviewInternalCheckpoint(pool, { runId, guildId, customerDiscordId, reviewChannelId })
    ).resolves.toMatchObject({
      orderScore: 5,
      playerScores: [4, 4, null],
      supportScore: 2,
      commentCount: 1,
      publicationCount: 0,
      reviewBroadcastCount: 0,
      businessFactsUnchanged: true,
      protectedFacts: {
        reservationStatus: 'CAPTURED',
        walletNetMinor: '700',
        consumptionMinor: '300',
        earningMinor: '150',
        commissionMinor: '6',
        dispatchCount: 1,
        riskEventCount: 1,
        staffPermissionsVersion: 1
      }
    });

    const publication = await store.stagePublication({ ...context, confirmation: 'PUBLISH_FIVE_STAR_SNAPSHOT' });
    await publication.commit(audit(fixture.customerId, publication.data.id, 'PUBLISH_ORDER_FIVE_STAR_REVIEW'));
    const broadcast = new PostgresOrderReviewBroadcastStore(pool);
    await broadcast.markPublished({
      publicationId: publication.data.id,
      channelId: reviewChannelId,
      messageId: firstMessageId,
      publishedAt: context.now.toISOString()
    });
    await pool.query(
      `UPDATE outbox_events SET status='COMPLETED',completed_at=$2,updated_at=$2
        WHERE event_type='REVIEW_BROADCAST' AND order_id=$1`,
      [fixture.orderId, context.now]
    );

    await expect(
      verifyM21ReviewFinalCheckpoint(pool, {
        runId,
        guildId,
        customerDiscordId,
        reviewChannelId,
        visibleReviewMessageIds: [firstMessageId],
        renderedReviewCards: [`老板五星好评 ${fixture.orderPublicId} 订单整体 ★★★★★`]
      })
    ).resolves.toMatchObject({
      publicationStatus: 'PUBLISHED',
      broadcastMessageId: firstMessageId,
      publicTargetCount: 1,
      visibleReviewMessageCount: 1,
      privateFieldsAbsent: true,
      businessFactsUnchanged: true,
      protectedFacts: expect.objectContaining({
        reservationStatus: 'CAPTURED',
        walletNetMinor: '700',
        consumptionMinor: '300',
        earningMinor: '150',
        commissionMinor: '6'
      }),
      status: 'PASS'
    });
    const replay = await requeueM21ReviewUatBroadcast(pool, { runId, guildId, customerDiscordId });
    expect(replay).toMatchObject({
      orderId: fixture.orderId,
      previousMessageId: firstMessageId,
      outboxStatus: 'PENDING'
    });
    expect(
      (await pool.query(`SELECT count(*)::int count FROM outbox_events WHERE event_type='REVIEW_BROADCAST'`)).rows[0]
        .count
    ).toBe(1);
  });
});

function audit(actorId: string, targetId: string, action: string): AuditRecord {
  return {
    id: randomUUID(),
    actorId,
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
    occurredAt: '2026-08-13T08:01:00.000Z'
  };
}
