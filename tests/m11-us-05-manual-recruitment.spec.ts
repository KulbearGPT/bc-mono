import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  InMemorySelectionPoolStore,
  type CreateSelectionPoolInput,
  type CloseSelectionPoolInput
} from '@blackcat/api/selection-pools';
import { createSelectionPoolCloseHandler } from '../apps/api/src/selection-pool-worker.js';
import { buildSelectionPoolRefreshMessage } from '../apps/bot/src/selection-discord.js';

const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-000000115001';
const requirementId = '00000000-0000-0000-0000-000000115101';
const customerDiscordUserId = '111111111111111111';
const playerDiscordUserId = '222222222222222222';

describe('M11-US-05 manual recruitment', () => {
  test('keeps the current contracts mirrored and removes duration-driven recruitment', async () => {
    const [spec, outputApi, docsApi, outputBacklog, docsBacklog, outputAcceptance, docsAcceptance] = await Promise.all([
      readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8'),
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('docs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8'),
      readFile('docs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8')
    ]);

    expect(outputApi).toBe(docsApi);
    expect(outputBacklog).toBe(docsBacklog);
    expect(outputAcceptance).toBe(docsAcceptance);
    expect(spec).toContain('Bot 只提供“开始招募”和“终止招募”');
    expect(outputBacklog).toContain('M11-US-05');
    expect(outputBacklog).toContain('无时限手动招募与实时报名名单');
    expect(outputAcceptance).toContain('AT-SEL-007');
    expect(outputAcceptance).toContain('<@discordUserId>');
    expect(outputApi).toContain('required: [expectedOrderVersion]');
    expect(outputApi).not.toContain('required: [expectedOrderVersion, waitMinutes]');
    expect(outputApi).toContain('required: [expectedPoolVersion]');
    expect(outputApi).not.toContain('required: [expectedPoolVersion, reason]');
  });

  test('creates an unbounded pool, accepts a much later application, and records a server-owned stop reason', async () => {
    const store = fixtureStore();
    const created = await commit(
      store.createPool({
        orderId,
        actorGuildId: guildId,
        actorDiscordUserId: customerDiscordUserId,
        expectedOrderVersion: 1,
        idempotencyKey: 'manual:create',
        now: new Date('2026-08-08T12:00:00.000Z')
      } as CreateSelectionPoolInput)
    );

    expect(created.pool).toMatchObject({ status: 'COLLECTING', waitMinutes: null, closesAt: null });

    const applied = await commit(
      store.apply({
        orderId,
        selectionPoolId: created.pool.id,
        orderRequirementId: requirementId,
        actorGuildId: guildId,
        actorDiscordUserId: playerDiscordUserId,
        expectedPoolVersion: created.pool.version,
        idempotencyKey: 'manual:apply:later',
        now: new Date('2027-08-08T12:00:00.000Z')
      })
    );
    expect(applied.application.status).toBe('APPLIED');
    expect(
      store.getCurrentPool({ orderId, actorGuildId: guildId, actorDiscordUserId: customerDiscordUserId }).pool
    ).toMatchObject({ applicantDiscordUserIds: [playerDiscordUserId] });

    const closed = await commit(
      store.closePool({
        orderId,
        selectionPoolId: created.pool.id,
        actorGuildId: guildId,
        actorDiscordUserId: customerDiscordUserId,
        expectedPoolVersion: created.pool.version,
        idempotencyKey: 'manual:stop',
        now: new Date('2027-08-08T12:01:00.000Z')
      } as CloseSelectionPoolInput)
    );
    expect(closed.pool).toMatchObject({ status: 'SELECTION', closeReason: 'CUSTOMER_STOPPED' });
  });

  test('renders current applicants as silent Discord mentions and exposes only manual controls', () => {
    const message = buildSelectionPoolRefreshMessage(
      {
        id: orderId,
        publicId: 'P-115005',
        version: 3,
        channelSpec: { channelId: '555555555555555555', panelMessageId: '666666666666666666' }
      } as never,
      {
        id: '00000000-0000-0000-0000-000000115501',
        orderId,
        round: 1,
        status: 'COLLECTING',
        version: 2,
        waitMinutes: null,
        openedAt: '2026-08-08T12:00:00.000Z',
        closesAt: null,
        closedAt: null,
        closeReason: null,
        applicationCount: 2,
        applicantDiscordUserIds: [playerDiscordUserId, '333333333333333333']
      } as never
    );

    const rendered = JSON.stringify(message);
    expect(rendered).toContain('<@' + playerDiscordUserId + '>');
    expect(rendered).toContain('<@333333333333333333>');
    expect(rendered).toContain('结束报名，进入试音');
    expect(rendered).not.toContain('报名截止');
    expect(rendered).not.toContain('选择等待时间');
  });

  test('consumes legacy close jobs without changing business state', async () => {
    const close = vi.fn();
    const handler = createSelectionPoolCloseHandler({ close });
    await handler({
      id: 'legacy-close-job',
      type: 'SELECTION_POOL_CLOSE',
      aggregateType: 'selection_pool',
      aggregateId: '00000000-0000-0000-0000-000000115501',
      payload: {
        orderId,
        selectionPoolId: '00000000-0000-0000-0000-000000115501'
      },
      attempts: 1,
      maxAttempts: 5,
      runAfter: '2026-08-08T12:03:00.000Z',
      createdAt: '2026-08-08T12:00:00.000Z'
    } as never);
    expect(close).not.toHaveBeenCalled();
  });
});

function fixtureStore() {
  return new InMemorySelectionPoolStore({
    orders: [
      {
        id: orderId,
        guildId,
        customerDiscordUserId,
        status: 'PENDING_DISPATCH',
        version: 1,
        reservationId: 'reservation-manual'
      }
    ],
    requirements: [
      {
        id: requirementId,
        orderId,
        status: 'ACTIVE',
        serviceCatalogVersionId: '00000000-0000-0000-0000-000000115201',
        requestedPlayerCount: 1,
        filledPlayerCount: 0,
        game: 'valorant',
        gameDisplayName: '瓦洛兰特',
        service: 'duo',
        serviceDisplayName: '娱乐陪玩',
        region: null,
        regionDisplayName: null,
        billingUnitMinutes: 60,
        unitCount: 1,
        customerUnitPriceMinor: 200,
        linePriceMinor: 200
      }
    ],
    players: [
      {
        id: '00000000-0000-0000-0000-000000115301',
        guildId,
        discordUserId: playerDiscordUserId,
        displayName: 'Player One',
        reviewStatus: 'ACTIVE',
        matchingCatalogIds: ['00000000-0000-0000-0000-000000115201'],
        activeOrderId: null,
        compensationType: 'PERCENT_BPS',
        compensationValue: 5000
      }
    ]
  });
}

async function commit<T>(staged: { data: T; commit(audit: never): Promise<void> | void }): Promise<T> {
  await staged.commit({} as never);
  return staged.data;
}
