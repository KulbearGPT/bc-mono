import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  BotApiError,
  HttpBotApiClient,
  buildOrderConfirmationMessage,
  handleOrderRefresh,
  handleOpenOrderConfirmation,
  parseServiceCenterCustomId,
  type BalanceSummary,
  type BotActorContext,
  type BotApiClient,
  type OrderSummary
} from '@blackcat/bot/service-center';

const guildId = '999999999999999999';
const customerDiscordUserId = '111111111111111111';
const interactionId = '777777777777777777';
const orderId = '00000000-0000-0000-0000-00000000b001';

function actor(): BotActorContext {
  return {
    guildId,
    discordUserId: customerDiscordUserId,
    interactionId,
    clientSource: 'DISCORD_BOT'
  };
}

function draftOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-1042',
    status: 'DRAFT',
    version: 5,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    amountMinor: 9_999,
    currency: 'CAT',
    notes: '轻松交流，不急着上分',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: null
    },
    ...overrides
  };
}

function estimate(overrides: Record<string, unknown> = {}) {
  return {
    serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
    catalogVersion: 3,
    unitCount: 2,
    billingUnitMinutes: 60,
    amountMinor: 12_000,
    currency: 'CAT',
    validUntil: '2026-07-17T22:05:00.000Z',
    ...overrides
  };
}

function balance(overrides: Partial<BalanceSummary> = {}): BalanceSummary {
  return {
    ledgerBalanceMinor: 20_000,
    reservedMinor: 2_000,
    availableMinor: 18_000,
    currency: 'CAT',
    calculatedAt: '2026-07-17T22:00:00.000Z',
    ...overrides
  };
}

function api(overrides: Partial<BotApiClient> = {}): BotApiClient {
  return {
    createBinding: vi.fn(),
    createOrder: vi.fn(),
    getOrder: vi.fn().mockResolvedValue(draftOrder()),
    updateOrder: vi.fn(),
    getCurrentUser: vi.fn(),
    getCurrentBalance: vi.fn().mockResolvedValue(balance()),
    listCurrentUserConsumptions: vi.fn(),
    listCurrentUserCommissions: vi.fn(),
    estimateOrder: vi.fn().mockResolvedValue(estimate()),
    ...overrides
  };
}

