import {
  type OrderRequirementPageSummary,
  type OrderRequirementSummary,
  type OrderSummary,
  type PublicServiceSummary,
  type ServicePackagePageSummary,
  type ServicePackageSummary
} from './service-center-api.js';
import {
  type ActionRowSpec,
  type ComponentSpec,
  type MessageComponentSpec,
  type MessageSpec
} from './service-center-components.js';
import { buildExperienceMessage } from './discord-experience.js';
import { resolveGameBanner } from './game-banners.js';
import { orderStatusDisplay } from './order-display.js';
import { resolveBlackcatWelcomeBanner } from './brand-banners.js';
import { BOT_COPY, botCopy } from './bot-copy.js';
import { buildMatchingProgressMessage } from './service-center-order-confirmation.js';
import {
  select,
  requirementOptions,
  integerOptions,
  formatRequirementDuration,
  customerOrderActionRows,
  customerOrderUtilityRows,
  cancelOrderControl,
  serviceOptions,
  formatGame,
  formatService,
  formatRegion,
  formatDuration,
  formatCustomerMoney
} from './service-center-shared.js';

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
  const selectionLines = orderPanelSelectionLines(order, services, requirements);
  const terminal = order.status === 'COMPLETED' || order.status === 'CANCELLED';
  return buildExperienceMessage({
    title,
    icon: terminal ? '🐈‍⬛' : '📋',
    introduction: terminal
      ? '这张订单已经结束，关键事实仍会保留在这里供你核对。'
      : '订单信息已经整理好，当前可用操作都在卡片下方。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: order.status === 'COMPLETED' ? 'SUCCESS' : order.status === 'CANCELLED' ? 'MUTED' : 'BRAND',
    coreFacts: [
      { name: '🎮 服务内容', value: selectionLines.join('\n') },
      { name: '🐟 订单金额', value: formatCustomerMoney(order.amountMinor, order.currency) }
    ],
    bossRequest: order.notes || null,
    progress: orderStatusDisplay(order.status),
    nextStep: terminal
      ? '本单无需继续操作；如需核对资金或服务记录，请联系猫舍前台。'
      : '使用下方当前可用按钮继续；状态有变化时点击“刷新最新状态”。',
    components: customerOrderActionRows(order)
  });
}

export function buildPausedAutomationMessage(order: OrderSummary): MessageSpec {
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
    components: customerOrderActionRows(order)
  };
}

function orderPanelSelectionLines(
  order: OrderSummary,
  services: PublicServiceSummary[],
  requirements?: OrderRequirementPageSummary
): string[] {
  const selectedService = services.find((service) => service.id === order.serviceCatalogId);
  const active = requirements?.items.filter((item) => item.status === 'ACTIVE') ?? [];
  if (active.length)
    return active.flatMap((requirement, index) => [
      `${active.length > 1 ? `${index + 1}. ` : ''}${requirement.gameDisplayName} · ${requirement.serviceDisplayName}`,
      `${requirement.regionDisplayName ?? '无指定区服'} · ${formatRequirementDuration(requirement)} × ${requirement.requestedPlayerCount} 位`
    ]);
  return [
    `${selectedService?.gameDisplayName ?? order.gameDisplayName ?? formatGame(order.game)} · ${selectedService?.serviceDisplayName ?? order.serviceDisplayName ?? formatService(order.service)}`,
    `${selectedService?.regionDisplayName ?? order.regionDisplayName ?? formatRegion(order.region)} · ${formatDuration(order)}`
  ];
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
  const components = buildRequirementComponents({ order, page, services, requirements, selected, cursor });
  const composition = orderCompositionLabel(order.compositionMode);
  return buildExperienceMessage({
    title: `订单 ${order.publicId} · 第 3/4 步 · 检查陪玩清单`,
    icon: '📋',
    introduction: '套餐只是快捷配菜；每个席位仍可独立修改服务、时长、人数和偏好。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: requirements.length ? 'BRAND' : 'WAITING',
    coreFacts: [
      { name: '🧭 下单进度', value: '第 3/4 步 · 检查陪玩清单' },
      {
        name: '🎮 当前阵容',
        value: `${composition}\n${formatRequirementGroups(requirements, page.currency)}`
      },
      { name: '🐟 当前报价', value: formatRequirementPrice(page, requirements) }
    ],
    bossRequest: order.notes || null,
    nextStep: requirements.length
      ? '可继续调整席位；确认无误后点击“核对订单与总价”。'
      : '先添加至少一个游戏或单点项目。',
    components,
    layout: 'COMPONENTS_V2'
  });
}

