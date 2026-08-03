import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  HttpBotApiClient,
  BotApiError,
  buildServiceLifecyclePanelMessage,
  handleServiceLifecycleAction,
  parseServiceCenterCustomId,
  type BotApiClient,
  type OrderLifecyclePanelSummary
} from '@blackcat/bot/service-center';

function lifecycleActions(status: string, role: 'CUSTOMER' | 'PLAYER'): OrderLifecyclePanelSummary['availableActions'] {
  const action = (
    key: OrderLifecyclePanelSummary['availableActions'][number]['key'],
    risk: 'PRIMARY' | 'SECONDARY' | 'DANGER'
  ) => ({ key, role, enabled: true, risk, reasonCode: null });
  if (role === 'PLAYER')
    return [
      ...(status === 'ACCEPTED' ? [action('PLAYER_SET_READINESS', 'PRIMARY')] : []),
      ...(status === 'IN_SERVICE' ? [action('PLAYER_REQUEST_COMPLETION', 'PRIMARY')] : []),
      action('PLAYER_REFRESH_WORKBENCH', 'SECONDARY'),
      action('PLAYER_CONTACT_SUPPORT', 'SECONDARY')
    ];
  return [
    ...(status === 'PENDING_CONFIRMATION' ? [action('CUSTOMER_CONFIRM_COMPLETION', 'PRIMARY')] : []),
    ...(status === 'IN_SERVICE' ? [action('CUSTOMER_SEND_GIFT', 'SECONDARY')] : []),
    ...(!['COMPLETED', 'CANCELLED'].includes(status)
      ? [
          action(
            status === 'DRAFT' || status === 'PENDING_DISPATCH'
              ? 'CUSTOMER_CANCEL_ORDER'
              : 'CUSTOMER_REQUEST_CANCELLATION',
            'DANGER'
          ),
          action('CUSTOMER_REFRESH_ORDER', 'SECONDARY')
        ]
      : []),
    action('CUSTOMER_CONTACT_SUPPORT', 'SECONDARY')
  ];
}

const acceptedOrder: OrderLifecyclePanelSummary = {
  orderId: '00000000-0000-0000-0000-00000000b401',
  publicId: 'P-4401',
  status: 'ACCEPTED',
  version: 4,
  actorRole: 'CUSTOMER',
  enabledFeatures: ['CORE_ORDER', 'GIFTS'],
  availableActions: lifecycleActions('ACCEPTED', 'CUSTOMER'),
  readiness: {
    participants: [],
    allActivePlayersReady: false,
    readyDeadlineAt: '2026-07-18T04:10:00.000Z',
    startedAt: null,
    staffTaskId: null
  }
};

const actor = {
  guildId: '999999999999999999',
  discordUserId: '111111111111111111',
  interactionId: '888888888888888888',
  clientSource: 'DISCORD_BOT' as const
};

