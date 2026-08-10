import type { ServiceCenterRoute } from './service-center-routes.js';

export function parseSupportGiftProfileRoute(customId: string): ServiceCenterRoute | null {
  return parseSupportGiftRoute(customId) ?? parseProfileEntryRoute(customId);
}

function parseSupportGiftRoute(customId: string): ServiceCenterRoute | null {
  if (customId === 'bc:g2:o') return { area: 'standalone-gift', action: 'open' };
  if (customId === 'bc:g2:b') return { area: 'standalone-gift', action: 'back' };
  if (customId === 'bc:g2:r') return { area: 'standalone-gift-recipient-select' };
  if (customId === 'bc:g2:g') return { area: 'standalone-gift-catalog-select' };
  const standaloneGiftAction = /^bc:g2:([fpa]):(s1_[A-Za-z0-9_-]{80})$/u.exec(customId);
  if (standaloneGiftAction)
    return {
      area: 'standalone-gift',
      action:
        standaloneGiftAction[1] === 'f'
          ? 'refresh'
          : standaloneGiftAction[1] === 'p'
            ? 'confirm-public'
            : 'confirm-anonymous',
      token: standaloneGiftAction[2]!
    };
  const ratingStart = /^bc:support-rating:([0-9a-f-]{36}):start$/u.exec(customId);
  if (ratingStart)
    return {
      area: 'support-rating',
      orderId: ratingStart[1]!,
      score: null,
      reason: null
    };
  const rating = /^bc:support-rating:([0-9a-f-]{36}):s([1-5])(?::r([A-Z_]+))?$/u.exec(customId);
  if (rating)
    return {
      area: 'support-rating',
      orderId: rating[1]!,
      score: Number(rating[2]),
      reason: rating[3] ?? null
    };
  const ratingComment = /^bc:support-rating-comment:([0-9a-f-]{36}):s([12])$/u.exec(customId);
  if (ratingComment)
    return {
      area: 'support-rating-comment',
      orderId: ratingComment[1]!,
      score: Number(ratingComment[2]) as 1 | 2
    };
  const giftOpen = /^bc:gift:open:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (giftOpen)
    return {
      area: 'gift',
      action: 'open',
      orderId: giftOpen[1]!,
      expectedVersion: Number(giftOpen[2])
    };
  const giftAction = /^bc:gift:(select|refresh|confirm|back):(g1_[A-Za-z0-9_-]{80})$/u.exec(customId);
  if (giftAction)
    return {
      area: 'gift',
      action: giftAction[1] as 'select' | 'refresh' | 'confirm' | 'back',
      token: giftAction[2]!
    };
  const giftRecipients = /^bc:grs:([0-9a-f-]{36}):([0-9]+):v([1-9][0-9]*):([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftRecipients)
    return {
      area: 'gift-recipient-select',
      orderId: giftRecipients[1]!,
      page: Number(giftRecipients[2]),
      expectedVersion: Number(giftRecipients[3]),
      selection: giftRecipients[4]!
    };
  const giftCatalog = /^bc:gc:([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftCatalog) return { area: 'gift-catalog-select', selection: giftCatalog[1]! };
  const giftRecipientPage = /^bc:grp:([0-9a-f-]{36}):([0-9]+):v([1-9][0-9]*):([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftRecipientPage)
    return {
      area: 'gift-recipient-page',
      orderId: giftRecipientPage[1]!,
      page: Number(giftRecipientPage[2]),
      expectedVersion: Number(giftRecipientPage[3]),
      selection: giftRecipientPage[4]!
    };
  return null;
}

function parseProfileEntryRoute(customId: string): ServiceCenterRoute | null {
  if (customId === 'bc:profile:open' || customId === 'bc:profile:refresh') {
    return {
      area: 'profile',
      action: customId.endsWith('refresh') ? 'refresh' : 'open'
    };
  }
  const profilePage = /^bc:profile:(orders|consumptions):(first|end|c1_[A-Za-z0-9_-]{20,70})$/u.exec(customId);
  if (profilePage) {
    return {
      area: 'profile',
      action: profilePage[1] as 'orders' | 'consumptions',
      cursor: profilePage[2] === 'first' || profilePage[2] === 'end' ? undefined : profilePage[2]
    };
  }
  const reportList = /^bc:reports:list:(first|end|c1_[A-Za-z0-9_-]{20,70})$/u.exec(customId);
  if (reportList) {
    return {
      area: 'reports',
      action: 'list',
      cursor: reportList[1] === 'first' || reportList[1] === 'end' ? undefined : reportList[1]
    };
  }
  const reportDetail = /^bc:reports:detail:([0-9a-f-]{36})$/u.exec(customId);
  if (reportDetail) return { area: 'reports', action: 'detail', reportId: reportDetail[1] };
  if (customId === 'bc:entry:create-order') {
    return { area: 'entry', action: 'create-order' };
  }
  if (customId === 'bc:entry:service-center') {
    return { area: 'entry', action: 'service-center' };
  }
  if (customId === 'bc:entry:player-workbench') {
    return { area: 'entry', action: 'player-workbench' };
  }
  if (customId === 'bc:service-center:commissions' || customId === 'bc:service-center:recharge') {
    return {
      area: 'service-center-action',
      action: customId.endsWith('commissions') ? 'commissions' : 'recharge'
    };
  }
  return null;
}
