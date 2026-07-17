import { createHash } from 'node:crypto';
import { BOT_COPY, botCopy } from './bot-copy.js';
import { formatUserFacingError } from './user-facing-error.js';
import {
  BotApiError,
  type BalanceSummary,
  type BotActorContext,
  type BotApiClient,
  type CancellationPreviewSummary,
  type CancellationResultSummary,
  type DispatchOfferSummary,
  type OrderEstimateSummary,
  type OrderChannelSpec,
  type OrderLifecyclePanelSummary,
  type OrderRequirementMutationSummary,
  type OrderRequirementPageSummary,
  type OrderRequirementSummary,
  type OrderReservationSummaryResult,
  type OrderSummary,
  type PlayerWorkbenchSummary,
  type PublicServiceSummary,
  type ServicePackagePageSummary,
  type ServicePackagePreviewSummary,
  type ServicePackageSummary,
  type SelectionPoolSummary
} from './service-center-api.js';
import type {
  AcceptedPlayerChannelPermissionPlan,
  ActionRowSpec,
  BotFlowResult,
  ComponentSpec,
  MessageComponentSpec,
  MessageSpec,
  ModalSpec,
  PermissionName,
  PermissionOverwriteSpec,
  PrivateOrderChannelPlan
} from './service-center-components.js';
import { buildServiceCenterMessage } from './service-center-profile.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, formatCustomerWalletAmount } from './wallet-display.js';
import { buildSelectionPoolRefreshMessage } from './selection-discord.js';

export * from './service-center-api.js';
export * from './service-center-components.js';
export * from './service-center-profile.js';
export * from './service-center-routes.js';

const dispatchEligibilityReasonLabels: Record<string, string> = {
  ACTIVE_REVIEW_STATUS: '陪玩资格当前不是可接单状态',
  MATCHING_TAGS: '本轮游戏或服务项目不在你的已认证范围内',
  DISCORD_ONLINE: 'Discord 当前未在线',
  AVAILABLE: '旧 availability 仅供诊断，不影响候选池报名',
  NO_ACTIVE_ORDER: '已有进行中的订单'
};

export function buildDispatchIneligibleReply(workbench: PlayerWorkbenchSummary, requestId: string): string {
  const reasons = workbench.eligibility.checks
    .filter((check) => !check.passed)
    .map((check) => dispatchEligibilityReasonLabels[check.code] ?? check.code);
  return botCopy.dispatch.ineligible(reasons, requestId);
}

export function buildPublicServiceEntryMessage(): MessageSpec {
  return {
    title: '🐈‍⬛ 陪玩服务中心',
    body: BOT_COPY.orders.publicEntryIntroduction,
    visibility: 'PUBLIC',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: 'bc:entry:create-order',
            label: '🐾 创建订单'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:entry:service-center',
            label: '🐈‍⬛ 我的服务中心'
          }
        ]
      }
    ]
  };
}

export function buildOrderNotesModal(input: { orderId: string; expectedVersion: number }): ModalSpec {
  return {
    title: '📝 补充订单备注',
    customId: `bc:modal:order-notes:${input.orderId}:v${input.expectedVersion}`,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'notes',
        label: '补充备注（可选）',
        style: 'PARAGRAPH',
        required: false,
        maxLength: 500
      }
    ]
  };
}

export function buildRequirementNoteModal(input: {
  orderId: string;
  requirementId: string;
  expectedVersion: number;
  expectedRequirementVersion: number;
}): ModalSpec {
  return {
    title: '🐾 这个席位希望怎样陪你',
    customId: `bc:rnm:${input.orderId}:${input.requirementId}:v${input.expectedVersion}:r${input.expectedRequirementVersion}`,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'requirement-note',
        label: '例如：技术要求不高，会聊天就行',
        style: 'PARAGRAPH',
        required: false,
        maxLength: 500
      }
    ]
  };
}

export function buildPrivateOrderChannelPlan(input: {
  guildId: string;
  orderPublicId: string;
  customerDiscordUserId: string;
  botUserId: string;
  staffRoleIds: string[];
  playerRoleId?: string | null;
}): PrivateOrderChannelPlan {
  const overwrites: PermissionOverwriteSpec[] = [
    { id: input.guildId, kind: 'ROLE', allow: [], deny: ['VIEW_CHANNEL'] },
    {
      id: input.customerDiscordUserId,
      kind: 'MEMBER',
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
      deny: ['MANAGE_CHANNELS']
    },
    {
      id: input.botUserId,
      kind: 'MEMBER',
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'],
      deny: []
    },
    ...input.staffRoleIds.map((roleId) => ({
      id: roleId,
      kind: 'ROLE' as const,
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'] as PermissionName[],
      deny: []
    }))
  ];

  if (input.playerRoleId) {
    overwrites.push({
      id: input.playerRoleId,
      kind: 'ROLE',
      allow: [],
      deny: ['VIEW_CHANNEL']
    });
  }

  return {
    name: `订单-${input.orderPublicId.toLowerCase()}`,
    pinPanel: true,
    permissionOverwrites: overwrites
  };
}

export function buildAcceptedPlayerChannelPermissionPlan(input: {
  channelId: string;
  acceptedPlayerDiscordUserId: string;
  rejectedCandidateDiscordUserIds: string[];
}): AcceptedPlayerChannelPermissionPlan {
  return {
    channelId: input.channelId,
    permissionOverwrites: [
      {
        id: input.acceptedPlayerDiscordUserId,
        kind: 'MEMBER',
        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
        deny: []
      }
    ]
  };
}

export function buildOrderPanelMessage(
  order: OrderSummary,
  services: PublicServiceSummary[] = [],
  requirements?: OrderRequirementPageSummary
): MessageSpec {
  if (order.automation?.state === 'PAUSED') {
    return buildPausedAutomationMessage(order);
  }
  if (order.status === 'DRAFT') {
    return buildGamePickerMessage(order, services);
  }
  if ((order.status === 'PENDING_DISPATCH' || order.status === 'ACCEPTED') && order.matching) {
    return buildMatchingProgressMessage(order);
  }
  const title = `订单 #${order.publicId}`;
  const selectedService = services.find((service) => service.id === order.serviceCatalogId);
  const activeRequirements = requirements?.items.filter((item) => item.status === 'ACTIVE') ?? [];
  const selectionLines = activeRequirements.length
    ? activeRequirements.flatMap((requirement, index) => [
        `${activeRequirements.length > 1 ? `${index + 1}. ` : ''}${requirement.gameDisplayName} · ${requirement.serviceDisplayName}`,
        `${requirement.regionDisplayName ?? '无指定区服'} · ${formatRequirementDuration(requirement)} × ${requirement.requestedPlayerCount} 位`
      ])
    : [
        `${selectedService?.gameDisplayName ?? order.gameDisplayName ?? formatGame(order.game)} · ${selectedService?.serviceDisplayName ?? order.serviceDisplayName ?? formatService(order.service)}`,
        `${selectedService?.regionDisplayName ?? order.regionDisplayName ?? formatRegion(order.region)} · ${formatDuration(order)}`
      ];
  const body = [
    ...selectionLines,
    `订单金额：${formatCustomerMoney(order.amountMinor, order.currency)}`,
    `当前状态：${order.status}`
  ].join('\n');

  return {
    title,
    body,
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: orderStatusControls(order.id, order.version, order.status)
      }
    ]
  };
}

