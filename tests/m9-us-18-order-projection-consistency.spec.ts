import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

function method(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

function expectTransactionalPanelSync(source: string, kind: string): void {
  expect(source).toContain('insertLifecyclePanelSync');
  expect(source).toContain(kind);
  expect(source.indexOf('insertLifecyclePanelSync')).toBeLessThan(source.lastIndexOf("query('COMMIT')"));
}

describe('M9-US-18 durable order projection consistency', () => {
  test('service lifecycle writes durable panel sync jobs for readiness and timeout changes', async () => {
    const source = await readFile('apps/api/src/service-lifecycle.ts', 'utf8');
    expect(method(source, 'async function insertLifecyclePanelSync', 'async function lockOrder')).toContain("'PANEL_SYNC'");
    expectTransactionalPanelSync(method(source, 'async commitReadiness(input:', 'async commitCompletionRequest(input:'), 'ORDER_READINESS_CHANNEL_SYNC');
    expectTransactionalPanelSync(method(source, 'async commitCompletionTimeout(input:', 'async commitReadinessTimeout(input:'), 'ORDER_COMPLETION_TIMEOUT_CHANNEL_SYNC');
    expectTransactionalPanelSync(method(source, 'async commitReadinessTimeout(input:', 'export async function rejectLegacyStartService'), 'ORDER_READINESS_TIMEOUT_CHANNEL_SYNC');
  });

  test('automation and cancellation transactions persist a panel sync alongside the order write', async () => {
    const source = await readFile('apps/api/src/orders.ts', 'utf8');
    const postgres = source.slice(source.indexOf('export class PostgresOrderStore'));
    const helper = method(source, 'async function insertOrderPanelSync', 'async function updateSubmittedOrder');
    expect(helper).toContain("'PANEL_SYNC'");
    expect(method(postgres, 'async commitAutomationControl(input:', 'async commitSubmit(input:')).toContain('ORDER_AUTOMATION_CHANNEL_SYNC');
    const cancel = method(postgres, 'async commitCancel(input:', 'const activeOrderStatuses');
    expect(cancel).toContain('insertOrderPanelSync');
    expect(cancel).toContain('ORDER_CANCELLED_CHANNEL_SYNC');
    expect(cancel.indexOf('insertOrderPanelSync')).toBeLessThan(cancel.indexOf("query('COMMIT')"));
  });

  test('staff resolution and reassignment transactions persist panel sync jobs', async () => {
    const source = await readFile('apps/api/src/admin-order-actions.ts', 'utf8');
    expect(method(source, 'async function insertAdminOrderPanelSync', 'function commitApproval')).toContain("'PANEL_SYNC'");
    expect(method(source, 'commitResolution(input:', 'commitReassignment(input:')).toContain('ORDER_RESOLVED_CHANNEL_SYNC');
    expect(method(source, 'commitReassignment(input:', 'private async withTransaction')).toContain('ORDER_REASSIGNED_CHANNEL_SYNC');
  });
});
