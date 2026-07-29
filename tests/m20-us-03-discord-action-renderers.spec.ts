import { describe, expect, test, vi } from 'vitest';
import { DiscordRestWorkerAdapter } from '@blackcat/api/worker-adapters';
import type { OrderPanelProjection } from '@blackcat/api/worker-runtime';
import {
  buildGameOrderingMenuMessage,
  buildGamePickerMessage,
  buildMultiProjectOrderConfirmationMessage,
  buildMultiProjectOrderPanelMessage,
  buildOrderConfirmationMessage,
  buildPlayerWorkbenchMessage,
  buildServicePackagePickerMessage,
  buildServicePackagePreviewMessage,
  type BalanceSummary,
  type OrderRequirementPageSummary,
  type OrderSummary,
  type PublicServiceSummary,
  type ServicePackagePageSummary,
  type ServicePackagePreviewSummary
} from '@blackcat/bot/service-center';
import { buildServiceLifecyclePanelMessage } from '@blackcat/bot/service-lifecycle-message';
import { buildSelectionCandidateConfirmation, buildSelectionCandidatePanel } from '@blackcat/bot/selection-discord';
import {
  buildCurrentUserConsumptionsMessage,
  buildCurrentUserOrdersMessage,
  buildServiceCenterMessage
} from '@blackcat/bot/service-center-profile';
import type { MessageSpec } from '@blackcat/bot/service-center-components';

const orderId = '00000000-0000-0000-0000-000000003001';
const requirementId = '00000000-0000-0000-0000-000000003002';
const packageId = '00000000-0000-0000-0000-000000003003';

