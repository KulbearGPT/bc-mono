import {
  type BotActorContext,
  type BotApiClient,
  type OrderSummary,
  type ServicePackagePreviewSummary
} from './service-center-api.js';
import { type BotFlowResult, type MessageSpec } from './service-center-components.js';
import { buildExperienceMessage } from './discord-experience.js';
import { resolveGameBanner } from './game-banners.js';
import {
  buildOrderPanelMessage,
  buildMultiProjectOrderPanelMessage,
  buildGamePickerMessage,
  buildGameOrderingMenuMessage
} from './service-center-order-panels.js';
import { requirePackageApi, customerOrderUtilityRows, formatCustomerMoney } from './service-center-shared.js';

export function buildServicePackagePreviewMessage(order: OrderSummary, pkg: ServicePackagePreviewSummary): MessageSpec {
  const slots = pkg.slots
    .map(
      (slot) =>
        `**${slot.position}号位 · ${slot.gameDisplayName} · ${slot.serviceDisplayName}**${slot.regionDisplayName ? ` · ${slot.regionDisplayName}` : ''}\n${(slot.unitCount * slot.billingUnitMinutes) / 60} 小时${slot.customerNoteTemplate ? ` · ${slot.customerNoteTemplate}` : ''}`
    )
    .join('\n\n');
  const banner = resolveGameBanner(pkg.game, pkg.gameDisplayName);
  return buildExperienceMessage({
    title: `订单 ${order.publicId} · 第 2/4 步 · ${pkg.displayName} 套餐预览`,
    icon: '🐾',
    introduction: pkg.description,
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: 'BRAND',
    coreFacts: [
      { name: '🧭 下单进度', value: '第 2/4 步 · 预览套餐阵容' },
      { name: '🎧 套餐席位', value: slots },
      { name: '🐟 套餐报价', value: formatCustomerMoney(pkg.derivedTotalMinor, pkg.currency) }
    ],
    bossRequest: order.notes || null,
    nextStep: '采用后每个席位仍可单独调整；系统会按最终阵容重新报价。',
    components: [
      { type: 'V2_MEDIA', url: banner.url, description: `${pkg.gameDisplayName} × 黑猫陪玩主题横幅` },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:package:${order.id}:${pkg.id}:apply:v${order.version}`,
            label: '把此套餐加入订单'
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
                  label: '查看已选服务'
                }
              ]
            : [])
        ]
      },
      ...customerOrderUtilityRows(order)
    ],
    layout: 'COMPONENTS_V2',
    attachments: [{ name: banner.attachmentName, path: banner.path }]
  });
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
