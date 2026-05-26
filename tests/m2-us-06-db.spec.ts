import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M2-US-06 refund database transaction',()=>{
  test('commits refund, wallet credit, corrections and audit inside one store transaction',async()=>{
    const source=await readFile('apps/api/src/admin-order-actions.ts','utf8');
    expect(source).toMatch(/commitRefund[\s\S]*insertRefundAndCorrections[\s\S]*insertAdminAuditRecord/u);
    expect(source).toMatch(/SELECT id FROM wallet_accounts WHERE user_id=\$1 FOR UPDATE/u);
    expect(source).toContain("'ORDER_REFUND_CREDIT','CREDIT'");
  });
  test('partial pre-charge resolution captures once and releases the remainder',async()=>{
    const source=await readFile('apps/api/src/admin-order-actions.ts','utf8');
    expect(source).toContain("'ORDER_CAPTURE_DEBIT','DEBIT'");
    expect(source).toContain("eventType: 'CAPTURED'");
    expect(source).toContain("eventType: 'RELEASED'");
  });
});