function formatRequirementGroups(requirements: OrderRequirementSummary[], currency: string): string {
  const groups = [...new Map(requirements.map((item) => [item.game, item.gameDisplayName])).entries()];
  if (!groups.length) return '清单还是空的。请先选择游戏，再从对应菜单加入套餐或单点项目。';
  return groups
    .map(([game, gameName]) => {
      const items = requirements.filter((item) => item.game === game);
      const playerCount = items.reduce((sum, item) => sum + item.requestedPlayerCount, 0);
      const lines = items.map((item, index) => formatRequirementLine(item, index, currency)).join('\n\n');
      return `### ${gameName} · ${playerCount} 位陪玩\n\n${lines}`;
    })
    .join('\n\n');
}

function formatRequirementLine(item: OrderRequirementSummary, index: number, currency: string): string {
  return [
    `**${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName} · ${item.regionDisplayName ?? '不限区服'}**`,
    `${formatRequirementDuration(item)} × ${item.requestedPlayerCount} 位 · ${formatCustomerMoney(item.estimatedLinePriceMinor, currency)}`,
    item.customerNote ? `偏好：${item.customerNote}` : '偏好：未填写',
    item.sourcePackageSlotId ? '来源：套餐席位' : '来源：单点'
  ].join('\n');
}

function buildRequirementComponents(input: {
  order: OrderSummary;
  page: OrderRequirementPageSummary;
  services: PublicServiceSummary[];
  requirements: OrderRequirementSummary[];
  selected?: OrderRequirementSummary;
  cursor?: string;
}): ActionRowSpec[] {
  const rows = input.selected ? selectedRequirementRows(input) : requirementListRows(input);
  rows.push(requirementFooterRow(input));
  if (input.selected) rows.push(selectedRequirementDangerRow(input.order, input.page, input.selected));
  else rows.push(...customerOrderUtilityRows(input.order));
  return rows;
}

function selectedRequirementRows(input: {
  order: OrderSummary;
  page: OrderRequirementPageSummary;
  services: PublicServiceSummary[];
  selected?: OrderRequirementSummary;
}): ActionRowSpec[] {
  const selected = input.selected!;
  return [
    {
      type: 'ACTION_ROW',
      components: [
        select(
          `bc:req:${input.order.id}:${selected.id}:project:v${input.page.orderVersion}:r${selected.version}`,
          `项目：${selected.gameDisplayName} · ${selected.serviceDisplayName}`,
          serviceOptions(
            input.order,
            input.services.filter((service) => service.game === selected.game)
          )
        )
      ]
    },
    {
      type: 'ACTION_ROW',
      components: [
        select(
          `bc:req:${input.order.id}:${selected.id}:units:v${input.page.orderVersion}:r${selected.version}`,
          `时长：${formatRequirementDuration(selected)}`,
          integerOptions(1, 12, selected.unitCount, (value) => `${(value * selected.billingUnitMinutes) / 60} 小时`)
        )
      ]
    },
    {
      type: 'ACTION_ROW',
      components: [
        select(
          `bc:req:${input.order.id}:${selected.id}:players:v${input.page.orderVersion}:r${selected.version}`,
          `需要 ${selected.requestedPlayerCount} 位陪玩`,
          integerOptions(1, 10, selected.requestedPlayerCount, (value) => `${value} 位陪玩`)
        )
      ]
    }
  ];
}