describe('M20-US-03 Discord action renderers', () => {
  test('keeps cancellation visible through every draft ordering screen', () => {
    const order = draftOrder();
    const messages = [
      buildServicePackagePickerMessage(order, packages()),
      buildGamePickerMessage(order, [service()], packages().items),
      buildGameOrderingMenuMessage(order, 'VALORANT', [service()], packages(), service()),
      buildServicePackagePreviewMessage(order, packagePreview()),
      buildMultiProjectOrderPanelMessage(order, requirements(), [service()], requirementId),
      buildMultiProjectOrderConfirmationMessage({ order, requirements: requirements(), balance: balance() }),
      buildOrderConfirmationMessage({
        order: { ...order, game: 'VALORANT', service: 'ENTERTAINMENT', billingUnitMinutes: 60, unitCount: 1 },
        estimate: {
          serviceCatalogId: service().id,
          catalogVersion: 1,
          unitCount: 1,
          billingUnitMinutes: 60,
          amountMinor: 200,
          currency: 'CAT',
          validUntil: '2026-08-10T11:00:00.000Z'
        },
        balance: balance()
      })
    ];

    for (const message of messages) {
      expect(buttons(message).some((button) => button.customId.includes(`bc:order:${orderId}:cancel:`))).toBe(true);
      assertLayout(message);
    }
  });

  test('uses first-use labels and removes ambiguous legacy labels', () => {
    const order = draftOrder({ amountMinor: 200 });
    const rendered = [
      buildGamePickerMessage(order, [service()], packages().items),
      buildGameOrderingMenuMessage(order, 'VALORANT', [service()], packages(), service()),
      buildServicePackagePreviewMessage(order, packagePreview()),
      buildMultiProjectOrderPanelMessage(order, requirements(), [service()], requirementId),
      buildMultiProjectOrderPanelMessage(order, requirements(), [service()]),
      buildMultiProjectOrderConfirmationMessage({ order, requirements: requirements(), balance: balance() })
    ];
    const labels = rendered.flatMap((message) => buttons(message).map((button) => button.label));

    for (const expected of [
      '查看这个游戏',
      '查看套餐内容',
      '加入这个单点服务',
      '把此套餐加入订单',
      '继续添加游戏或服务',
      '查看已选服务',
      '填写这个席位的需求',
      '核对订单与总价',
      '提交订单并预留猫条',
      '刷新最新状态',
      '联系猫舍前台'
    ]) {
      expect(labels).toContain(expected);
    }
    expect(labels).not.toEqual(
      expect.arrayContaining([
        '进入',
        '查看',
        '单点加入',
        '采用套餐',
        '查看清单',
        '查看已点清单',
        '席位偏好',
        '下一步 · 确认订单',
        '确认提交订单',
        '刷新订单',
        '我要申诉'
      ])
    );
  });

  test('separates customer and player lifecycle actions', () => {
    const customer = lifecycle('IN_SERVICE', 'CUSTOMER', [
      customerAction('CUSTOMER_SEND_GIFT', 'SECONDARY'),
      customerAction('CUSTOMER_REQUEST_CANCELLATION', 'DANGER'),
      customerAction('CUSTOMER_REFRESH_ORDER', 'SECONDARY'),
      customerAction('CUSTOMER_CONTACT_SUPPORT', 'SECONDARY')
    ]);
    const player = lifecycle('IN_SERVICE', 'PLAYER', [
      playerAction('PLAYER_OPEN_CURRENT_ORDER', 'SECONDARY'),
      playerAction('PLAYER_REQUEST_COMPLETION', 'PRIMARY'),
      playerAction('PLAYER_REFRESH_WORKBENCH', 'SECONDARY'),
      playerAction('PLAYER_CONTACT_SUPPORT', 'SECONDARY')
    ]);
    const customerButtons = buttons(buildServiceLifecyclePanelMessage(customer));
    const playerButtons = buttons(buildServiceLifecyclePanelMessage(player));

    expect(customerButtons.map((button) => button.label)).toEqual(
      expect.arrayContaining(['申请取消订单', '刷新最新状态', '联系猫舍前台'])
    );
    expect(customerButtons.some((button) => button.customId.includes('request-completion'))).toBe(false);
    expect(playerButtons.map((button) => button.label)).toContain('陪玩：提交服务完成');
    expect(playerButtons.some((button) => button.customId.includes(':cancel:'))).toBe(false);
    assertLayout(buildServiceLifecyclePanelMessage(customer));
    assertLayout(buildServiceLifecyclePanelMessage(player));
  });

  test('keeps cancellation, refresh, and support on candidate and confirmation views', () => {
    const candidate = buildSelectionCandidatePanel({
      orderId,
      poolId: packageId,
      poolVersion: 2,
      orderVersion: 4,
      items: [
        {
          id: requirementId,
          playerId: packageId,
          playerDisplayName: '黑猫一号',
          publicGameTags: ['VALORANT'],
          publicServiceTags: ['娱乐陪玩']
        }
      ],
      nextCursor: null,
      selectedApplicationIds: []
    });
    const confirmation = buildSelectionCandidateConfirmation({
      orderId,
      poolId: packageId,
      poolVersion: 2,
      orderVersion: 4,
      selectedCandidates: [{ id: requirementId, playerDisplayName: '黑猫一号' }]
    });

    for (const message of [candidate, confirmation]) {
      const labels = buttons(message).map((button) => button.label);
      expect(labels).toEqual(expect.arrayContaining(['取消订单', '刷新最新状态', '联系猫舍前台']));
      assertLayout(message);
    }
    expect(buttons(confirmation).map((button) => button.label)).toEqual(
      expect.arrayContaining(['确认这些陪玩', '修改陪玩名单'])
    );
  });

  test('gives the player workbench an open-order action and the current lifecycle action', () => {
    const message = buildPlayerWorkbenchMessage({
      profile: {
        playerId: packageId,
        reviewStatus: 'ACTIVE',
        availability: 'AVAILABLE',
        discordPresence: 'ONLINE',
        gameTags: ['VALORANT'],
        serviceTags: ['ENTERTAINMENT'],
        activeOrderId: orderId,
        version: 1
      },
      eligibility: { eligible: true, evaluatedAt: '2026-08-10T10:00:00.000Z', checks: [] },
      currentOrder: {
        id: orderId,
        publicId: 'P-M20',
        status: 'ACCEPTED',
        version: 4,
        game: 'VALORANT',
        service: 'ENTERTAINMENT',
        region: null,
        durationMinutes: 60,
        playerEarningMinor: 100,
        currency: 'CAT',
        requirements: [],
        voiceChannelId: null
      },
      matchingOrders: [],
      earningsSummary: {
        pendingMinor: 0,
        confirmedMinor: 0,
        paidMinor: 0,
        currency: 'CAT',
        calculatedAt: '2026-08-10T10:00:00.000Z'
      },
      availableActions: [
        playerAction('PLAYER_OPEN_CURRENT_ORDER', 'SECONDARY'),
        playerAction('PLAYER_SET_READINESS', 'PRIMARY'),
        playerAction('PLAYER_REFRESH_WORKBENCH', 'SECONDARY'),
        playerAction('PLAYER_CONTACT_SUPPORT', 'SECONDARY')
      ],
      nextActions: ['SET_READINESS', 'CONTACT_SUPPORT']
    });

    expect(buttons(message).map((button) => button.label)).toEqual(
      expect.arrayContaining(['打开当前订单', '陪玩：我已准备好', '刷新陪玩工作台', '联系猫舍前台'])
    );
    assertLayout(message);
  });

  test.each([
    ['ACCEPTED', '申请取消订单'],
    ['IN_SERVICE', '申请取消订单'],
    ['PENDING_CONFIRMATION', '老板：确认服务完成']
  ] as const)('keeps the persistent customer panel role-safe in %s', async (status, expectedLabel) => {
    const projection: OrderPanelProjection = {
      orderId,
      publicId: 'P-M20',
      status,
      version: 4,
      channelId: '111111111111111111',
      panelMessageId: '222222222222222222',
      customerDiscordUserId: '333333333333333333',
      playerDiscordUserId: null,
      playerDiscordUserIds: [],
      participants: [],
      requestedPlayerCount: 1,
      filledPlayerCount: 0,
      coordinationRequirements: [],
      amountMinor: 200,
      currency: 'CAT'
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: projection.panelMessageId }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );

    await new DiscordRestWorkerAdapter({ token: 'test-token', fetch: fetchMock }).upsertOrderPanel(
      projection,
      '2026-08-10T10:00:00.000Z'
    );

    const payload = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);
    const rendered = JSON.stringify(payload.components);
    const actionLabels = discordButtonLabels(payload.components);
    expect(rendered).toContain(expectedLabel);
    expect(rendered).toContain('联系猫舍前台');
    expect(rendered).toContain('刷新最新状态');
    expect(actionLabels).not.toContain('陪玩确认就绪');
    expect(actionLabels).not.toContain('陪玩申请完成');
  });

  test('keeps service center compact and paginated views bidirectional without disabled noise', () => {
    const center = buildServiceCenterMessage({
      currentUser: { user: { id: packageId, displayName: '老板', status: 'ACTIVE' }, enabledFeatures: [] },
      balance: {
        ledgerBalanceMinor: 1000,
        reservedMinor: 0,
        availableMinor: 1000,
        currency: 'CAT',
        calculatedAt: '2026-08-10T10:00:00.000Z',
        version: 1
      },
      activeOrder: null,
      consumptions: { items: [], nextCursor: null },
      commissions: {
        summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
        items: [],
        nextCursor: null
      }
    });
    expect(buttons(center).some((button) => button.disabled)).toBe(false);
    expect(buttons(center).map((button) => button.label)).not.toContain('📋 当前订单');
    assertLayout(center);

    const orders = buildCurrentUserOrdersMessage(
      { items: [], nextCursor: 'c1_12345678901234567890' },
      { previousCursor: null }
    );
    const consumptions = buildCurrentUserConsumptionsMessage(
      { items: [], nextCursor: 'c1_12345678901234567890' },
      { previousCursor: 'c1_09876543210987654321' }
    );
    expect(buttons(orders).map((button) => button.label)).not.toContain('← 上一页');
    expect(buttons(consumptions).map((button) => button.label)).toEqual(
      expect.arrayContaining(['← 上一页', '下一页 →'])
    );
    expect([...buttons(orders), ...buttons(consumptions)].some((button) => button.disabled)).toBe(false);
  });
});

