import { BOT_COPY } from './bot-copy.js';
import { buildExperienceMessage } from './discord-experience.js';
import { orderStatusDisplay } from './order-display.js';
import type { OrderReservationSummaryResult } from './service-center-api.js';
import type { MessageSpec } from './service-center-components.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, formatCustomerWalletAmount } from './wallet-display.js';

export function buildSubmittedOrderMessage(input: OrderReservationSummaryResult): MessageSpec {
  return buildExperienceMessage({
    title: '订单已提交 · 开始招募陪玩',
    icon: '🐾',
    introduction: '委托已经保存，猫条还没有产生正式消费；现在由你决定何时开始招募。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: 'BRAND',
    coreFacts: [
      { name: '📋 订单状态', value: orderStatusDisplay(input.status) },
      {
        name: '🐟 资金状态',
        value: [
          `本单预留：${formatMoney(input.reservation.amountMinor, input.reservation.currency)}`,
          `预留状态：${input.reservation.status}`,
          `提交后可用：${formatMoney(input.balance.availableMinor, input.balance.currency)}`,
          `全部预留：${formatMoney(input.balance.reservedMinor, input.balance.currency)}`,
          BOT_COPY.orders.reservationOnly
        ].join('\n')
      }
    ],
    progress: '等待老板开始招募',
    nextStep: '点击“开始招募”发布报名卡；招募不会自动结束，请在合适时手动点击“终止招募”。',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:sp:new:${input.orderId}:o${input.version}`,
            label: '开始招募'
          }
        ]
      },
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
  });
}

function formatMoney(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Customer wallet display requires canonical CAT subunits.');
  return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
}
