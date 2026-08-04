import type { ServiceCenterRoute } from './service-center-routes.js';

export function parseOrderActionsRoute(customId: string): ServiceCenterRoute | null {
  const orderAction = /^bc:order:([0-9a-f-]{36}):(submit|submit-final|cancel):v([1-9][0-9]*)$/u.exec(customId);
  if (orderAction) {
    return {
      area: 'order-action',
      orderId: orderAction[1],
      action: orderAction[2] as 'submit' | 'submit-final' | 'cancel',
      expectedVersion: Number.parseInt(orderAction[3], 10)
    };
  }

  const orderRefresh = /^bc:order:([0-9a-f-]{36}):refresh$/u.exec(customId);
  if (orderRefresh) return { area: 'order-refresh', orderId: orderRefresh[1]! };

  const serviceAction = /^bc:service:(ready|request-completion|confirm|support):([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(
    customId
  );
  if (serviceAction) {
    return {
      area: 'service-action',
      orderId: serviceAction[2],
      action: serviceAction[1] as 'ready' | 'request-completion' | 'confirm' | 'support',
      expectedVersion: Number.parseInt(serviceAction[3], 10)
    };
  }
  return null;
}
