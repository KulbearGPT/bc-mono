export interface GiftPanelData {
  orderId: string;
  orderPublicId: string;
  receiver: { userId: string; displayName: string };
  balance: BalanceData;
  items: Array<{ id: string; code: string; name: string; priceMinor: number; currency: string; affordable: boolean }>;
}

export interface GiftRequestResult {
  id: string; publicId: string; orderId: string; senderId: string; receiverId: string;
  status: 'PENDING_REVIEW'; expiresAt: string;
  gift: { code: string; name: string; priceMinor: number; currency: string };
  reservation: { id: string; sourceType: 'GIFT'; status: string; amountMinor: number; currency: string; expiresAt: string };
  staffTask: { id: string; publicId: string; type: 'GIFT_REVIEW'; status: string };
  balance: BalanceData;
}

interface BalanceData {
  providerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: string;
  fetchedAt: string;
}

export function buildGiftPanel(data: GiftPanelData) {
  return {
    title: `订单 ${data.orderPublicId} · 赠送礼物`,
    targetLabel: data.receiver.displayName,
    availableMinor: data.balance.availableMinor,
    currency: data.balance.currency,
    options: data.items.map((item) => ({
      label: `${item.name} · ${formatMinor(item.priceMinor, item.currency)}`,
      value: item.id,
      disabled: !item.affordable
    })),
    actions: ['CONFIRM_GIFT', 'RECHARGE', 'BACK_TO_ORDER'] as const
  };
}

export function buildGiftRequestConfirmation(data: GiftRequestResult) {
  return {
    title: '送礼请求已提交',
    requestPublicId: data.publicId,
    statusLabel: '等待客服核对',
    giftName: data.gift.name,
    reservedMinor: data.reservation.amountMinor,
    capturedMinor: 0,
    availableMinor: data.balance.availableMinor,
    expiresAt: data.expiresAt
  };
}

function formatMinor(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amountMinor / 100);
}