export function buildMultiProjectOrderPanelMessage(
  order: OrderSummary,
  page: OrderRequirementPageSummary,
  services: PublicServiceSummary[],
  selectedRequirementId?: string,
  cursor?: string
): MessageSpec {
  const requirements = page.items.filter((item) => item.status === 'ACTIVE');
  const selected = requirements.find((item) => item.id === selectedRequirementId);
  const groups = [...new Map(requirements.map((item) => [item.game, item.gameDisplayName])).entries()];
  const lines = groups.length
    ? groups
        .map(([game, gameName]) => {
          const items = requirements.filter((item) => item.game === game);
          return [
            `### ${gameName} · ${items.reduce((sum, item) => sum + item.requestedPlayerCount, 0)} 位陪玩`,
            items
              .map((item, index) =>
                [
                  `**${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName} · ${item.regionDisplayName ?? '不限区服'}**`,
                  `${formatRequirementDuration(item)} × ${item.requestedPlayerCount} 位 · ${formatCustomerMoney(item.estimatedLinePriceMinor, page.currency)}`,
                  item.customerNote ? `偏好：${item.customerNote}` : '偏好：未填写',
                  item.sourcePackageSlotId ? '来源：套餐席位' : '来源：单点'
                ].join('\n')
              )
              .join('\n\n')
          ].join('\n\n');
        })
        .join('\n\n')
    : '清单还是空的。请先选择游戏，再从对应菜单加入套餐或单点项目。';
  const components: ActionRowSpec[] = selected
    ? [
        {
          type: 'ACTION_ROW',
          components: [
            select(
              `bc:req:${order.id}:edit:${cursor ?? 'first'}:v${page.orderVersion}`,
              '选择要修改的项目',
              requirementOptions(requirements),
              requirements.length === 0
            )
          ]
        }
      ]
    : [
        {
          type: 'ACTION_ROW',
          components: [
            select(
              `bc:req:${order.id}:edit:${cursor ?? 'first'}:v${page.orderVersion}`,
              '选择要修改的项目',
              requirementOptions(requirements),
              requirements.length === 0
            )
          ]
        }
      ];
  if (selected) {
    components.push(
      {
        type: 'ACTION_ROW',
        components: [
          select(
            `bc:req:${order.id}:${selected.id}:project:v${page.orderVersion}:r${selected.version}`,
            `项目：${selected.gameDisplayName} · ${selected.serviceDisplayName}`,
            serviceOptions(
              order,
              services.filter((service) => service.game === selected.game)
            )
          )
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          select(
            `bc:req:${order.id}:${selected.id}:units:v${page.orderVersion}:r${selected.version}`,
            `时长：${formatRequirementDuration(selected)}`,
            integerOptions(1, 12, selected.unitCount, (value) => `${(value * selected.billingUnitMinutes) / 60} 小时`)
          )
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          select(
            `bc:req:${order.id}:${selected.id}:players:v${page.orderVersion}:r${selected.version}`,
            `需要 ${selected.requestedPlayerCount} 位陪玩`,
            integerOptions(1, 10, selected.requestedPlayerCount, (value) => `${value} 位陪玩`)
          )
        ]
      }
    );
  } else if (cursor || page.nextCursor) {
    components.push({
      type: 'ACTION_ROW',
      components: [
        ...(cursor
          ? [
              {
                type: 'BUTTON' as const,
                style: 'SECONDARY' as const,
                customId: `bc:req:${order.id}:page:first:v${page.orderVersion}`,
                label: '返回首页'
              }
            ]
          : []),
        ...(page.nextCursor
          ? [
              {
                type: 'BUTTON' as const,
                style: 'SECONDARY' as const,
                customId: `bc:req:${order.id}:page:${page.nextCursor}:v${page.orderVersion}`,
                label: '下一页'
              }
            ]
          : [])
      ]
    });
  }
  components.push({
    type: 'ACTION_ROW',
    components: selected
      ? [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:rno:${order.id}:${selected.id}:v${page.orderVersion}:r${selected.version}`,
            label: '席位偏好'
          },
          {
            type: 'BUTTON',
            style: 'DANGER',
            customId: `bc:req:${order.id}:${selected.id}:remove:v${page.orderVersion}:r${selected.version}`,
            label: '删除此项目'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:req:${order.id}:back:v${page.orderVersion}`,
            label: '返回清单'
          },
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${order.id}:submit:v${page.orderVersion}`,
            label: '下一步 · 确认订单'
          },
          refreshOrderControl(order.id)
        ]
      : [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:package:${order.id}:open:v${page.orderVersion}`,
            label: '＋ 添加其他游戏或单点'
          },
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${order.id}:submit:v${page.orderVersion}`,
            label: '下一步 · 确认订单',
            disabled: requirements.length === 0
          },
          refreshOrderControl(order.id)
        ]
  });

  return {
    title: `📋 订单 ${order.publicId} · 第 3/4 步 · 检查陪玩清单`,
    body: [
      '▓▓▓░',
      '套餐只是快捷配菜：每个席位仍是独立项目，可以替换同游戏服务、修改时长或偏好。',
      order.compositionMode === 'PACKAGE_DEFAULT'
        ? '当前构成：套餐默认阵容'
        : order.compositionMode === 'CUSTOMIZED'
          ? '当前构成：已自定义阵容'
          : null,
      lines,
      (page.packageAdjustmentMinor ?? 0) !== 0
        ? `目录小计：${formatCustomerMoney(page.catalogSubtotalMinor ?? page.derivedTotalMinor, page.currency)}\n套餐调整：${formatCustomerMoney(page.packageAdjustmentMinor ?? 0, page.currency)}`
        : null,
      `合计：${formatCustomerMoney(page.derivedTotalMinor, page.currency)}`,
      `共需 ${requirements.reduce((sum, item) => sum + item.requestedPlayerCount, 0)} 位陪玩`
    ]
      .filter(Boolean)
      .join('\n\n'),
    visibility: 'PRIVATE_CHANNEL',
    components,
    layout: 'COMPONENTS_V2'
  };
}

export function buildServicePackagePickerMessage(order: OrderSummary, page: ServicePackagePageSummary): MessageSpec {
  return {
    title: `🎮 订单 #${order.publicId} · 选择套餐`,
    body: [
      '套餐会先展开成独立陪玩席位，应用后每个席位都能单独修改。',
      page.items.length ? '请选择一个套餐查看默认阵容和服务端报价。' : '目前没有可用套餐，你仍可返回自由搭配。'
    ].join('\n\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      ...(page.items.length
        ? [
            {
              type: 'ACTION_ROW' as const,
              components: [
                select(
                  `bc:package:${order.id}:select:v${order.version}`,
                  '选择一个套餐',
                  page.items.slice(0, 25).map((item) => ({
                    label: item.displayName,
                    value: item.id,
                    description: `${item.slots.length} 个席位 · ${item.description}`.slice(0, 100)
                  }))
                )
              ]
            }
          ]
        : []),
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:package:${order.id}:back:v${order.version}`,
            label: '返回自由搭配'
          },
          refreshOrderControl(order.id)
        ]
      }
    ]
  };
}

export function buildGamePickerMessage(
  order: OrderSummary,
  services: PublicServiceSummary[],
  packages: ServicePackageSummary[] = []
): MessageSpec {
  const games = [...new Map(services.map((item) => [item.game, item.gameDisplayName ?? item.game])).entries()].slice(
    0,
    20
  );
  const components: MessageComponentSpec[] = games.map(([game, name]) => ({
    type: 'V2_SECTION',
    content: `### ${name}  \`${game}\`\n${services.filter((item) => item.game === game).length} 个单点 · ${packages.filter((item) => item.game === game).length} 个套餐；进入后只显示本游戏目录。`,
    accessory: {
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:game:${order.id}:${game}:open:v${order.version}`,
      label: '进入'
    }
  }));
  if (order.amountMinor > 0)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:package:${order.id}:back:v${order.version}`,
          label: '查看已点清单'
        }
      ]
    });
  components.push({
    type: 'ACTION_ROW',
    components: [refreshOrderControl(order.id)]
  });
  return {
    title: `🎮 订单 ${order.publicId} · 第 1/4 步 · 选择游戏`,
    body: games.length
      ? '▓░░░\n像翻开一张菜单：请选择右侧“进入”，下一页只会显示这个游戏的套餐和单点。'
      : '今天暂时没有可下单的游戏项目。',
    visibility: 'PRIVATE_CHANNEL',
    components,
    layout: 'COMPONENTS_V2'
  };
}