function assertLayout(message: MessageSpec): void {
  expect(buttons(message).filter((button) => button.style === 'PRIMARY').length).toBeLessThanOrEqual(1);
  for (const component of message.components) {
    if (component.type === 'ACTION_ROW') {
      expect(component.components.filter((item) => item.type === 'BUTTON').length).toBeLessThanOrEqual(3);
    }
  }
}

function buttons(message: MessageSpec): Array<{
  label: string;
  customId: string;
  style: string;
  disabled?: boolean;
}> {
  return message.components.flatMap((component) => {
    if (component.type === 'V2_SECTION') return [component.accessory];
    if (component.type !== 'ACTION_ROW') return [];
    return component.components.filter((item) => item.type === 'BUTTON');
  });
}

function discordButtonLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(discordButtonLabels);
  if (!value || typeof value !== 'object') return [];
  const component = value as { type?: unknown; label?: unknown; components?: unknown };
  return [
    ...(component.type === 2 && typeof component.label === 'string' ? [component.label] : []),
    ...discordButtonLabels(component.components)
  ];
}

function draftOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-M20',
    status: 'DRAFT',
    version: 4,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    amountMinor: 0,
    currency: 'CAT',
    notes: null,
    channelSpec: {
      channelId: '111111111111111111',
      panelMessageId: '222222222222222222',
      voiceChannelId: null
    },
    matching: null,
    availableActions: [
      customerAction('CUSTOMER_CONTINUE_ORDER', 'PRIMARY'),
      customerAction('CUSTOMER_CANCEL_ORDER', 'DANGER'),
      customerAction('CUSTOMER_REFRESH_ORDER', 'SECONDARY'),
      customerAction('CUSTOMER_CONTACT_SUPPORT', 'SECONDARY')
    ],
    ...overrides
  };
}

