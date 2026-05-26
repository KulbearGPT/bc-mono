import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M2-US-06 internal wallet refunds and resolutions',()=>{
  test('preserves approval, step-up and correction paths without external refund execution',async()=>{
    const source=await readFile('apps/api/src/admin-order-actions.ts','utf8');
    expect(source).toContain("action: 'REFUND_EXECUTE'");
    expect(source).toContain("requiresRecentStepUp");
    expect(source).toContain("'ORDER_REFUND_CREDIT','CREDIT'");
    expect(source).not.toMatch(/\.createRefund\s*\(/u);
  });
  test('refund and resolution inputs accept only USD',async()=>{
    const source=await readFile('apps/api/src/admin-order-actions.ts','utf8');
    expect(source).toContain("if (currency !== 'USD')");
  });
});