export function buildGameOrderingMenuMessage(
  order: OrderSummary,
  game: string,
  services: PublicServiceSummary[],
  packages: ServicePackagePageSummary,
  selectedService?: PublicServiceSummary
): MessageSpec {
  const gameName = services[0]?.gameDisplayName ?? packages.items[0]?.gameDisplayName ?? game;
  const components: MessageComponentSpec[] = packages.items.slice(0, 20).map((item) => ({
    type: 'V2_SECTION',
    content: `### ${item.displayName}\n${item.description}\n**${item.defaultCustomerPriceMinor === null ? '由目录实时计价' : formatCustomerMoney(item.defaultCustomerPriceMinor, item.currency)}** · ${item.slots.length} 个席位`,
    accessory: {
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:package:${order.id}:${item.id}:preview:v${order.version}`,
      label: '查看'
    }
  }));
  if (selectedService)
    components.push({
      type: 'V2_TEXT',
      content: `### 单点陪玩项目\n**${gameName} · ${selectedService.serviceDisplayName ?? selectedService.service}**\n${selectedService.regionDisplayName ?? selectedService.region ?? '不限区服'} · ${selectedService.billingUnitMinutes} 分钟 · 1 位陪玩\n**${formatCustomerMoney(selectedService.customerUnitPriceMinor, selectedService.currency)}**`
    });
  if (services.length)
    components.push({
      type: 'ACTION_ROW',
      components: [
        select(`bc:req:${order.id}:preview:v${order.version}`, '选择一个单点陪玩项目', serviceOptions(order, services))
      ]
    });
  if (selectedService)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'PRIMARY',
          customId: `bc:req:${order.id}:${selectedService.id}:add:v${order.version}`,
          label: '单点加入'
        }
      ]
    });
  components.push({
    type: 'ACTION_ROW',
    components: [
      {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:package:${order.id}:open:v${order.version}`,
        label: '换一个游戏'
      },
      ...(order.amountMinor > 0
        ? [
            {
              type: 'BUTTON' as const,
              style: 'PRIMARY' as const,
              customId: `bc:package:${order.id}:back:v${order.version}`,
              label: '查看清单'
            }
          ]
        : []),
      refreshOrderControl(order.id)
    ]
  });
  return {
    title: `🐾 订单 ${order.publicId} · 第 2/4 步 · ${gameName} 菜单`,
    body: [
      `▓▓░░\n当前游戏 · ${gameName}\u3000套餐 ${packages.items.length}\u3000单点 ${services.length}`,
      '套餐使用右侧按钮预览；单点项目先选择预览，再按“单点加入”。所有选项都只来自当前游戏。'
    ].join('\n\n'),
    visibility: 'PRIVATE_CHANNEL',
    components,
    layout: 'COMPONENTS_V2'
  };
}

export function buildServicePackagePreviewMessage(order: OrderSummary, pkg: ServicePackagePreviewSummary): MessageSpec {
  const slots = pkg.slots
    .map(
      (slot) =>
        `**${slot.position}号位 · ${slot.gameDisplayName} · ${slot.serviceDisplayName}**${slot.regionDisplayName ? ` · ${slot.regionDisplayName}` : ''}\n${(slot.unitCount * slot.billingUnitMinutes) / 60} 小时${slot.customerNoteTemplate ? ` · ${slot.customerNoteTemplate}` : ''}`
    )
    .join('\n\n');
  return {
    title: `🐾 订单 ${order.publicId} · 第 2/4 步 · ${pkg.displayName} 套餐预览`,
    body: [
      '▓▓░░',
      pkg.description,
      slots,
      `套餐报价：${formatCustomerMoney(pkg.derivedTotalMinor, pkg.currency)}`,
      '采用后每个席位都能单独调整；修改套餐席位后，API 会按最终阵容重新报价。'
    ].join('\n\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:package:${order.id}:${pkg.id}:apply:v${order.version}`,
            label: '采用套餐'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:game:${order.id}:${pkg.game}:open:v${order.version}`,
            label: '返回游戏菜单'
          },
          ...(order.amountMinor > 0
            ? [
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: `bc:package:${order.id}:back:v${order.version}`,
                  label: '查看清单'
                }
              ]
            : []),
          refreshOrderControl(order.id)
        ]
      }
    ],
    layout: 'COMPONENTS_V2'
  };
}

export async function handleServicePackageSelect(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  servicePackageVersionId: string;
}): Promise<BotFlowResult> {
  const api = requirePackageApi(input.api);
  const [order, pkg] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    api.preview(input.servicePackageVersionId, input.actor)
  ]);
  if (order.status !== 'DRAFT')
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(order)
    };
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildServicePackagePreviewMessage(order, pkg)
  };
}

export async function handleGameMenuSelect(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  game: string;
}): Promise<BotFlowResult> {
  const api = requirePackageApi(input.api);
  const [order, services, packages] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    input.api.listServices(input.actor, input.game),
    api.list(input.actor, undefined, 25, input.game)
  ]);
  if (order.status !== 'DRAFT')
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(order)
    };
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildGameOrderingMenuMessage(order, input.game, services.items, packages)
  };
}

export async function handleServicePackageAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  action: 'open' | 'back' | 'preview' | 'apply';
  servicePackageVersionId?: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const api = requirePackageApi(input.api);
  if (input.action === 'open') {
    const [order, services, packages] = await Promise.all([
      input.api.getOrder(input.orderId, input.actor),
      input.api.listServices(input.actor),
      api.list(input.actor, undefined, 25)
    ]);
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildGamePickerMessage(order, services.items, packages.items)
    };
  }
  if (input.action === 'preview') {
    if (!input.servicePackageVersionId) throw new Error('Package version is required.');
    return handleServicePackageSelect({
      ...input,
      servicePackageVersionId: input.servicePackageVersionId
    });
  }
  if (input.action === 'apply') {
    if (!input.servicePackageVersionId) throw new Error('Package version is required.');
    await api.apply(
      input.orderId,
      {
        expectedOrderVersion: input.expectedVersion,
        servicePackageVersionId: input.servicePackageVersionId
      },
      input.actor,
      input.idempotencyKey
    );
  }
  if (!input.api.listOrderRequirements) throw new Error('Order requirement API is unavailable.');
  const [order, requirements, services] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10),
    input.api.listServices(input.actor)
  ]);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(order, requirements, services.items)
  };
}

function buildPausedAutomationMessage(order: OrderSummary): MessageSpec {
  return {
    title: `🛎️ 订单 #${order.publicId} · 客服处理中`,
    body: [
      BOT_COPY.orders.reviewPaused,
      BOT_COPY.orders.reviewInProgress,
      order.automation?.expiresAt ? botCopy.orders.reviewExpectedAt(order.automation.expiresAt) : null
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:service:support:${order.id}:v${order.version}`,
            label: '我要申诉'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${order.id}:cancel:v${order.version}`,
            label: '查看取消影响'
          },
          refreshOrderControl(order.id)
        ]
      }
    ]
  };
}

export function buildMatchingProgressMessage(order: OrderSummary): MessageSpec {
  const matching = order.matching;
  if (!matching) {
    return {
      title: `📋 订单 #${order.publicId}`,
      body: BOT_COPY.orders.matchingUnavailable,
      visibility: 'PRIVATE_CHANNEL',
      components: [{ type: 'ACTION_ROW', components: orderStatusControls(order.id, order.version, order.status) }]
    };
  }
  if (matching.stage === 'ACCEPTED') {
    return {
      title: `✅ 订单 #${order.publicId} · 已匹配`,
      body: [`接单陪玩：${matching.playerSummary?.displayName ?? '已接单陪玩'}`, '下一步：请确认已准备好开始服务'].join(
        '\n'
      ),
      visibility: 'PRIVATE_CHANNEL',
      components: [{ type: 'ACTION_ROW', components: orderStatusControls(order.id, order.version, order.status) }]
    };
  }
  const nextStep =
    matching.nextStep === 'CHOOSE_CONTINUE_OR_CANCEL'
      ? '下一步：继续等待、取消订单或联系客服'
      : '下一步：请等待陪玩接单';
  const hasAssemblyProgress =
    Number.isSafeInteger(matching.requestedPlayerCount) &&
    Number.isSafeInteger(matching.filledPlayerCount) &&
    Number(matching.requestedPlayerCount) > 0;
  const remainingPlayerCount = hasAssemblyProgress
    ? Math.max(0, Number(matching.requestedPlayerCount) - Number(matching.filledPlayerCount))
    : null;
  return {
    title: `🔎 订单 #${order.publicId} · ${matching.stage === 'TIMED_OUT' ? '本轮匹配结束' : '正在匹配陪玩'}`,
    body: [
      `已通知符合条件的陪玩：${matching.notifiedCandidateCount} 人`,
      hasAssemblyProgress ? `陪玩到位：${matching.filledPlayerCount}/${matching.requestedPlayerCount}` : null,
      remainingPlayerCount && remainingPlayerCount > 0
        ? `还差 ${remainingPlayerCount} 位，全部到齐后开放准备确认`
        : null,
      matching.timeoutAt ? `本轮截止：${matching.timeoutAt}` : null,
      nextStep
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: orderMenuControls(order.id, order.version)
      }
    ]
  };
}