function service(): PublicServiceSummary {
  return {
    id: '00000000-0000-0000-0000-000000003004',
    game: 'VALORANT',
    gameDisplayName: '瓦洛兰特',
    service: 'ENTERTAINMENT',
    serviceDisplayName: '娱乐陪玩',
    region: null,
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: 200,
    currency: 'CAT',
    version: 1
  };
}

function packages(): ServicePackagePageSummary {
  return {
    items: [packagePreview()],
    nextCursor: null
  };
}

function packagePreview(): ServicePackagePreviewSummary {
  return {
    id: packageId,
    code: 'VAL-DUO',
    version: 1,
    game: 'VALORANT',
    gameDisplayName: '瓦洛兰特',
    displayName: '双人开黑套餐',
    description: '一起轻松上分',
    defaultCustomerPriceMinor: 200,
    derivedTotalMinor: 200,
    currency: 'CAT',
    slots: [
      {
        id: requirementId,
        position: 1,
        serviceCatalogVersionId: service().id,
        gameDisplayName: '瓦洛兰特',
        serviceDisplayName: '娱乐陪玩',
        regionDisplayName: null,
        billingUnitMinutes: 60,
        unitCount: 1,
        customerNoteTemplate: null
      }
    ]
  };
}

function requirements(): OrderRequirementPageSummary {
  return {
    orderId,
    orderVersion: 4,
    catalogSubtotalMinor: 200,
    packageAdjustmentMinor: 0,
    derivedTotalMinor: 200,
    currency: 'CAT',
    items: [
      {
        id: requirementId,
        orderId,
        serviceCatalogVersionId: service().id,
        game: 'VALORANT',
        gameDisplayName: '瓦洛兰特',
        service: 'ENTERTAINMENT',
        serviceDisplayName: '娱乐陪玩',
        region: null,
        regionDisplayName: null,
        billingUnitMinutes: 60,
        unitCount: 1,
        requestedPlayerCount: 1,
        customerUnitPriceMinor: 200,
        estimatedLinePriceMinor: 200,
        filledPlayerCount: 0,
        status: 'ACTIVE',
        version: 1,
        createdAt: '2026-08-10T10:00:00.000Z',
        updatedAt: '2026-08-10T10:00:00.000Z'
      }
    ],
    nextCursor: null
  };
}

function balance(): BalanceSummary {
  return {
    ledgerBalanceMinor: 1000,
    reservedMinor: 0,
    availableMinor: 1000,
    currency: 'CAT',
    calculatedAt: '2026-08-10T10:00:00.000Z',
    version: 1
  };
}

function lifecycle(
  status: 'ACCEPTED' | 'IN_SERVICE' | 'PENDING_CONFIRMATION',
  actorRole: 'CUSTOMER' | 'PLAYER',
  availableActions: Array<ReturnType<typeof customerAction> | ReturnType<typeof playerAction>>
) {
  return {
    orderId,
    publicId: 'P-M20',
    status,
    version: 4,
    actorRole,
    enabledFeatures: ['CORE_ORDER', 'GIFTS'] as const,
    availableActions,
    readiness: {
      participants: [
        {
          participantId: requirementId,
          playerId: packageId,
          displayName: '黑猫一号',
          readiness: 'READY' as const
        }
      ],
      allActivePlayersReady: true,
      readyDeadlineAt: null,
      startedAt: '2026-08-10T10:00:00.000Z',
      staffTaskId: null
    }
  };
}

function customerAction(key: string, risk: 'PRIMARY' | 'SECONDARY' | 'DANGER') {
  return { key, role: 'CUSTOMER' as const, enabled: true, risk, reasonCode: null };
}

function playerAction(key: string, risk: 'PRIMARY' | 'SECONDARY' | 'DANGER') {
  return { key, role: 'PLAYER' as const, enabled: true, risk, reasonCode: null };
}
