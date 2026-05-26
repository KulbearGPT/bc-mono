import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M3-US-01 internal-wallet gift requests',()=>{
  test('uses wallet affordability and one local reservation',async()=>{
    const source=await readFile('apps/api/src/gifts.ts','utf8');
    expect(source).toContain('walletFunding.getBalance');
    expect(source).toContain("mode: FundReservationMode = 'LOCAL_RESERVATION'");
    expect(source).toContain('ledgerBalanceMinor');
    expect(source).not.toMatch(/\.getProviderBalance\s*\(|\.createHold\s*\(/u);
  });
});