export function buildCancellationPreviewMessage(preview: CancellationPreviewSummary): MessageSpec {
  const handling = preview.staffTaskRequired
    ? '处理方式：提交客服核对，不会自动退款或扣款'
    : '处理方式：确认后立即处理';
  return {
    title: '⚠️ 取消影响确认',
    body: [
      `释放预留：${formatCustomerMoney(preview.releaseAmountMinor, preview.currency)}`,
      `退款：${formatCustomerMoney(preview.refundAmountMinor, preview.currency)}`,
      handling,
      `预览有效期：${preview.validUntil}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: preview.staffTaskRequired ? 'SECONDARY' : 'DANGER',
            customId: `bc:cancel:${preview.orderId}:${preview.previewId}:confirm:v${preview.orderVersion}`,
            label: preview.staffTaskRequired ? '提交客服处理' : '确认取消'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${preview.orderId}:refresh`,
            label: '暂不取消，返回订单'
          }
        ]
      }
    ]
  };
}

export function buildPlayerWorkbenchMessage(workbench: PlayerWorkbenchSummary): MessageSpec {
  const currentOrder = workbench.currentOrder
    ? `当前订单：#${workbench.currentOrder.publicId} · ${workbench.currentOrder.status}`
    : '当前订单：暂无';
  const matchingLines = '可报名候选池：请查看派单频道；报名不会占用正式订单名额。';
  const failedChecks = workbench.eligibility.checks.filter((check) => !check.passed);
  const components: ActionRowSpec[] = [
    {
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: 'bc:entry:player-workbench',
          label: '刷新'
        },
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: 'bc:reports:list:first',
          label: '我的周报'
        }
      ]
    }
  ];
  return {
    title: '🎧 陪玩工作台',
    body: [
      '**接单状态**',
      `准入状态：${workbench.eligibility.eligible ? '可报名' : '暂不可报名'}`,
      failedChecks.length > 0
        ? `未满足条件：${failedChecks.map((check) => check.reason ?? check.code).join('；')}`
        : null,
      currentOrder,
      matchingLines,
      '\n**收益概览**',
      `待确认收益：${formatPlatformMoney(workbench.earningsSummary.pendingMinor, workbench.earningsSummary.currency)}`,
      `已确认收益：${formatPlatformMoney(workbench.earningsSummary.confirmedMinor, workbench.earningsSummary.currency)}`,
      `已支付收益：${formatPlatformMoney(workbench.earningsSummary.paidMinor, workbench.earningsSummary.currency)}`,
      `\n-# 更新时间：${workbench.earningsSummary.calculatedAt}`
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'EPHEMERAL',
    components
  };
}

export function buildDispatchOfferMessage(input: DispatchOfferSummary): MessageSpec {
  return {
    title: `🔔 新订单 #${input.orderPublicId}`,
    body: [
      `**${input.game} · ${input.service}**`,
      `区服：${input.region}`,
      `时长：${input.durationLabel}`,
      `预计收益：${formatPlatformMoney(input.playerEarningMinor, input.currency)}`,
      input.voiceChannelId ? `语音频道：${input.voiceChannelId}` : '语音频道：待创建',
      input.notes ? `备注：${input.notes}` : '备注：未填写',
      `接单截止：${input.expiresAt}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:dispatch:${input.dispatchAttemptId}:accept:${input.orderId}:v${input.orderVersion}`,
            label: '确认接单'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:dispatch:${input.dispatchAttemptId}:decline:${input.orderId}:v${input.orderVersion}`,
            label: '暂不接单'
          }
        ]
      }
    ]
  };
}

export function buildAcceptedDispatchMessage(input: {
  offer: DispatchOfferSummary;
  acceptedPlayerDisplayName: string;
}): MessageSpec {
  return {
    title: `✅ 订单 #${input.offer.orderPublicId} 已被接取`,
    body: [
      `接单陪玩：${input.acceptedPlayerDisplayName}`,
      `${input.offer.game} · ${input.offer.service}`,
      `区服：${input.offer.region}`,
      `时长：${input.offer.durationLabel}`,
      '本轮派单已结束，其他候选按钮已失效。'
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:dispatch:${input.offer.dispatchAttemptId}:accepted:${input.offer.orderId}:v${input.offer.orderVersion}`,
            label: '已接单',
            disabled: true
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:dispatch:${input.offer.dispatchAttemptId}:closed:${input.offer.orderId}:v${input.offer.orderVersion}`,
            label: '本轮已结束',
            disabled: true
          }
        ]
      }
    ]
  };
}

export function buildServiceLifecyclePanelMessage(order: OrderLifecyclePanelSummary): MessageSpec {
  const giftsEnabled = Array.isArray(order.enabledFeatures) && order.enabledFeatures.includes('GIFTS');
  if (order.status === 'ACCEPTED') {
    return {
      title: `⏳ 订单 #${order.publicId} · 等待双方就绪`,
      body: [
        '**准备状态**',
        `用户：${readinessLabel(order.readiness.customer)}`,
        `陪玩：${readinessLabel(order.readiness.player)}`,
        order.readiness.readyDeadlineAt ? `就绪截止：${order.readiness.readyDeadlineAt}` : null
      ]
        .filter(Boolean)
        .join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'PRIMARY',
              customId: `bc:service:ready:${order.orderId}:v${order.version}`,
              label: '我已就绪'
            },
            {
              type: 'BUTTON',
              style: 'DANGER',
              customId: `bc:order:${order.orderId}:cancel:v${order.version}`,
              label: '取消订单'
            },
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${order.orderId}:v${order.version}`,
              label: '我要申诉'
            },
            ...(order.actorRole === 'CUSTOMER' && giftsEnabled
              ? [
                  {
                    type: 'BUTTON' as const,
                    style: 'SECONDARY' as const,
                    customId: `bc:gift:open:${order.orderId}:v${order.version}`,
                    label: '赠送礼物'
                  }
                ]
              : []),
            refreshOrderControl(order.orderId)
          ]
        }
      ]
    };
  }
  if (order.status === 'IN_SERVICE') {
    const components: ComponentSpec[] = orderMenuControls(order.orderId, order.version);
    if (order.actorRole === 'PLAYER') {
      components.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:request-completion:${order.orderId}:v${order.version}`,
        label: '申请完成'
      });
    }
    if (order.actorRole === 'CUSTOMER' && giftsEnabled)
      components.unshift({
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:gift:open:${order.orderId}:v${order.version}`,
        label: '赠送礼物'
      });
    return {
      title: `🎮 订单 #${order.publicId} · 服务中`,
      body: order.readiness.startedAt
        ? `**服务已经开始**\n\n开始时间：${order.readiness.startedAt}`
        : '**服务已经开始**',
      visibility: 'PRIVATE_CHANNEL',
      components: [{ type: 'ACTION_ROW', components }]
    };
  }
  if (order.status === 'PENDING_CONFIRMATION') {
    const components: ComponentSpec[] = orderMenuControls(order.orderId, order.version);
    if (order.actorRole === 'CUSTOMER') {
      components.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:confirm:${order.orderId}:v${order.version}`,
        label: '确认完成'
      });
      if (giftsEnabled)
        components.push({
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:gift:open:${order.orderId}:v${order.version}`,
          label: '赠送礼物'
        });
    }
    return {
      title: `✨ 订单 #${order.publicId} · 等待用户确认`,
      body: BOT_COPY.orders.completionPending,
      visibility: 'PRIVATE_CHANNEL',
      components: [{ type: 'ACTION_ROW', components }]
    };
  }
  if (order.status === 'EXCEPTION' || order.readiness.staffTaskId) {
    return {
      title: `🛎️ 订单 #${order.publicId} · 客服处理中`,
      body: [
        order.readiness.staffTaskId
          ? `客服任务已创建：${order.readiness.staffTaskId}`
          : '客服任务已创建，等待客服核对。',
        BOT_COPY.orders.staffReviewScope
      ].join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${order.orderId}:v${order.version}`,
              label: '联系客服'
            },
            refreshOrderControl(order.orderId)
          ]
        }
      ]
    };
  }
  return {
    title: `📋 订单 #${order.publicId}`,
    body: `当前状态：${order.status}`,
    visibility: 'PRIVATE_CHANNEL',
    components: [{ type: 'ACTION_ROW', components: [refreshOrderControl(order.orderId)] }]
  };
}