describe('M2-US-04 Bot service lifecycle adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders readiness panel without a unilateral start-service action', () => {
    const message = buildServiceLifecyclePanelMessage(acceptedOrder);

    expect(message.title).toBe('🤝 订单 #P-4401 · 等待陪玩全员就绪');
    expect(message.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '👥 就绪名单', value: expect.stringContaining('陪玩名单：正在同步') })
      ])
    );
    expect(JSON.stringify(message.components)).not.toContain('开始服务');
    expect(message.components[0]?.components).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: '我已就绪' })])
    );
    expect(message.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '申请取消订单' }),
        expect.objectContaining({ label: '联系猫舍前台' })
      ])
    );
  });

  test('offers readiness only on the assigned player view', () => {
    const message = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      actorRole: 'PLAYER',
      availableActions: lifecycleActions('ACCEPTED', 'PLAYER')
    });
    expect(message.components[0]?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '陪玩：我已准备好',
          customId: 'bc:service:ready:00000000-0000-0000-0000-00000000b401:v4'
        })
      ])
    );
  });

  test('hides gift actions unless the lifecycle response authoritatively enables GIFTS', () => {
    const coreOnly = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      status: 'IN_SERVICE',
      availableActions: lifecycleActions('IN_SERVICE', 'CUSTOMER'),
      enabledFeatures: ['CORE_ORDER']
    });
    const giftsEnabled = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      status: 'IN_SERVICE',
      availableActions: lifecycleActions('IN_SERVICE', 'CUSTOMER')
    });

    expect(JSON.stringify(coreOnly)).not.toContain('赠送礼物');
    expect(JSON.stringify(giftsEnabled)).toContain('赠送礼物');
  });

  test('fails closed without throwing when readiness capabilities are missing or malformed', () => {
    for (const enabledFeatures of [undefined, 'GIFTS', null]) {
      expect(() =>
        buildServiceLifecyclePanelMessage({
          ...acceptedOrder,
          enabledFeatures: enabledFeatures as never
        })
      ).not.toThrow();
      expect(
        JSON.stringify(
          buildServiceLifecyclePanelMessage({
            ...acceptedOrder,
            enabledFeatures: enabledFeatures as never
          })
        )
      ).not.toContain('赠送礼物');
    }
  });

  test('renders in-service panel with player completion request action only for the assigned player', () => {
    const message = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      status: 'IN_SERVICE',
      version: 6,
      actorRole: 'PLAYER',
      availableActions: lifecycleActions('IN_SERVICE', 'PLAYER'),
      readiness: {
        ...acceptedOrder.readiness,
        customer: 'READY',
        player: 'READY',
        bothReady: true,
        startedAt: '2026-07-18T04:01:00.000Z'
      }
    });

    expect(message.title).toBe('🎮 订单 #P-4401 · 陪玩服务已开始');
    expect(message.components[0]?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '陪玩：提交服务完成',
          customId: 'bc:service:request-completion:00000000-0000-0000-0000-00000000b401:v6'
        })
      ])
    );
  });

  test('renders pending-confirmation panel with customer confirm action', () => {
    const message = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      status: 'PENDING_CONFIRMATION',
      version: 7,
      actorRole: 'CUSTOMER',
      availableActions: lifecycleActions('PENDING_CONFIRMATION', 'CUSTOMER'),
      readiness: {
        ...acceptedOrder.readiness,
        customer: 'READY',
        player: 'READY',
        bothReady: true,
        startedAt: '2026-07-18T04:01:00.000Z'
      }
    });

    expect(message.title).toBe('📨 订单 #P-4401 · 等待老板确认完成');
    expect(message.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '老板：确认服务完成',
          customId: 'bc:service:confirm:00000000-0000-0000-0000-00000000b401:v7'
        }),
        expect.objectContaining({ label: '申请取消订单' }),
        expect.objectContaining({ label: '联系猫舍前台' })
      ])
    );
  });

  test('keeps cancellation and appeal controls on the customer in-service panel without unilateral completion', () => {
    const message = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      status: 'IN_SERVICE',
      version: 6,
      actorRole: 'CUSTOMER',
      availableActions: lifecycleActions('IN_SERVICE', 'CUSTOMER'),
      readiness: {
        ...acceptedOrder.readiness,
        customer: 'READY',
        player: 'READY',
        bothReady: true,
        startedAt: '2026-07-18T04:01:00.000Z'
      }
    });
    const controls = message.components.flatMap((row) => row.components);
    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '申请取消订单' }),
        expect.objectContaining({ label: '联系猫舍前台' })
      ])
    );
    expect(controls.some((control) => control.type === 'BUTTON' && control.label === '确认完成')).toBe(false);
  });

  test('renders staff takeover state when cancellation or incident needs support', () => {
    const message = buildServiceLifecyclePanelMessage({
      ...acceptedOrder,
      status: 'EXCEPTION',
      version: 8,
      actorRole: 'CUSTOMER',
      readiness: {
        ...acceptedOrder.readiness,
        staffTaskId: '00000000-0000-0000-0000-00000000f901'
      }
    });

    expect(message.title).toBe('🛎️ 订单 #P-4401 · 客服处理中');
    expect(message.body).toContain('客服任务已创建');
    expect(message.body).toContain('不会自动取消、退款或扣罚任何一方');
    expect(JSON.stringify(message)).not.toContain('已取消');
  });

  test.each(['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'EXCEPTION'] as const)(
    'keeps a version-independent refresh action on the %s lifecycle panel',
    (status) => {
      const message = buildServiceLifecyclePanelMessage({
        ...acceptedOrder,
        status,
        version: 12,
        availableActions: lifecycleActions(status, 'CUSTOMER'),
        readiness: {
          ...acceptedOrder.readiness,
          staffTaskId: status === 'EXCEPTION' ? '00000000-0000-0000-0000-00000000f901' : null
        }
      });
      const controls = message.components.flatMap((row) => row.components);

      expect(controls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: '刷新最新状态',
            customId: `bc:order:${acceptedOrder.orderId}:refresh`
          })
        ])
      );
      expect(JSON.stringify(controls)).not.toContain(`bc:order:${acceptedOrder.orderId}:refresh:v`);
    }
  );

  test('HttpBotApiClient calls lifecycle endpoints through the unified API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          requestId: 'req_ready',
          data: { ...acceptedOrder, status: 'ACCEPTED', version: 5 }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          requestId: 'req_completion',
          data: {
            orderId: acceptedOrder.orderId,
            status: 'PENDING_CONFIRMATION',
            version: 7,
            actorRole: 'PLAYER',
            confirmationDueAt: '2026-07-18T04:30:00.000Z'
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          requestId: 'req_confirm',
          data: {
            orderId: acceptedOrder.orderId,
            status: 'COMPLETED',
            version: 8,
            capturedMinor: 12000,
            playerEarningMinor: 8400,
            currency: 'CAT'
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({ apiBaseUrl: 'http://api.test', botServiceToken: 'token' });

    await client.setOrderReadiness(
      acceptedOrder.orderId,
      { expectedVersion: 4, readiness: 'READY' },
      actor,
      'discord:order:ready:one'
    );
    await client.requestOrderCompletion(
      acceptedOrder.orderId,
      { expectedVersion: 6 },
      actor,
      'discord:order:completion:one'
    );
    await client.confirmOrder(
      acceptedOrder.orderId,
      { expectedVersion: 7, confirmation: 'CONFIRM_COMPLETED' },
      actor,
      'discord:order:confirm:one'
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `http://api.test/api/v1/orders/${acceptedOrder.orderId}/readiness`,
      expect.objectContaining({ method: 'PUT' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `http://api.test/api/v1/orders/${acceptedOrder.orderId}/request-completion`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `http://api.test/api/v1/orders/${acceptedOrder.orderId}/confirm`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('routes service lifecycle custom ids without leaking business logic into Discord metadata', async () => {
    expect(parseServiceCenterCustomId(`bc:service:ready:${acceptedOrder.orderId}:v4`)).toEqual({
      area: 'service-action',
      orderId: acceptedOrder.orderId,
      action: 'ready',
      expectedVersion: 4
    });
    expect(parseServiceCenterCustomId(`bc:service:request-completion:${acceptedOrder.orderId}:v6`)).toEqual({
      area: 'service-action',
      orderId: acceptedOrder.orderId,
      action: 'request-completion',
      expectedVersion: 6
    });
    expect(parseServiceCenterCustomId(`bc:service:confirm:${acceptedOrder.orderId}:v7`)).toEqual({
      area: 'service-action',
      orderId: acceptedOrder.orderId,
      action: 'confirm',
      expectedVersion: 7
    });
  });

  test('service lifecycle button handler calls the unified API and returns user-facing feedback', async () => {
    const api = {
      setOrderReadiness: vi.fn().mockResolvedValue({
        ...acceptedOrder,
        status: 'ACCEPTED',
        version: 5,
        readiness: { ...acceptedOrder.readiness, customer: 'READY' }
      }),
      requestOrderCompletion: vi.fn().mockResolvedValue({
        orderId: acceptedOrder.orderId,
        status: 'PENDING_CONFIRMATION',
        version: 7,
        actorRole: 'PLAYER',
        confirmationDueAt: '2026-07-18T04:30:00.000Z'
      }),
      confirmOrder: vi.fn().mockResolvedValue({
        orderId: acceptedOrder.orderId,
        status: 'COMPLETED',
        version: 8,
        capturedMinor: 12000,
        playerEarningMinor: 8400,
        currency: 'CAT'
      })
    } as Partial<BotApiClient> as BotApiClient;

    const ready = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: acceptedOrder.orderId,
      action: 'ready',
      expectedVersion: 4,
      idempotencyKey: 'discord:service:ready:888'
    });
    const requested = await handleServiceLifecycleAction({
      api,
      actor: { ...actor, discordUserId: '222222222222222222' },
      orderId: acceptedOrder.orderId,
      action: 'request-completion',
      expectedVersion: 6,
      idempotencyKey: 'discord:service:request-completion:888'
    });
    const confirmed = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: acceptedOrder.orderId,
      action: 'confirm',
      expectedVersion: 7,
      idempotencyKey: 'discord:service:confirm:888'
    });

    expect(api.setOrderReadiness).toHaveBeenCalledWith(
      acceptedOrder.orderId,
      { expectedVersion: 4, readiness: 'READY' },
      actor,
      'discord:service:ready:888'
    );
    expect(api.requestOrderCompletion).toHaveBeenCalledWith(
      acceptedOrder.orderId,
      { expectedVersion: 6 },
      { ...actor, discordUserId: '222222222222222222' },
      'discord:service:request-completion:888'
    );
    expect(api.confirmOrder).toHaveBeenCalledWith(
      acceptedOrder.orderId,
      { expectedVersion: 7, confirmation: 'CONFIRM_COMPLETED' },
      actor,
      'discord:service:confirm:888'
    );
    expect(ready).toMatchObject({
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: { title: '🤝 订单 #P-4401 · 等待陪玩全员就绪' }
    });
    expect(requested).toMatchObject({
      kind: 'EPHEMERAL_MESSAGE',
      message: expect.stringContaining('**下一步**：等待客人确认')
    });
    expect(confirmed).toMatchObject({
      kind: 'EPHEMERAL_MESSAGE',
      message: expect.stringContaining('**实际扣除**：1,200.0 CAT')
    });
  });

  test.each([
    {
      action: 'confirm' as const,
      apiMethod: 'confirmOrder' as const,
      expected: '这个「确认完成」按钮需要由本单客人操作'
    },
    {
      action: 'request-completion' as const,
      apiMethod: 'requestOrderCompletion' as const,
      expected: '这个「申请完成」按钮需要由本单陪玩操作'
    }
  ])(
    'explains who may use the $action action when the API denies permission',
    async ({ action, apiMethod, expected }) => {
      const denied = new BotApiError({
        code: 'PERMISSION_DENIED',
        message: 'Actor role does not match this action.',
        requestId: `req-${action}`,
        statusCode: 403
      });
      const api = {
        [apiMethod]: vi.fn().mockRejectedValue(denied)
      } as Partial<BotApiClient> as BotApiClient;

      const result = await handleServiceLifecycleAction({
        api,
        actor: { ...actor, discordUserId: '222222222222222222' },
        orderId: acceptedOrder.orderId,
        action,
        expectedVersion: 7,
        idempotencyKey: `discord:service:${action}:denied`
      });

      expect(result).toMatchObject({
        kind: 'EPHEMERAL_MESSAGE',
        message: expect.stringContaining(expected)
      });
      expect(result.kind === 'EPHEMERAL_MESSAGE' ? result.message : '').toContain(`request_id: req-${action}`);
    }
  );

  test('refreshes without replaying readiness when the component order version is stale', async () => {
    const setOrderReadiness = vi
      .fn()
      .mockRejectedValue(
        new BotApiError({
          code: 'CONFLICT',
          message: 'Order version is stale.',
          requestId: 'req-stale-ready',
          statusCode: 409
        })
      );
    const api = {
      setOrderReadiness,
      getOrder: vi.fn().mockResolvedValue({
        id: acceptedOrder.orderId,
        publicId: acceptedOrder.publicId,
        status: 'ACCEPTED',
        version: 7,
        game: 'VALORANT',
        service: 'FUN',
        region: null,
        billingUnitMinutes: 60,
        unitCount: 2,
        amountMinor: 400,
        currency: 'CAT',
        notes: null,
        channelSpec: { channelId: 'channel', panelMessageId: 'panel', voiceChannelId: 'voice' },
        matching: null
      })
    } as Partial<BotApiClient> as BotApiClient;

    const result = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: acceptedOrder.orderId,
      action: 'ready',
      expectedVersion: 6,
      idempotencyKey: 'discord:service:ready:stale'
    });

    expect(setOrderReadiness).toHaveBeenCalledOnce();
    expect(setOrderReadiness).toHaveBeenCalledWith(
      acceptedOrder.orderId,
      { expectedVersion: 6, readiness: 'READY' },
      actor,
      'discord:service:ready:stale'
    );
    expect(result).toMatchObject({
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: { title: expect.stringContaining('#P-4401') },
      notice: expect.stringContaining('req-stale-ready')
    });
  });
});
