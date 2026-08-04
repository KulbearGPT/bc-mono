import type { ServiceCenterRoute } from './service-center-routes.js';

export function parseOrderBaseRoute(customId: string): ServiceCenterRoute | null {
  const orderOpen = /^bc:order:([0-9a-f-]{36}):open$/u.exec(customId);
  if (orderOpen) return { area: 'order-open', orderId: orderOpen[1]! };

  const cancellationAction = /^bc:cancel:([0-9a-f-]{36}):([0-9a-f-]{36}):confirm:v([1-9][0-9]*)$/u.exec(customId);
  if (cancellationAction) {
    return {
      area: 'cancellation-action',
      action: 'confirm',
      orderId: cancellationAction[1],
      previewId: cancellationAction[2],
      expectedVersion: Number.parseInt(cancellationAction[3], 10)
    };
  }

  const orderSelect = /^bc:select:order:([0-9a-f-]{36}):(catalog|duration|preferred-players):v([1-9][0-9]*)$/u.exec(
    customId
  );
  if (orderSelect) {
    return {
      area: 'order-select',
      orderId: orderSelect[1],
      field: orderSelect[2] as 'catalog' | 'duration' | 'preferred-players',
      expectedVersion: Number.parseInt(orderSelect[3], 10)
    };
  }
  return null;
}