export function buildOrderConfirmationMessage(input: {
  order: OrderSummary;
  estimate: OrderEstimateSummary;
  balance: BalanceSummary;
}): MessageSpec {
  const missing = missingConfirmationFields(input.order);
  const currencyMismatch = input.estimate.currency !== input.balance.currency;
  const deficitMinor = Math.max(0, input.estimate.amountMinor - input.balance.availableMinor);
  const canSubmit = missing.length === 0 && deficitMinor === 0 && !currencyMismatch;
  const statusLine = canSubmit
    ? '状态：可以提交。提交时 API 会再次复核价格、余额、版本和服务目录。'
    : confirmationBlockedReason({
        missing,
        deficitMinor,
        estimateCurrency: input.estimate.currency,
        currencyMismatch
      });

  return {
    title: `📋 订单 #${input.order.publicId} · 最后确认`,
    body: [
      '**委托内容**',
      `游戏：${formatGame(input.order.game)}`,
      `服务：${formatService(input.order.service)}`,
      `区服：${formatRegion(input.order.region)}`,
      `时长：${formatEstimateDuration(input.estimate)}`,
      '标签：P0 默认匹配',
      input.order.notes ? `备注：${input.order.notes}` : '备注：未填写',
      '',
      '**价格与余额**',
      `预计价格：${formatCustomerMoney(input.estimate.amountMinor, input.estimate.currency)}`,
      `可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      '',
      '**提交须知**',
      '取消规则：提交前取消不预留；提交后、服务开始前取消将释放预留，异常由客服处理。',
      statusLine,
      `价格有效期：${input.estimate.validUntil}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${input.order.id}:submit-final:v${input.order.version}`,
            label: '确认提交并预留',
            disabled: !canSubmit
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${input.order.id}:refresh`,
            label: '刷新确认'
          },
          {
            type: 'BUTTON',
            style: 'DANGER',
            customId: `bc:order:${input.order.id}:cancel:v${input.order.version}`,
            label: '取消订单'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:service:support:${input.order.id}:v${input.order.version}`,
            label: '我要申诉'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:service-center:recharge',
            label: '联系客服充值',
            disabled: deficitMinor === 0
          }
        ]
      }
    ]
  };
}

export function buildMultiProjectOrderConfirmationMessage(input: {
  order: OrderSummary;
  requirements: OrderRequirementPageSummary;
  balance: BalanceSummary;
}): MessageSpec {
  const active = input.requirements.items.filter((item) => item.status === 'ACTIVE');
  const currencyMismatch = input.requirements.currency !== input.balance.currency;
  const deficitMinor = Math.max(0, input.requirements.derivedTotalMinor - input.balance.availableMinor);
  const canSubmit = active.length > 0 && !currencyMismatch && deficitMinor === 0;
  const lines = active
    .map(
      (item, index) =>
        `${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName}${item.regionDisplayName ? ` · ${item.regionDisplayName}` : ''}\n   ${formatRequirementDuration(item)} × ${item.requestedPlayerCount} 位 · ${formatCustomerMoney(item.estimatedLinePriceMinor, input.requirements.currency)}${item.customerNote ? `\n   偏好：${item.customerNote}` : ''}`
    )
    .join('\n');
  return {
    title: `📋 订单 ${input.order.publicId} · 第 4/4 步 · 最后确认`,
    body: [
      '▓▓▓▓',
      '这是提交前的最终确认。价格、余额、目录有效性与套餐调整仍由业务 API 重新校验。',
      lines || '还没有添加陪玩项目。',
      `订单合计：${formatCustomerMoney(input.requirements.derivedTotalMinor, input.requirements.currency)}`,
      `可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      '确认后创建资金预留，不立即扣款。',
      canSubmit
        ? '状态：可以提交。'
        : currencyMismatch
          ? '订单币种与钱包币种不一致。'
          : active.length === 0
            ? '请先添加至少一个陪玩项目。'
            : `可用余额还差 ${formatCustomerMoney(deficitMinor, input.requirements.currency)}。`
    ].join('\n\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:req:${input.order.id}:back:v${input.requirements.orderVersion}`,
            label: '返回编辑'
          },
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${input.order.id}:submit-final:v${input.requirements.orderVersion}`,
            label: '确认提交订单',
            disabled: !canSubmit
          },
          refreshOrderControl(input.order.id)
        ]
      }
    ],
    layout: 'COMPONENTS_V2'
  };
}

function readinessLabel(value: 'READY' | 'NOT_READY'): string {
  return value === 'READY' ? '已就绪' : '未就绪';
}

export function buildSubmittedOrderMessage(input: OrderReservationSummaryResult): MessageSpec {
  return {
    title: '🔎 订单已提交 · 正在匹配陪玩',
    body: [
      '**订单状态**',
      `订单状态：${input.status}`,
      '',
      '**资金状态**',
      `本单预留：${formatCustomerMoney(input.reservation.amountMinor, input.reservation.currency)}`,
      `预留状态：${input.reservation.status}`,
      `提交后可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      `当前预留总额：${formatCustomerMoney(input.balance.reservedMinor, input.balance.currency)}`,
      BOT_COPY.orders.reservationOnly,
      '',
      BOT_COPY.orders.dispatchStarted
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      ...selectionWaitRows(`bc:sp:new:${input.orderId}:o${input.version}`),
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${input.orderId}:refresh`,
            label: '刷新订单'
          },
          {
            type: 'BUTTON',
            style: 'DANGER',
            customId: `bc:order:${input.orderId}:cancel:v${input.version}`,
            label: '取消订单'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:service:support:${input.orderId}:v${input.version}`,
            label: '我要申诉'
          }
        ]
      }
    ]
  };
}

function selectionWaitRows(customId: string): MessageComponentSpec[] {
  const waitMinutes = [3, 5, 10, 15, 30];
  return [
    {
      type: 'ACTION_ROW',
      components: [
        {
          type: 'STRING_SELECT',
          customId,
          placeholder: '选择等待时间',
          minValues: 1,
          maxValues: 1,
          options: waitMinutes.map((minutes) => ({
            label: `等待 ${minutes} 分钟`,
            value: String(minutes)
          }))
        }
      ]
    }
  ];
}

