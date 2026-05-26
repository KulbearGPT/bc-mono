import { describe, expect, test } from 'vitest';

describe('M7-US-05 runtime funding migration',()=>{
  test('does not execute Provider funding operations in migrated domains',async()=>{
    const sources=await Promise.all(['orders.ts','gifts.ts','admin-order-actions.ts','service-lifecycle.ts','customer-profiles.ts','transaction-timeline.ts','dashboard-metrics.ts','settlements.ts']
      .map((name)=>import('node:fs/promises').then(fs=>fs.readFile(`apps/api/src/${name}`,'utf8'))));
    expect(sources.join('\n')).not.toMatch(/\.(?:getProviderBalance|createHold|captureHold|releaseHold|createReservationDebit|createRefund)\s*\(/u);
    expect(sources.join('\n')).not.toMatch(/PROVIDER_BALANCE_SNAPSHOT|'CNY'/u);
    const [orders,gifts,,,,timeline]=sources;
    expect(orders).toMatch(/ledgerBalanceMinor/u);
    expect(gifts).toMatch(/ledgerBalanceMinor/u);
    expect(timeline).toMatch(/'WALLET_ENTRY'/u);
  });
});