describe('M1-US-07 order confirmation panel', () => {
  test('renders a complete private confirmation from estimate and balance, not draft amount fields', () => {
    const message = buildOrderConfirmationMessage({
      order: draftOrder({ amountMinor: 1 }),
      estimate: estimate({ amountMinor: 12_000 }),
      balance: balance({ availableMinor: 18_000 })
    });

    expect(message.visibility).toBe('PRIVATE_CHANNEL');
    expect(message.title).toBe('📋 订单 #P-1042 · 最后确认');
    expect(message.body).toContain('游戏：无畏契约');
    expect(message.body).toContain('服务：娱乐陪玩');
    expect(message.body).toContain('区服：北美');
    expect(message.body).toContain('时长：2 小时');
    expect(message.body).toContain('标签：P0 默认匹配');
    expect(message.body).toContain('备注：轻松交流，不急着上分');
    expect(message.body).toContain('预计价格：1,200.0 CAT');
    expect(message.body).toContain('可用余额：1,800.0 CAT');
    expect(message.body).toContain('取消规则：提交前取消不预留；提交后、服务开始前取消将释放预留，异常由客服处理。');
    expect(message.body).not.toContain('0.1 CAT');
    expect(message.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'BUTTON',
          customId: `bc:order:${orderId}:submit-final:v5`,
          label: '确认提交并预留',
          disabled: false
        })
      ])
    );
    expect(JSON.stringify(message)).not.toMatch(/playerEarning|playerPayout|陪玩结算|playerUnitPayout/i);
  });

  test('disables final submit when API balance says available amount is insufficient', () => {
    const message = buildOrderConfirmationMessage({
      order: draftOrder(),
      estimate: estimate({ amountMinor: 12_000 }),
      balance: balance({ availableMinor: 8_000 })
    });

    expect(message.body).toContain('余额不足：还差 400.0 CAT，请联系客服并提交付款 receipt，到账后刷新确认。');
    expect(message.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customId: `bc:order:${orderId}:submit-final:v5`,
          disabled: true
        }),
        expect.objectContaining({
          customId: 'bc:service-center:recharge',
          label: '联系客服充值',
          disabled: false
        })
      ])
    );
  });

  test('allows final submit when the selected service does not define an optional region',()=>{
    const message=buildOrderConfirmationMessage({order:draftOrder({region:null}),estimate:estimate(),balance:balance()});
    expect(message.body).toContain('区服：无指定区服');
    expect(message.body).not.toContain('请补齐区服');
    expect(message.components.flatMap((row)=>row.components)).toEqual(expect.arrayContaining([expect.objectContaining({customId:`bc:order:${orderId}:submit-final:v5`,disabled:false})]));
  });

  test('opens confirmation by calling getOrder, estimateOrder and getCurrentBalance through unified API client', async () => {
    const client = api();

    const result = await handleOpenOrderConfirmation({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 5,
      idempotencyKey: 'discord:order:estimate:777777777777777777'
    });

    expect(client.getOrder).toHaveBeenCalledWith(orderId, actor());
    expect(client.estimateOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 5 },
      actor(),
      'discord:order:estimate:777777777777777777'
    );
    expect(client.getCurrentBalance).toHaveBeenCalledWith(actor());
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.body).toContain('预计价格：1,200.0 CAT');
  });

  test('refreshes an already submitted order in place without reopening draft confirmation', async () => {
    const client = api({
      getOrder: vi.fn().mockResolvedValue(draftOrder({ status: 'PENDING_DISPATCH', version: 6 })),
      estimateOrder: vi.fn(),
      getCurrentBalance: vi.fn()
    });
    const result = await handleOpenOrderConfirmation({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 6,
      idempotencyKey: 'discord:order:refresh:submitted'
    });
    expect(result).toMatchObject({ kind: 'EDIT_ORIGINAL_MESSAGE', message: { title: '订单 #P-1042' } });
    expect(result.kind === 'EDIT_ORIGINAL_MESSAGE' && result.message.title).not.toContain('最后确认');
    expect(result.kind === 'EDIT_ORIGINAL_MESSAGE' && JSON.stringify(result.message.components)).not.toContain('submit-final');
    expect(client.estimateOrder).not.toHaveBeenCalled();
    expect(client.getCurrentBalance).not.toHaveBeenCalled();
  });

  test('refreshes the draft panel when expectedVersion is stale instead of submitting stale data', async () => {
    const refreshed = draftOrder({ version: 6, notes: '已刷新' });
    const client = api({
      estimateOrder: vi.fn().mockRejectedValue(
        new BotApiError({
          code: 'CONFLICT',
          message: 'Order version is stale.',
          requestId: 'req-stale',
          statusCode: 409
        })
      ),
      getOrder: vi.fn().mockResolvedValue(refreshed)
    });

    const result = await handleOpenOrderConfirmation({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 5,
      idempotencyKey: 'discord:order:estimate:stale'
    });

    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.title).toContain('第 1/4 步');
    expect(result.notice).toBe('订单刚刚有了新变化，我们已经为你刷新到最新内容。request_id: req-stale');
  });

  test('routes confirmation custom id with only order id, action and expected version metadata', () => {
    expect(parseServiceCenterCustomId(`bc:order:${orderId}:submit:v5`)).toEqual({
      area: 'order-action',
      orderId,
      action: 'submit',
      expectedVersion: 5
    });
  });

  test('refreshes from latest API facts through a version-independent read-only route', async () => {
    const latest = draftOrder({ status: 'PENDING_DISPATCH', version: 9 });
    const client = api({ getOrder: vi.fn().mockResolvedValue(latest) });

    expect(parseServiceCenterCustomId(`bc:order:${orderId}:refresh`)).toEqual({
      area: 'order-refresh',
      orderId
    });
    const result = await handleOrderRefresh({ api: client, actor: actor(), orderId });

    expect(client.getOrder).toHaveBeenCalledWith(orderId, actor());
    expect(result).toMatchObject({ kind: 'EDIT_ORIGINAL_MESSAGE' });
    expect(JSON.stringify(result.kind === 'EDIT_ORIGINAL_MESSAGE' ? result.message : null))
      .toContain(`bc:order:${orderId}:refresh`);
    expect(JSON.stringify(result)).not.toContain(`bc:order:${orderId}:refresh:v`);
  });

  test('restores the customer wait-time selector before a pending order has opened its selection pool', async () => {
    const latest = draftOrder({
      status: 'PENDING_DISPATCH',
      version: 9,
      matching: {
        stage: 'SEARCHING',
        notifiedCandidateCount: 0,
        requestedPlayerCount: 1,
        filledPlayerCount: 0,
        timeoutAt: null,
        nextStep: 'WAIT_FOR_PLAYER',
        playerSummary: null
      }
    });
    const result = await handleOrderRefresh({
      api: api({ getOrder: vi.fn().mockResolvedValue(latest) }),
      actor: actor(),
      orderId
    });
    const rendered = JSON.stringify(result);

    expect(rendered).toContain(`bc:sp:new:${orderId}:o9`);
    expect(rendered).toContain('选择等待时间');
    for (const minutes of [1, 3, 5, 10, 15, 30]) expect(rendered).toContain(`等待 ${minutes} 分钟`);
    expect(rendered).not.toContain('已通知符合条件的陪玩：0 人');
  });

  test('does not offer a duplicate selection pool while the current round is collecting applications', async () => {
    const latest = draftOrder({ status: 'PENDING_DISPATCH', version: 9 });
    const result = await handleOrderRefresh({
      api: api({
        getOrder: vi.fn().mockResolvedValue(latest),
        getCurrentSelectionPool: vi.fn().mockResolvedValue({
          pool: {
            id: '00000000-0000-0000-0000-000000110001',
            orderId,
            round: 2,
            status: 'COLLECTING',
            version: 4,
            waitMinutes: 10,
            openedAt: '2026-08-07T19:30:00.000Z',
            closesAt: '2026-08-07T19:40:00.000Z',
            applicationCount: 3
          }
        })
      }),
      actor: actor(),
      orderId
    });
    const rendered = JSON.stringify(result);

    expect(rendered).toContain('报名进行中');
    expect(rendered).toContain('当前报名：3 人');
    expect(rendered).toContain('提前结束报名');
    expect(rendered).not.toContain(`bc:sp:new:${orderId}`);
  });

  test.each([
    ['ACCEPTED', 'bc:service:ready:'],
    ['IN_SERVICE', 'bc:service:request-completion:'],
    ['PENDING_CONFIRMATION', 'bc:service:confirm:']
  ])('rebuilds the latest %s status with its valid primary action', async (status, expectedAction) => {
    const latest = draftOrder({ status, version: 11, matching: null });
    const result = await handleOrderRefresh({
      api: api({ getOrder: vi.fn().mockResolvedValue(latest) }),
      actor: actor(),
      orderId
    });

    expect(JSON.stringify(result)).toContain(`${expectedAction}${orderId}:v11`);
  });

  test('preserves participant status actions when owner-only requirement details are not visible', async () => {
    const latest = draftOrder({
      status: 'ACCEPTED',
      version: 11,
      game: null,
      service: null,
      billingUnitMinutes: null,
      unitCount: null,
      matching: null
    });
    const client = api({
      getOrder: vi.fn().mockResolvedValue(latest),
      listOrderRequirements: vi.fn().mockRejectedValue(
        new BotApiError({
          code: 'PERMISSION_DENIED',
          message: 'Only the order owner can list requirements.',
          requestId: 'req-player-refresh',
          statusCode: 403
        })
      )
    });

    const result = await handleOrderRefresh({ api: client, actor: actor(), orderId });

    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(JSON.stringify(result)).toContain(`bc:service:ready:${orderId}:v11`);
  });

  test('keeps authoritative requirement details when a cancelled multi-project order is refreshed repeatedly', async () => {
    const latest = draftOrder({
      status: 'CANCELLED',
      version: 12,
      game: null,
      service: null,
      region: null,
      billingUnitMinutes: null,
      unitCount: null,
      compositionMode: 'CUSTOMIZED'
    });
    const requirements = {
      orderId,
      orderVersion: 12,
      catalogSubtotalMinor: 2_000,
      packageAdjustmentMinor: 0,
      derivedTotalMinor: 2_000,
      currency: 'CAT' as const,
      items: [
        {
          id: '00000000-0000-0000-0000-00000000d001',
          orderId,
          sourcePackageSlotId: null,
          serviceCatalogVersionId: '00000000-0000-0000-0000-00000000c001',
          game: 'VALORANT',
          gameDisplayName: '瓦洛兰特',
          service: 'ENTERTAINMENT',
          serviceDisplayName: '娱乐陪玩',
          region: 'NA',
          regionDisplayName: '北美',
          billingUnitMinutes: 60,
          unitCount: 2,
          requestedPlayerCount: 1,
          customerUnitPriceMinor: 1_000,
          estimatedLinePriceMinor: 2_000,
          filledPlayerCount: 0,
          customerNote: null,
          status: 'ACTIVE' as const,
          version: 1,
          createdAt: '2026-08-05T03:00:00.000Z',
          updatedAt: '2026-08-05T03:00:00.000Z'
        }
      ],
      nextCursor: null
    };
    const client = api({
      getOrder: vi.fn().mockResolvedValue(latest),
      listOrderRequirements: vi.fn().mockResolvedValue(requirements)
    });

    const first = await handleOrderRefresh({ api: client, actor: actor(), orderId });
    const second = await handleOrderRefresh({ api: client, actor: actor(), orderId });

    for (const result of [first, second]) {
      const rendered = JSON.stringify(result);
      expect(rendered).toContain('瓦洛兰特');
      expect(rendered).toContain('娱乐陪玩');
      expect(rendered).toContain('北美');
      expect(rendered).toContain('2 小时');
      expect(rendered).not.toContain('未选择游戏');
      expect(rendered).not.toContain('未选择服务');
      expect(rendered).not.toContain('未选择时长');
    }
    expect(client.listOrderRequirements).toHaveBeenCalledTimes(2);
  });
});

describe('M1-US-07 Bot HTTP estimate client', () => {
  test('calls the reusable estimateOrder endpoint with actor and idempotency headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: estimate() })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token'
    });

    await client.estimateOrder(
      orderId,
      { expectedVersion: 5 },
      actor(),
      'discord:order:estimate:777777777777777777'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/orders/${orderId}/estimate`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 5 }),
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-discord-user-id': customerDiscordUserId,
          'x-actor-guild-id': guildId,
          'x-discord-interaction-id': interactionId,
          'idempotency-key': 'discord:order:estimate:777777777777777777'
        })
      })
    );
  });
});

describe('M1-US-07 Sapphire order confirmation wiring', () => {
  test('wires order submit button to confirmation flow instead of treating it as unknown', async () => {
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8');

    expect(source).toContain('handleOpenOrderConfirmation');
    expect(source).toContain("serviceCenterInteractionKind(route) === 'button'");
    expect(source).toContain('buildDiscordIdempotencyKey');
    expect(source).toContain('await interaction.deferUpdate()');
    expect(source).toContain('await interaction.editReply(toDiscordUpdate(result.message))');
  });
});