function requirementListRows(input: {
  order: OrderSummary;
  page: OrderRequirementPageSummary;
  requirements: OrderRequirementSummary[];
  cursor?: string;
}): ActionRowSpec[] {
  const rows: ActionRowSpec[] = [
    {
      type: 'ACTION_ROW',
      components: [
        select(
          `bc:req:${input.order.id}:edit:${input.cursor ?? 'first'}:v${input.page.orderVersion}`,
          '选择要修改的项目',
          requirementOptions(input.requirements),
          input.requirements.length === 0
        )
      ]
    }
  ];
  if (!input.cursor && !input.page.nextCursor) return rows;
  const buttons: ComponentSpec[] = [];
  if (input.cursor)
    buttons.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:req:${input.order.id}:page:first:v${input.page.orderVersion}`,
      label: '返回首页'
    });
  if (input.page.nextCursor)
    buttons.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:req:${input.order.id}:page:${input.page.nextCursor}:v${input.page.orderVersion}`,
      label: '下一页'
    });
  rows.push({ type: 'ACTION_ROW', components: buttons });
  return rows;
}

function requirementFooterRow(input: {
  order: OrderSummary;
  page: OrderRequirementPageSummary;
  requirements: OrderRequirementSummary[];
  selected?: OrderRequirementSummary;
}): ActionRowSpec {
  if (input.selected)
    return {
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:rno:${input.order.id}:${input.selected.id}:v${input.page.orderVersion}:r${input.selected.version}`,
          label: '填写这个席位的需求'
        },
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:req:${input.order.id}:back:v${input.page.orderVersion}`,
          label: '返回已选服务'
        },
        {
          type: 'BUTTON',
          style: 'PRIMARY',
          customId: `bc:order:${input.order.id}:submit:v${input.page.orderVersion}`,
          label: '核对订单与总价'
        }
      ]
    };
  const components: ComponentSpec[] = [
    {
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:package:${input.order.id}:open:v${input.page.orderVersion}`,
      label: '继续添加游戏或服务'
    }
  ];
  if (input.requirements.length)
    components.push({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:order:${input.order.id}:submit:v${input.page.orderVersion}`,
      label: '核对订单与总价'
    });
  return { type: 'ACTION_ROW', components };
}

function selectedRequirementDangerRow(
  order: OrderSummary,
  page: OrderRequirementPageSummary,
  selected: OrderRequirementSummary
): ActionRowSpec {
  return {
    type: 'ACTION_ROW',
    components: [
      {
        type: 'BUTTON',
        style: 'DANGER',
        customId: `bc:req:${order.id}:${selected.id}:remove:v${page.orderVersion}:r${selected.version}`,
        label: '删除这个服务项目'
      },
      { ...cancelOrderControl(order), label: '取消整张订单' }
    ]
  };
}

function orderCompositionLabel(mode: OrderSummary['compositionMode']): string {
  if (mode === 'PACKAGE_DEFAULT') return '套餐默认阵容';
  if (mode === 'CUSTOMIZED') return '已自定义阵容';
  return '自由搭配';
}

function formatRequirementPrice(page: OrderRequirementPageSummary, requirements: OrderRequirementSummary[]): string {
  const lines = [];
  if ((page.packageAdjustmentMinor ?? 0) !== 0)
    lines.push(
      `目录小计：${formatCustomerMoney(page.catalogSubtotalMinor ?? page.derivedTotalMinor, page.currency)}\n套餐调整：${formatCustomerMoney(page.packageAdjustmentMinor ?? 0, page.currency)}`
    );
  lines.push(
    `合计：${formatCustomerMoney(page.derivedTotalMinor, page.currency)}`,
    `共需 ${requirements.reduce((sum, item) => sum + item.requestedPlayerCount, 0)} 位陪玩`
  );
  return lines.join('\n');
}

export function buildServicePackagePickerMessage(order: OrderSummary, page: ServicePackagePageSummary): MessageSpec {
  return {
    title: `🎮 订单 #${order.publicId} · 选择套餐`,
    body: [
      '套餐会先展开成独立陪玩席位，应用后每个席位都能单独修改。',
      page.items.length ? '请选择一个套餐查看默认阵容和当前报价。' : '目前没有可用套餐，你仍可返回自由搭配。'
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
          }
        ]
      },
      ...customerOrderUtilityRows(order)
    ]
  };
}

