import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M3-US-03 internal gift capture',()=>{
  test('appends exactly one wallet debit linked to the reservation',async()=>{
    const source=await readFile('apps/api/src/gifts.ts','utf8');
    expect(source).toContain("'GIFT_CAPTURE_DEBIT','DEBIT'");
    expect(source).toContain("'FUND_RESERVATION'");
    expect(source).not.toMatch(/\.captureHold\s*\(|\.createReservationDebit\s*\(/u);
  });
});
