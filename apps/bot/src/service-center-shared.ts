import { botCopy } from './bot-copy.js';
import { formatUserFacingError } from './user-facing-error.js';
import {
  type BotApiClient,
  type OrderEstimateSummary,
  type OrderRequirementSummary,
  type OrderSummary,
  type PublicServiceSummary
} from './service-center-api.js';
import { type ActionRowSpec, type ComponentSpec, type MessageSpec } from './service-center-components.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, formatCustomerWalletAmount } from './wallet-display.js';

export function select(
  customId: string,
  placeholder: string,
  options: Array<{ label: string; value: string }>,
  disabled = false
): ComponentSpec {
  return { type: 'STRING_SELECT', customId, placeholder, options, disabled };
}

export function requirementOptions(requirements: OrderRequirementSummary[]): Array<{ label: string; value: string }> {
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

export function integerOptions(
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

export function formatRequirementDuration(
  requirement: Pick<OrderRequirementSummary, 'unitCount' | 'billingUnitMinutes'>
): string {
  const minutes = requirement.unitCount * requirement.billingUnitMinutes;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

export function requireOrderRequirementApi(api: BotApiClient) {
  if (!api.listOrderRequirements || !api.addOrderRequirement || !api.updateOrderRequirement)
    throw new Error('Order requirement API is unavailable.');
  return {
    list: api.listOrderRequirements.bind(api),
    add: api.addOrderRequirement.bind(api),
    update: api.updateOrderRequirement.bind(api)
  };
}
export function requirePackageApi(api: BotApiClient) {
  if (!api.listServicePackages || !api.previewServicePackage || !api.applyServicePackage)
    throw new Error('Service package API is unavailable.');
  return {
    list: api.listServicePackages.bind(api),
    preview: api.previewServicePackage.bind(api),
    apply: api.applyServicePackage.bind(api)
  };
}

export function customerOrderActionRows(order: OrderSummary): ActionRowSpec[] {
  const actions = (order.availableActions ?? []).filter((action) => action.enabled && action.role === 'CUSTOMER');
  const primary: ComponentSpec[] = [];
  const utility: ComponentSpec[] = [];
  if (actions.some((action) => action.key === 'CUSTOMER_CONFIRM_COMPLETION'))
    primary.push({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:service:confirm:${order.id}:v${order.version}`,
      label: '老板：确认服务完成'
    });
  if (actions.some((action) => action.key === 'CUSTOMER_SEND_GIFT'))
    utility.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:gift:open:${order.id}:v${order.version}`,
      label: '赠送礼物'
    });
  if (actions.some((action) => action.key === 'CUSTOMER_REFRESH_ORDER')) utility.push(refreshOrderControl(order.id));
  if (actions.some((action) => action.key === 'CUSTOMER_CONTACT_SUPPORT'))
    utility.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:service:support:${order.id}:v${order.version}`,
      label: '联系猫舍前台'
    });
  const rows: ActionRowSpec[] = [
    ...(primary.length ? [{ type: 'ACTION_ROW' as const, components: primary }] : []),
    ...(utility.length ? [{ type: 'ACTION_ROW' as const, components: utility.slice(0, 3) }] : [])
  ];
  const cancel = customerOrderUtilityRows(order).find((row) =>
    row.components.some(
      (component) => component.type === 'BUTTON' && component.customId.includes(`bc:order:${order.id}:cancel:`)
    )
  );
  if (cancel) rows.push(cancel);
  return rows;
}

export function refreshOrderControl(orderId: string): ComponentSpec {
  return {
    type: 'BUTTON',
    style: 'SECONDARY',
    customId: `bc:order:${orderId}:refresh`,
    label: '刷新最新状态'
  };
}

export function customerOrderUtilityRows(order: OrderSummary): ActionRowSpec[] {
  const actions = (order.availableActions ?? []).filter((action) => action.enabled && action.role === 'CUSTOMER');
  const utility: ComponentSpec[] = [];
  if (actions.some((action) => action.key === 'CUSTOMER_REFRESH_ORDER')) utility.push(refreshOrderControl(order.id));
  if (actions.some((action) => action.key === 'CUSTOMER_CONTACT_SUPPORT'))
    utility.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:service:support:${order.id}:v${order.version}`,
      label: '联系猫舍前台'
    });
  const rows: ActionRowSpec[] = utility.length ? [{ type: 'ACTION_ROW', components: utility }] : [];
  if (
    actions.some((action) =>
      ['CUSTOMER_CANCEL_ORDER', 'CUSTOMER_REQUEST_CANCELLATION', 'CUSTOMER_VIEW_CANCELLATION_STATUS'].includes(
        action.key
      )
    )
  )
    rows.push({ type: 'ACTION_ROW', components: [cancelOrderControl(order)] });
  return rows;
}

export function cancelOrderControl(order: OrderSummary): Extract<ComponentSpec, { type: 'BUTTON' }> {
  const action = (order.availableActions ?? []).find(
    (candidate) =>
      candidate.enabled &&
      candidate.role === 'CUSTOMER' &&
      ['CUSTOMER_CANCEL_ORDER', 'CUSTOMER_REQUEST_CANCELLATION', 'CUSTOMER_VIEW_CANCELLATION_STATUS'].includes(
        candidate.key
      )
  );
  return {
    type: 'BUTTON',
    style: action?.key === 'CUSTOMER_VIEW_CANCELLATION_STATUS' ? 'SECONDARY' : 'DANGER',
    customId: `bc:order:${order.id}:cancel:v${order.version}`,
    label:
      action?.key === 'CUSTOMER_REQUEST_CANCELLATION'
        ? '申请取消订单'
        : action?.key === 'CUSTOMER_VIEW_CANCELLATION_STATUS'
          ? '查看取消处理进度'
          : '取消订单'
  };
}

export function serviceOptions(
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

export function isApiError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

export function requestId(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'requestId' in error) {
    const value = (error as { requestId?: unknown }).requestId;
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return 'unknown';
}

export function formatApiError(error: unknown, operation: string): string {
  return formatUserFacingError(error, { operation });
}

export function lifecyclePermissionDeniedMessage(
  action: 'ready' | 'request-completion' | 'confirm' | 'support',
  id: string
): string {
  if (action === 'confirm') return botCopy.lifecycle.confirmationRestricted(id);
  if (action === 'request-completion') return botCopy.lifecycle.completionRequestRestricted(id);
  if (action === 'ready') return botCopy.lifecycle.readinessRestricted(id);
  return botCopy.lifecycle.supportRestricted(id);
}

export function formatGame(value: string | null): string {
  const labels: Record<string, string> = {
    VALORANT: '无畏契约',
    LEAGUE_OF_LEGENDS: '英雄联盟'
  };
  return value ? (labels[value] ?? value) : '未选择游戏';
}

export function formatService(value: string | null): string {
  const labels: Record<string, string> = {
    ENTERTAINMENT: '娱乐陪玩',
    RANKED: '上分陪玩'
  };
  return value ? (labels[value] ?? value) : '未选择服务';
}

export function formatRegion(value: string | null): string {
  const labels: Record<string, string> = {
    NA: '北美',
    CN: '国服'
  };
  return value ? (labels[value] ?? value) : '无指定区服';
}

export function formatDuration(order: OrderSummary): string {
  if (!order.billingUnitMinutes || !order.unitCount) {
    return '未选择时长';
  }
  const totalMinutes = order.billingUnitMinutes * order.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

export function formatEstimateDuration(estimate: OrderEstimateSummary): string {
  const totalMinutes = estimate.billingUnitMinutes * estimate.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

export function formatCustomerMoney(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Customer wallet display requires canonical CAT subunits.');
  return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
}

export function missingConfirmationFields(order: OrderSummary): string[] {
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

export function confirmationBlockedReason(input: {
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

export function buildIncompleteConfirmationMessage(order: OrderSummary): MessageSpec {
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
            label: '提交订单并预留猫条',
            disabled: true
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${order.id}:refresh`,
            label: '返回补全订单'
          }
        ]
      },
      ...customerOrderUtilityRows(order)
    ]
  };
}