export function buildCancellationResultMessage(input: CancellationResultSummary): MessageSpec {
  if (input.staffTaskId && input.status !== 'CANCELLED') {
    return {
      title: '🛎️ 取消申请已转客服',
      body: [
        `客服任务已创建：${input.staffTaskId}`,
        `订单仍保持：${input.status}`,
        '客服会核对订单、语音频道、服务进度和资金状态；不会自动退款或释放预留。'
      ].join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${input.orderId}:v${input.version}`,
              label: '联系客服'
            },
            refreshOrderControl(input.orderId)
          ]
        }
      ]
    };
  }
  return {
    title: '✅ 订单已取消',
    body: [
      `订单状态：${input.status}`,
      `资金处理：${input.fundAction}`,
      input.releasedReservation
        ? `释放金额：${formatCustomerMoney(input.releasedReservation.releasedMinor, input.releasedReservation.currency)}`
        : null
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [{ type: 'ACTION_ROW', components: [refreshOrderControl(input.orderId)] }]
  };
}

export async function handleOpenOrderConfirmation(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const order = await input.api.getOrder(input.orderId, input.actor);
  if (order.status !== 'DRAFT') {
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(order)
    };
  }
  try {
    if (input.api.listOrderRequirements) {
      const [requirements, balance] = await Promise.all([
        input.api.listOrderRequirements(input.orderId, input.actor, undefined, 25),
        input.api.getCurrentBalance(input.actor)
      ]);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildMultiProjectOrderConfirmationMessage({
          order,
          requirements,
          balance
        })
      };
    }
    const [estimate, balance] = await Promise.all([
      input.api.estimateOrder(
        input.orderId,
        { expectedVersion: input.expectedVersion },
        input.actor,
        input.idempotencyKey
      ),
      input.api.getCurrentBalance(input.actor)
    ]);
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderConfirmationMessage({ order, estimate, balance })
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(order),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    if (isApiError(error, 'BUSINESS_RULE_VIOLATION')) {
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildIncompleteConfirmationMessage(order),
        notice: botCopy.orders.incomplete(requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开订单确认面板')
    };
  }
}

export async function handleOrderRefresh(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
}): Promise<Extract<BotFlowResult, { kind: 'EDIT_ORIGINAL_MESSAGE' } | { kind: 'EPHEMERAL_MESSAGE' }>> {
  try {
    const order = await input.api.getOrder(input.orderId, input.actor);
    if (order.status === 'DRAFT') {
      const services = await input.api.listServices(input.actor);
      if (input.api.listOrderRequirements) {
        const requirements = await input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10);
        if (requirements.items.some((item) => item.status === 'ACTIVE'))
          return {
            kind: 'EDIT_ORIGINAL_MESSAGE',
            message: buildMultiProjectOrderPanelMessage(order, requirements, services.items)
          };
      }
      const packages = input.api.listServicePackages
        ? await input.api.listServicePackages(input.actor, undefined, 25)
        : { items: [], nextCursor: null };
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildGamePickerMessage(order, services.items, packages.items)
      };
    }
    if (order.status === 'PENDING_DISPATCH') {
      let currentPool: SelectionPoolSummary | null = null;
      if (input.api.getCurrentSelectionPool) {
        try {
          currentPool = (await input.api.getCurrentSelectionPool(input.orderId, input.actor)).pool;
        } catch (error) {
          if (!isApiError(error, 'NOT_FOUND')) throw error;
        }
      }
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildSelectionPoolRefreshMessage(order, currentPool)
      };
    }
    let requirements: OrderRequirementPageSummary | undefined;
    const needsRequirementDetails =
      Boolean(order.compositionMode) || !order.game || !order.service || !order.billingUnitMinutes || !order.unitCount;
    if (needsRequirementDetails && input.api.listOrderRequirements) {
      try {
        requirements = await input.api.listOrderRequirements(input.orderId, input.actor, undefined, 25);
      } catch (error) {
        if (!isApiError(error, 'PERMISSION_DENIED')) throw error;
      }
    }
    return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildOrderPanelMessage(order, [], requirements) };
  } catch (error) {
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '刷新订单') };
  }
}

export async function handleSubmitFinalOrder(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const result = await input.api.submitOrder(
      input.orderId,
      { expectedVersion: input.expectedVersion },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildSubmittedOrderMessage(result)
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      const refreshed = await input.api.getOrder(input.orderId, input.actor);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(refreshed),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '提交订单')
    };
  }
}

export async function handleServiceLifecycleAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  action: 'ready' | 'request-completion' | 'confirm' | 'support';
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    if (input.action === 'ready') {
      let result;
      try {
        result = await input.api.setOrderReadiness(
          input.orderId,
          { expectedVersion: input.expectedVersion, readiness: 'READY' },
          input.actor,
          input.idempotencyKey
        );
      } catch (error) {
        if (!isApiError(error, 'CONFLICT')) throw error;
        const refreshed = await input.api.getOrder(input.orderId, input.actor);
        if (refreshed.status !== 'ACCEPTED') {
          return {
            kind: 'EDIT_ORIGINAL_MESSAGE',
            message: buildOrderPanelMessage(refreshed),
            notice: BOT_COPY.orders.stateRefreshed
          };
        }
        result = await input.api.setOrderReadiness(
          input.orderId,
          { expectedVersion: refreshed.version, readiness: 'READY' },
          input.actor,
          `${input.idempotencyKey}:retry-v${refreshed.version}`
        );
      }
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildServiceLifecyclePanelMessage(result)
      };
    }
    if (input.action === 'request-completion') {
      await input.api.requestOrderCompletion(
        input.orderId,
        { expectedVersion: input.expectedVersion },
        input.actor,
        input.idempotencyKey
      );
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: BOT_COPY.orders.completionRequested
      };
    }
    if (input.action === 'confirm') {
      const result = await input.api.confirmOrder(
        input.orderId,
        {
          expectedVersion: input.expectedVersion,
          confirmation: 'CONFIRM_COMPLETED'
        },
        input.actor,
        input.idempotencyKey
      );
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: botCopy.lifecycle.completionConfirmed(formatCustomerMoney(result.capturedMinor, result.currency))
      };
    }
    const task = await input.api.createOrderAppeal(
      input.orderId,
      {
        type: 'ORDER_ASSIST',
        reasonCode: 'CUSTOMER_DISPUTE',
        note: '用户从订单常驻菜单发起申诉。',
        voiceChannelId: null
      },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: botCopy.lifecycle.appealSubmitted(task.publicId)
    };
  } catch (error) {
    if (isApiError(error, 'PERMISSION_DENIED')) {
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: lifecyclePermissionDeniedMessage(input.action, requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '更新订单状态')
    };
  }
}

export async function handleOpenServiceCenterFromPublicEntry(input: {
  api: BotApiClient;
  actor: BotActorContext;
}): Promise<BotFlowResult> {
  try {
    const currentUser = await input.api.getCurrentUser(input.actor);
    const [balance, consumptions, commissions, activeOrder] = await Promise.all([
      input.api.getCurrentBalance(input.actor),
      input.api.listCurrentUserConsumptions(input.actor),
      input.api.listCurrentUserCommissions(input.actor),
      currentUser.activeOrderId ? input.api.getOrder(currentUser.activeOrderId, input.actor) : Promise.resolve(null)
    ]);

    return {
      kind: 'SHOW_SERVICE_CENTER',
      message: buildServiceCenterMessage({
        currentUser,
        balance,
        activeOrder,
        consumptions,
        commissions
      })
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开服务中心')
    };
  }
}

export async function handleOpenPlayerWorkbench(input: {
  api: BotApiClient;
  actor: BotActorContext;
}): Promise<BotFlowResult> {
  try {
    const workbench = await input.api.getPlayerWorkbench(input.actor);
    return {
      kind: 'SHOW_PLAYER_WORKBENCH',
      message: buildPlayerWorkbenchMessage(workbench)
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开陪玩工作台')
    };
  }
}

export async function handleOpenCancellationPreview(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const preview = await input.api.previewOrderCancellation(
      input.orderId,
      {
        expectedVersion: input.expectedVersion,
        reasonCode: 'CUSTOMER_REQUEST'
      },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildCancellationPreviewMessage(preview)
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开订单取消说明')
    };
  }
}

export async function handleConfirmCancellation(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  previewId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const result = await input.api.cancelOrder(
      input.orderId,
      {
        expectedVersion: input.expectedVersion,
        previewId: input.previewId,
        reasonCode: 'CUSTOMER_REQUEST'
      },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: result.staffTaskId ? BOT_COPY.orders.cancellationEscalated : BOT_COPY.orders.cancellationCompleted
    };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 'CANCELLATION_PREVIEW_STALE') {
      try {
        const order = await input.api.getOrder(input.orderId, input.actor);
        const refreshedPreview = await input.api.previewOrderCancellation(
          input.orderId,
          { expectedVersion: order.version, reasonCode: 'CUSTOMER_REQUEST' },
          input.actor,
          `${input.idempotencyKey}:refresh-preview`
        );
        return {
          kind: 'EDIT_ORIGINAL_MESSAGE',
          message: buildCancellationPreviewMessage(refreshedPreview),
          notice: botCopy.orders.cancellationRefreshed(error.requestId)
        };
      } catch (refreshError) {
        return {
          kind: 'EPHEMERAL_MESSAGE',
          message: formatApiError(refreshError, '刷新取消说明')
        };
      }
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '取消订单')
    };
  }
}

export async function handleCreateOrderFromPublicEntry(input: {
  api: BotApiClient;
  actor: BotActorContext;
  provisionalChannel: OrderChannelSpec | null;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  if (!input.provisionalChannel) {
    const requestId = `req_${createHash('sha256').update(`${input.actor.guildId}:${input.actor.interactionId}`).digest('hex').slice(0, 24)}`;
    let reported = false;
    for (let attempt = 0; attempt < 2 && !reported; attempt += 1) {
      try {
        await input.api.reportChannelCreationFailure(
          { requestId, failureCode: 'CHANNEL_CREATE_FAILED' },
          input.actor,
          `channel-failure:${input.actor.interactionId}`
        );
        reported = true;
      } catch {
        // A second bounded attempt protects the support record without delaying the interaction indefinitely.
      }
    }
    return {
      kind: 'CHANNEL_CREATION_FAILED',
      message: botCopy.orders.channelCreationFailed(requestId, !reported)
    };
  }

  try {
    const response = await input.api.createOrder(
      { orderType: 'IMMEDIATE', channelSpec: input.provisionalChannel },
      input.actor,
      input.idempotencyKey
    );

    if (response.statusCode === 200) {
      return {
        kind: 'OPEN_EXISTING_CHANNEL',
        channelId: response.order.channelSpec.channelId,
        orderId: response.order.id
      };
    }

    return {
      kind: 'CREATE_PRIVATE_CHANNEL',
      order: response.order,
      message: buildOrderPanelMessage(response.order)
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '创建订单')
    };
  }
}

export async function handleOrderSelectSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  field: 'catalog' | 'duration' | 'preferred-players';
  value: string | string[];
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const [order, catalog] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    input.api.listServices(input.actor)
  ]);
  if (input.field === 'preferred-players') {
    const updated = await input.api.updateOrder(
      input.orderId,
      {
        expectedVersion: input.expectedVersion,
        preferredPlayerDiscordUserIds: Array.isArray(input.value) ? input.value : [input.value]
      },
      input.actor,
      input.idempotencyKey
    );
    if (input.api.listOrderRequirements) {
      const page = await input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildMultiProjectOrderPanelMessage(updated, page, catalog.items)
      };
    }
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(updated, catalog.items)
    };
  }
  const selected =
    input.field === 'catalog'
      ? catalog.items.find((item) => item.id === input.value)
      : catalog.items.find((item) => item.id === order.serviceCatalogId);
  if (!selected) throw new Error('The selected service catalog is unavailable.');
  const payload: Record<string, unknown> = {
    expectedVersion: input.expectedVersion,
    serviceCatalogId: selected.id,
    unitCount:
      input.field === 'duration'
        ? Number.parseInt(String(input.value), 10)
        : Math.max(order.unitCount ?? 0, selected.minimumUnits)
  };
  if (order.preferredPlayerDiscordUserIds?.length) {
    payload.preferredPlayerDiscordUserIds = order.preferredPlayerDiscordUserIds;
  }
  const updated = await input.api.updateOrder(input.orderId, payload, input.actor, input.idempotencyKey);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildOrderPanelMessage(updated, catalog.items)
  };
}

export async function handleOrderRequirementSelectSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  action: 'add' | 'preview' | 'edit' | 'project' | 'units' | 'players';
  requirementId?: string;
  expectedRequirementVersion?: number;
  cursor?: string;
  value: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const requirementApi = requireOrderRequirementApi(input.api);
  const [order, page, catalog] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, input.cursor, 10),
    input.api.listServices(input.actor)
  ]);
  if (input.action === 'preview') {
    const selected = catalog.items.find((item) => item.id === input.value);
    if (!selected) throw new Error('The selected service catalog is unavailable.');
    const packages = await requirePackageApi(input.api).list(input.actor, undefined, 25, selected.game);
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildGameOrderingMenuMessage(
        order,
        selected.game,
        catalog.items.filter((item) => item.game === selected.game),
        packages,
        selected
      )
    };
  }
  let selectedRequirementId = input.action === 'edit' ? input.value : input.requirementId;
  let changedRequirement: OrderRequirementMutationSummary | null = null;
  if (input.action === 'add') {
    const service = catalog.items.find((item) => item.id === input.value);
    if (!service) throw new Error('The selected service catalog is unavailable.');
    await requirementApi.add(
      input.orderId,
      {
        expectedOrderVersion: input.expectedVersion,
        serviceCatalogVersionId: service.id,
        unitCount: service.minimumUnits,
        requestedPlayerCount: 1
      },
      input.actor,
      input.idempotencyKey
    );
    selectedRequirementId = undefined;
  } else if (input.action === 'project' || input.action === 'units' || input.action === 'players') {
    const requirement = page.items.find((item) => item.id === input.requirementId && item.status === 'ACTIVE');
    const requirementVersion = requirement?.version ?? input.expectedRequirementVersion;
    if (!input.requirementId || !requirementVersion) throw new Error('The selected order requirement is unavailable.');
    const quantity = input.action === 'project' ? null : Number.parseInt(input.value, 10);
    if (input.action !== 'project' && (!Number.isSafeInteger(quantity) || Number(quantity) < 1))
      throw new Error('The selected quantity is invalid.');
    const changed = await requirementApi.update(
      input.orderId,
      input.requirementId,
      {
        expectedOrderVersion: input.expectedVersion,
        expectedRequirementVersion: requirementVersion,
        action: input.action === 'project' ? 'CHANGE_PROJECT' : 'CHANGE_QUANTITY',
        serviceCatalogVersionId: input.action === 'project' ? input.value : null,
        unitCount: input.action === 'units' ? Number(quantity) : null,
        requestedPlayerCount: input.action === 'players' ? Number(quantity) : null
      },
      input.actor,
      input.idempotencyKey
    );
    changedRequirement = changed;
  }
  const [refreshedOrder, refreshedPage] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, input.cursor, 10)
  ]);
  if (
    changedRequirement &&
    selectedRequirementId &&
    !refreshedPage.items.some((item) => item.id === selectedRequirementId)
  ) {
    refreshedPage.items = [changedRequirement.requirement];
    refreshedPage.orderVersion = changedRequirement.orderVersion;
    refreshedPage.derivedTotalMinor = changedRequirement.derivedTotalMinor;
    refreshedPage.nextCursor = null;
  }
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(
      refreshedOrder,
      refreshedPage,
      catalog.items,
      selectedRequirementId,
      input.cursor
    )
  };
}

export async function handleOrderRequirementAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  action: 'back' | 'remove' | 'page';
  cursor?: string;
  requirementId?: string;
  expectedRequirementVersion?: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const requirementApi = requireOrderRequirementApi(input.api);
  if (input.action === 'remove') {
    if (!input.requirementId || !input.expectedRequirementVersion)
      throw new Error('Requirement identity and version are required.');
    await requirementApi.update(
      input.orderId,
      input.requirementId,
      {
        expectedOrderVersion: input.expectedVersion,
        expectedRequirementVersion: input.expectedRequirementVersion,
        action: 'REMOVE'
      },
      input.actor,
      input.idempotencyKey
    );
  }
  const cursor = input.action === 'page' ? input.cursor : undefined;
  const [order, page, services] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, cursor, 10),
    input.api.listServices(input.actor)
  ]);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(order, page, services.items, undefined, cursor)
  };
}

export async function handleOrderNotesSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  notes: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const updated = await input.api.updateOrder(
      input.orderId,
      { expectedVersion: input.expectedVersion, notes: input.notes },
      input.actor,
      input.idempotencyKey
    );
    if (input.api.listOrderRequirements) {
      const [page, services] = await Promise.all([
        input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10),
        input.api.listServices(input.actor)
      ]);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildMultiProjectOrderPanelMessage(updated, page, services.items)
      };
    }
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(updated)
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      const refreshed = await input.api.getOrder(input.orderId, input.actor);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(refreshed),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '保存订单备注')
    };
  }
}

export async function handleRequirementNoteSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  requirementId: string;
  expectedVersion: number;
  expectedRequirementVersion: number;
  customerNote: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const requirementApi = requireOrderRequirementApi(input.api);
  await requirementApi.update(
    input.orderId,
    input.requirementId,
    {
      expectedOrderVersion: input.expectedVersion,
      expectedRequirementVersion: input.expectedRequirementVersion,
      action: 'CHANGE_NOTE',
      customerNote: input.customerNote || null
    },
    input.actor,
    input.idempotencyKey
  );
  const [order, page, services] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, undefined, 10),
    input.api.listServices(input.actor)
  ]);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(order, page, services.items, input.requirementId)
  };
}

export function buildSupportRatingMessage(orderId: string): MessageSpec {
  return {
    title: '⭐ 评价客服体验',
    body: '请评价本次订单中实际为你回复的客服。评价不会影响订单扣款或陪玩收益。',
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [1, 2, 3, 4, 5].map((score): ComponentSpec => ({
          type: 'BUTTON',
          style: score <= 2 ? 'DANGER' : 'SECONDARY',
          customId: `bc:support-rating:${orderId}:s${score}`,
          label: `${score} 分`
        }))
      }
    ]
  };
}

export function buildLowRatingReasonMessage(orderId: string, score: number): MessageSpec {
  const reasons = [
    ['RUDE_LANGUAGE', '言语不礼貌'],
    ['COLD_OR_DISMISSIVE', '态度冷淡'],
    ['RESPONSIBILITY_SHIRKING', '推卸责任'],
    ['PRESSURING_CUSTOMER', '催促或施压'],
    ['OTHER', '其他']
  ] as const;
  return {
    title: '⭐ 请选择主要原因',
    body: '低分需要选择一个固定原因，仅用于事实记录。',
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: reasons.map(([reason, label]) => ({
          type: 'BUTTON' as const,
          style: 'SECONDARY' as const,
          customId: `bc:support-rating:${orderId}:s${score}:r${reason}`,
          label
        }))
      }
    ]
  };
}

export async function handleSupportRatingAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  score: number | null;
  reason: string | null;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  if (input.score === null) {
    return {
      kind: 'SHOW_SUPPORT_RATING',
      message: buildSupportRatingMessage(input.orderId)
    };
  }
  if (input.score <= 2 && !input.reason) {
    return {
      kind: 'SHOW_SUPPORT_RATING',
      message: buildLowRatingReasonMessage(input.orderId, input.score)
    };
  }
  if (input.reason === 'OTHER') {
    return {
      kind: 'SHOW_MODAL',
      modal: {
        title: '📝 补充客服评价',
        customId: `bc:support-rating-comment:${input.orderId}:s${input.score}`,
        components: [
          {
            type: 'TEXT_INPUT',
            customId: 'comment',
            label: '请简要说明',
            style: 'PARAGRAPH',
            required: true,
            maxLength: 500
          }
        ]
      }
    };
  }
  try {
    await input.api.submitSupportRating(
      input.orderId,
      { score: input.score, reason: input.reason },
      input.actor,
      input.idempotencyKey
    );
    return { kind: 'EPHEMERAL_MESSAGE', message: '感谢评价，已记录。' };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '提交客服评价')
    };
  }
}

function select(
  customId: string,
  placeholder: string,
  options: Array<{ label: string; value: string }>,
  disabled = false
): ComponentSpec {
  return { type: 'STRING_SELECT', customId, placeholder, options, disabled };
}

function requirementOptions(requirements: OrderRequirementSummary[]): Array<{ label: string; value: string }> {
  if (!requirements.length) return [{ label: '还没有项目', value: 'unavailable' }];
  return requirements.slice(0, 25).map((item, index) => ({
    label:
      `${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName} · ${item.unitCount} 单位 × ${item.requestedPlayerCount} 位`.slice(
        0,
        100
      ),
    value: item.id
  }));
}

function integerOptions(
  min: number,
  max: number,
  current: number,
  label: (value: number) => string
): Array<{ label: string; value: string }> {
  const values = new Set<number>();
  for (let value = min; value <= max; value += 1) values.add(value);
  values.add(current);
  return [...values]
    .sort((a, b) => a - b)
    .slice(0, 25)
    .map((value) => ({
      label: `${label(value)}${value === current ? ' · 当前' : ''}`.slice(0, 100),
      value: String(value)
    }));
}

function formatRequirementDuration(
  requirement: Pick<OrderRequirementSummary, 'unitCount' | 'billingUnitMinutes'>
): string {
  const minutes = requirement.unitCount * requirement.billingUnitMinutes;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function requireOrderRequirementApi(api: BotApiClient) {
  if (!api.listOrderRequirements || !api.addOrderRequirement || !api.updateOrderRequirement)
    throw new Error('Order requirement API is unavailable.');
  return {
    list: api.listOrderRequirements.bind(api),
    add: api.addOrderRequirement.bind(api),
    update: api.updateOrderRequirement.bind(api)
  };
}
function requirePackageApi(api: BotApiClient) {
  if (!api.listServicePackages || !api.previewServicePackage || !api.applyServicePackage)
    throw new Error('Service package API is unavailable.');
  return {
    list: api.listServicePackages.bind(api),
    preview: api.previewServicePackage.bind(api),
    apply: api.applyServicePackage.bind(api)
  };
}

function orderMenuControls(orderId: string, version: number): ComponentSpec[] {
  return [
    refreshOrderControl(orderId),
    {
      type: 'BUTTON',
      style: 'DANGER',
      customId: `bc:order:${orderId}:cancel:v${version}`,
      label: '取消订单'
    },
    {
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:service:support:${orderId}:v${version}`,
      label: '我要申诉'
    }
  ];
}

