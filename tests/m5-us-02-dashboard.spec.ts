import { describe, expect, test } from 'vitest';
import {
  buildPanelRepairControl,
  buildPanelRepairRequest
} from '../apps/dashboard/src/operations.js';

describe('M5-US-02 Dashboard panel recovery', () => {
  test('shows the repair control only with job.retry', () => {
    expect(buildPanelRepairControl(['job.read', 'job.retry'], false)).toEqual({ visible: true, enabled: true });
    expect(buildPanelRepairControl(['job.read', 'job.retry'], true)).toEqual({ visible: true, enabled: false });
    expect(buildPanelRepairControl(['job.read'], false)).toEqual({ visible: false, enabled: false });
  });

  test('maps a valid order id to the unified panel repair API', () => {
    expect(buildPanelRepairRequest(
      '00000000-0000-0000-0000-000000008001',
      'PANEL_MESSAGE_DELETED',
      'Discord message was deleted.'
    )).toEqual({
      method: 'POST',
      path: '/api/v1/admin/orders/00000000-0000-0000-0000-000000008001/panel-repair',
      body: { reasonCode: 'PANEL_MESSAGE_DELETED', note: 'Discord message was deleted.' }
    });
    expect(() => buildPanelRepairRequest('not-an-order-id', 'PANEL_MESSAGE_DELETED')).toThrow(/orderId/);
  });
});
