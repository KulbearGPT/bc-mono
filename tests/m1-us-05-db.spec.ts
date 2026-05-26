import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M1-US-05 PostgreSQL internal reservation transaction',()=>{
  test('locks the wallet and rechecks ledger balance in the order commit transaction',async()=>{
    const source=await readFile('apps/api/src/orders.ts','utf8');
    expect(source).toContain("SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE");
    expect(source).toContain("FROM wallet_entries WHERE wallet_account_id=$1");
    expect(source).toMatch(/insertFundReservation\(transactionClient, input\.reservation\)[\s\S]*insertAuditRecord\(transactionClient, input\.auditRecord\)[\s\S]*COMMIT/u);
  });
});
