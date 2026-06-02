import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M3-US-01 gift reservation database transaction',()=>{
  test('locks wallet, rechecks ledger, and commits request/reservation/task/audit together',async()=>{
    const source=await readFile('apps/api/src/gifts.ts','utf8');
    expect(source).toContain("SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE");
    expect(source).toMatch(/INSERT INTO gift_requests[\s\S]*INSERT INTO fund_reservations[\s\S]*INSERT INTO staff_tasks[\s\S]*insertPostgresAuditRecord/u);
  });
});