export function buildGamePickerMessage(
  order: OrderSummary,
  services: PublicServiceSummary[],
  packages: ServicePackageSummary[] = []
): MessageSpec {
  const banner = resolveBlackcatWelcomeBanner();
  const games = [...new Map(services.map((item) => [item.game, item.gameDisplayName ?? item.game])).entries()].slice(
    0,
    20
  );
  const components: MessageComponentSpec[] = [
    {
      type: 'V2_MEDIA',
      url: banner.url,
      description: '黑猫陪玩 · 今晚想去哪个游戏世界'
    },
    ...games.map(([game, name]): MessageComponentSpec => ({
      type: 'V2_SECTION',
      content: `### ${name}  \`${game}\`\n${services.filter((item) => item.game === game).length} 个单点 · ${packages.filter((item) => item.game === game).length} 个套餐；进入后只显示本游戏目录。`,
      accessory: {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:game:${order.id}:${game}:open:v${order.version}`,
        label: '查看这个游戏'
      }
    }))
  ];
  if (order.amountMinor > 0)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:package:${order.id}:back:v${order.version}`,
          label: '查看已选服务'
        }
      ]
    });
  components.push(...customerOrderUtilityRows(order));
  return buildExperienceMessage({
    title: `订单 ${order.publicId} · 第 1/4 步 · 选择游戏`,
    icon: '🎮',
    introduction: games.length ? '像翻开一张菜单，先告诉黑猫今晚想去哪个游戏世界。' : '今天暂时没有可下单的游戏项目。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: games.length ? 'BRAND' : 'MUTED',
    coreFacts: [{ name: '🧭 下单进度', value: '第 1/4 步 · 选择游戏' }],
    nextStep: games.length
      ? '点击游戏右侧的“查看这个游戏”；下一页只显示该游戏的套餐和单点。'
      : '请稍后刷新，或联系猫舍前台了解开放时间。',
    components,
    layout: 'COMPONENTS_V2',
    attachments: [{ name: banner.attachmentName, path: banner.path }]
  });
}

export function buildGameOrderingMenuMessage(
  order: OrderSummary,
  game: string,
  services: PublicServiceSummary[],
  packages: ServicePackagePageSummary,
  selectedService?: PublicServiceSummary
): MessageSpec {
  const gameName = services[0]?.gameDisplayName ?? packages.items[0]?.gameDisplayName ?? game;
  const banner = resolveGameBanner(game, gameName);
  const components: MessageComponentSpec[] = [
    {
      type: 'V2_MEDIA',
      url: banner.url,
      description: `${gameName} × 黑猫陪玩主题横幅`
    },
    ...packages.items.slice(0, 20).map((item): MessageComponentSpec => ({
      type: 'V2_SECTION',
      content: `### ${item.displayName}\n${item.description}\n**${item.defaultCustomerPriceMinor === null ? '由目录实时计价' : formatCustomerMoney(item.defaultCustomerPriceMinor, item.currency)}** · ${item.slots.length} 个席位`,
      accessory: {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:package:${order.id}:${item.id}:preview:v${order.version}`,
        label: '查看套餐内容'
      }
    }))
  ];
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
          label: '加入这个单点服务'
        }
      ]
    });
  components.push({
    type: 'ACTION_ROW',
    components: [
      {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:omno:${order.id}:${game}:v${order.version}`,
        label: order.notes ? '修改需求备注' : '填写需求备注'
      },
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
              style: 'SECONDARY' as const,
              customId: `bc:package:${order.id}:back:v${order.version}`,
              label: '查看已选服务'
            }
          ]
        : [])
    ]
  });
  components.push(...customerOrderUtilityRows(order));
  return buildExperienceMessage({
    title: `订单 ${order.publicId} · 第 2/4 步 · ${gameName} 菜单`,
    icon: '🐾',
    introduction: '套餐适合快速开玩，单点适合自己搭配；这里的选项都只属于当前游戏。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: 'BRAND',
    coreFacts: [
      { name: '🧭 下单进度', value: '第 2/4 步 · 选择套餐或单点' },
      { name: '📚 当前目录', value: `${gameName} · ${packages.items.length} 个套餐 · ${services.length} 个单点` }
    ],
    bossRequest: order.notes || null,
    nextStep: '套餐点“查看套餐内容”确认阵容；单点先在菜单选择预览，再点“加入这个单点服务”。',
    components,
    layout: 'COMPONENTS_V2',
    attachments: [{ name: banner.attachmentName, path: banner.path }]
  });
}
