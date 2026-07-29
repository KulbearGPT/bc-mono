import { describe, expect, test, vi } from 'vitest';
import { buildServiceLifecyclePanelMessage, type OrderLifecyclePanelSummary } from '@blackcat/bot/service-center';
import { DiscordRestWorkerAdapter } from '../apps/api/src/worker-adapters.js';
import type { OrderPanelProjection } from '../apps/api/src/worker-runtime.js';

describe('M18-US-06 service lifecycle experience', () => {
  test('lists every player readiness without asking the customer to submit readiness', () => {
    const message = buildServiceLifecyclePanelMessage(lifecycle({ status: 'ACCEPTED' }));

    expect(message.title).toContain('等待陪玩全员就绪');
    expect(message.density).toBe('PRIVATE_ORDER');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '👥 就绪名单',
      '⏰ 确认时限',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    const roster = message.fields?.[0]?.value ?? '';
    expect(roster).toContain('奶糖：✅ 已就绪');
    expect(roster).toContain('布丁：⏳ 未就绪');
    expect(roster).not.toMatch(/老板|客户|用户/u);
    expect(JSON.stringify(message)).toContain('老板无需提交就绪');
    expect(JSON.stringify(message.components)).not.toContain('我已就绪');
    expect(JSON.stringify(message.components)).not.toContain('开始服务');
  });

  test('offers the readiness action to an active player view', () => {
    const message = buildServiceLifecyclePanelMessage(lifecycle({ status: 'ACCEPTED', actorRole: 'PLAYER' }));

    expect(JSON.stringify(message.components)).toContain('陪玩：我已准备好');
    expect(JSON.stringify(message)).not.toContain('老板无需提交就绪');
  });

  test('makes service start a positive milestone while keeping the player completion request distinct', () => {
    const message = buildServiceLifecyclePanelMessage(
      lifecycle({
        status: 'IN_SERVICE',
        actorRole: 'PLAYER',
        readiness: { startedAt: '2026-08-08T12:10:00.000Z' }
      })
    );

    expect(message.title).toContain('陪玩服务已开始');
    expect(message.tone).toBe('SUCCESS');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '🎮 服务状态',
      '⏱️ 开始时间',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    expect(JSON.stringify(message.components)).toContain('陪玩：提交服务完成');
    expect(JSON.stringify(message)).not.toContain('已完成订单');
  });

  test('reserves the final confirmation action for the customer and explains that it settles the order', () => {
    const message = buildServiceLifecyclePanelMessage(
      lifecycle({ status: 'PENDING_CONFIRMATION', actorRole: 'CUSTOMER' })
    );

    expect(message.title).toContain('等待老板确认完成');
    expect(message.fields?.map((field) => field.name)).toEqual(['📨 完成申请', '⏳ 当前进度', '👉 下一步']);
    expect(JSON.stringify(message)).toContain('确认后才会完成订单结算');
    expect(JSON.stringify(message.components)).toContain('老板：确认服务完成');
  });

  test('renders completed service as a quiet success without inventing payout facts', () => {
    const message = buildServiceLifecyclePanelMessage(lifecycle({ status: 'COMPLETED' }));

    expect(message.title).toContain('服务圆满完成');
    expect(message.tone).toBe('SUCCESS');
    expect(JSON.stringify(message)).toContain('订单与资金结果已由业务 API 记录');
    expect(JSON.stringify(message)).not.toMatch(/预计收益|应付|payout/iu);
  });

  test('updates the persisted Discord order panel with per-player readiness and role-specific actions', async () => {
    const projection = {
      orderId: '00000000-0000-0000-0000-000000180611',
      publicId: 'P-M18-WORKER',
      status: 'ACCEPTED',
      version: 6,
      channelId: '333333333333333333',
      panelMessageId: '444444444444444444',
      customerDiscordUserId: '111111111111111111',
      playerDiscordUserId: null,
      playerDiscordUserIds: [],
      participants: [
        {
          discordUserId: '222222222222222222',
          displayName: '奶糖',
          readiness: 'READY',
          linePriceMinor: 120,
          expectedEarningMinor: 80,
          compensationSource: 'CATALOG_DEFAULT'
        },
        {
          discordUserId: '333333333333333334',
          displayName: '布丁',
          readiness: 'NOT_READY',
          linePriceMinor: 120,
          expectedEarningMinor: 80,
          compensationSource: 'PLAYER_OVERRIDE'
        }
      ],
      allActivePlayersReady: false,
      readyDeadlineAt: '2026-08-08T12:20:00.000Z',
      startedAt: null,
      amountMinor: 240,
      currency: 'CAT'
    } satisfies OrderPanelProjection;
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: projection.panelMessageId }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await adapter.upsertOrderPanel(projection, '2026-08-08T12:00:00.000Z');

    const panelRequest = fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH');
    const body = JSON.parse(panelRequest?.[1]?.body as string);
    const rendered = JSON.stringify(body.components);
    expect(rendered).toContain('奶糖：✅ 已就绪');
    expect(rendered).toContain('布丁：⏳ 未就绪');
    expect(rendered).toContain('老板无需提交就绪');
    expect(rendered).toContain('陪玩确认就绪');
    expect(rendered).not.toContain('等待双方');
  });
});

function lifecycle(
  overrides: Partial<OrderLifecyclePanelSummary> & {
    readiness?: Partial<OrderLifecyclePanelSummary['readiness']>;
  } = {}
): OrderLifecyclePanelSummary {
  const status = overrides.status ?? 'ACCEPTED';
  const actorRole = overrides.actorRole ?? 'CUSTOMER';
  const availableActions =
    overrides.availableActions ??
    (actorRole === 'PLAYER'
      ? [
          ...(status === 'ACCEPTED'
            ? [
                {
                  key: 'PLAYER_SET_READINESS' as const,
                  role: 'PLAYER' as const,
                  enabled: true,
                  risk: 'PRIMARY' as const,
                  reasonCode: null
                }
              ]
            : []),
          ...(status === 'IN_SERVICE'
            ? [
                {
                  key: 'PLAYER_REQUEST_COMPLETION' as const,
                  role: 'PLAYER' as const,
                  enabled: true,
                  risk: 'PRIMARY' as const,
                  reasonCode: null
                }
              ]
            : [])
        ]
      : status === 'PENDING_CONFIRMATION'
        ? [
            {
              key: 'CUSTOMER_CONFIRM_COMPLETION' as const,
              role: 'CUSTOMER' as const,
              enabled: true,
              risk: 'PRIMARY' as const,
              reasonCode: null
            }
          ]
        : []);
  return {
    orderId: '00000000-0000-0000-0000-000000180601',
    publicId: 'P-M18-SERVICE',
    status: 'ACCEPTED',
    version: 4,
    actorRole: 'CUSTOMER',
    enabledFeatures: ['CORE_ORDER', 'GIFTS'],
    ...overrides,
    availableActions,
    readiness: {
      participants: [
        {
          participantId: '00000000-0000-0000-0000-000000180602',
          playerId: '00000000-0000-0000-0000-000000180603',
          displayName: '奶糖',
          readiness: 'READY'
        },
        {
          participantId: '00000000-0000-0000-0000-000000180604',
          playerId: '00000000-0000-0000-0000-000000180605',
          displayName: '布丁',
          readiness: 'NOT_READY'
        }
      ],
      allActivePlayersReady: false,
      readyDeadlineAt: '2026-08-08T12:20:00.000Z',
      startedAt: null,
      staffTaskId: null,
      ...overrides.readiness
    }
  };
}
