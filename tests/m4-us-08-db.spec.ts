import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M4-US-08 wallet transaction timeline projection',()=>{
  test('projects wallet capture and refund entries instead of Provider snapshots',async()=>{
    const source=await readFile('apps/api/src/transaction-timeline.ts','utf8');
    expect(source).toContain("'WALLET_ENTRY'");
    expect(source).toContain('FROM wallet_entries');
    expect(source).not.toContain('PROVIDER_BALANCE_SNAPSHOT');
  });
});