function orderStatusControls(orderId: string, version: number, status: string): ComponentSpec[] {
  const controls = orderMenuControls(orderId, version);
  if (status === 'ACCEPTED')
    controls.unshift({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:service:ready:${orderId}:v${version}`,
      label: '我已就绪'
    });
  if (status === 'IN_SERVICE')
    controls.unshift({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:service:request-completion:${orderId}:v${version}`,
      label: '申请完成'
    });
  if (status === 'PENDING_CONFIRMATION')
    controls.unshift({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:service:confirm:${orderId}:v${version}`,
      label: '确认完成'
    });
  if (status === 'COMPLETED' || status === 'CANCELLED')
    return controls.filter((control) => control.type !== 'BUTTON' || control.label !== '取消订单');
  return controls;
}

function refreshOrderControl(orderId: string): ComponentSpec {
  return {
    type: 'BUTTON',
    style: 'SECONDARY',
    customId: `bc:order:${orderId}:refresh`,
    label: '刷新订单'
  };
}

function serviceOptions(
  order: OrderSummary,
  services: PublicServiceSummary[]
): Array<{ label: string; value: string }> {
  const options = services.slice(0, 25).map((item) => ({
    label:
      `${item.gameDisplayName ?? item.game} · ${item.serviceDisplayName ?? item.service}${item.region ? ` · ${item.regionDisplayName ?? item.region}` : ''}`.slice(
        0,
        100
      ),
    value: item.id
  }));
  if (options.length) return options;
  if (order.serviceCatalogId)
    return [
      {
        label: `${order.game ?? '陪玩'} · ${order.service ?? '服务'}`.slice(0, 100),
        value: order.serviceCatalogId
      }
    ];
  return [{ label: '暂无可用陪玩项目', value: 'unavailable' }];
}

function isApiError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function requestId(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'requestId' in error) {
    const value = (error as { requestId?: unknown }).requestId;
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return 'unknown';
}

function formatApiError(error: unknown, operation: string): string {
  return formatUserFacingError(error, { operation });
}

function lifecyclePermissionDeniedMessage(
  action: 'ready' | 'request-completion' | 'confirm' | 'support',
  id: string
): string {
  if (action === 'confirm') return botCopy.lifecycle.confirmationRestricted(id);
  if (action === 'request-completion') return botCopy.lifecycle.completionRequestRestricted(id);
  if (action === 'ready') return botCopy.lifecycle.readinessRestricted(id);
  return botCopy.lifecycle.supportRestricted(id);
}

function formatGame(value: string | null): string {
  const labels: Record<string, string> = {
    VALORANT: '无畏契约',
    LEAGUE_OF_LEGENDS: '英雄联盟'
  };
  return value ? (labels[value] ?? value) : '未选择游戏';
}

function formatService(value: string | null): string {
  const labels: Record<string, string> = {
    ENTERTAINMENT: '娱乐陪玩',
    RANKED: '上分陪玩'
  };
  return value ? (labels[value] ?? value) : '未选择服务';
}

function formatRegion(value: string | null): string {
  const labels: Record<string, string> = {
    NA: '北美',
    CN: '国服'
  };
  return value ? (labels[value] ?? value) : '无指定区服';
}

function formatDuration(order: OrderSummary): string {
  if (!order.billingUnitMinutes || !order.unitCount) {
    return '未选择时长';
  }
  const totalMinutes = order.billingUnitMinutes * order.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

function formatEstimateDuration(estimate: OrderEstimateSummary): string {
  const totalMinutes = estimate.billingUnitMinutes * estimate.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

function formatPlatformMoney(amountMinor: number, currency: string): string {
  if (currency === 'CAT') return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
  const prefix = `${currency}\u00a0`;
  return `${prefix}${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)}`;
}

function formatCustomerMoney(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Customer wallet display requires canonical CAT subunits.');
  return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
}

function missingConfirmationFields(order: OrderSummary): string[] {
  const missing: string[] = [];
  if (!order.game) {
    missing.push('游戏');
  }
  if (!order.service) {
    missing.push('服务');
  }
  if (!order.billingUnitMinutes || !order.unitCount) {
    missing.push('时长');
  }
  return missing;
}

function confirmationBlockedReason(input: {
  missing: string[];
  deficitMinor: number;
  estimateCurrency: string;
  currencyMismatch: boolean;
}): string {
  if (input.missing.length > 0) {
    return `信息不完整：请补齐${input.missing.join('、')}后再确认。`;
  }
  if (input.currencyMismatch) {
    return '币种不一致：请联系客服处理后再确认。';
  }
  return `余额不足：还差 ${formatCustomerMoney(input.deficitMinor, input.estimateCurrency)}，请联系客服并提交付款 receipt，到账后刷新确认。`;
}

function buildIncompleteConfirmationMessage(order: OrderSummary): MessageSpec {
  const missing = missingConfirmationFields(order);
  return {
    title: `📋 订单 #${order.publicId} · 最后确认`,
    body: [
      `游戏：${formatGame(order.game)}`,
      `服务：${formatService(order.service)}`,
      `区服：${formatRegion(order.region)}`,
      `时长：${formatDuration(order)}`,
      order.notes ? `备注：${order.notes}` : '备注：未填写',
      `信息不完整：请补齐${missing.join('、')}后再确认。`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${order.id}:submit-final:v${order.version}`,
            label: '确认提交并预留',
            disabled: true
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${order.id}:refresh`,
            label: '返回修改'
          }
        ]
      }
    ]
  };
}
