import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';
import { buildCurrentWalletMessage } from '@blackcat/bot/service-center';
import { buildGiftAffordabilityMessage } from '@blackcat/bot/gifts';

describe('M7-US-06 Discord internal wallet',()=>{
  test('renders internal balances ephemerally and directs insufficient funds to support',()=>{
    const wallet=buildCurrentWalletMessage({ledgerBalanceMinor:100_000,reservedMinor:12_000,availableMinor:88_000,currency:'CAT',calculatedAt:'2026-07-21T18:00:00Z',version:3});
    expect(wallet.visibility).toBe('EPHEMERAL');expect(wallet.body).toContain('10,000.0 CAT');expect(wallet.body).toContain('1,200.0 CAT');expect(wallet.body).toContain('8,800.0 CAT');
    const gift=buildGiftAffordabilityMessage({giftCatalogVersionId:'x',catalogVersion:1,priceMinor:100_000,ledgerBalanceMinor:90_000,reservedMinor:0,availableMinor:90_000,shortfallMinor:10_000,currency:'CAT',calculatedAt:'2026-07-21T18:00:00Z',stale:false,canAfford:false,topUpInstructions:'联系客服并提交付款 receipt。'},'token');
    expect(JSON.stringify(gift.fields)).toMatch(/联系客服.*receipt/u);expect(JSON.stringify(gift)).not.toMatch(/LINK_BUTTON|前往充值|https?:\/\//u);
  });
  test('removes the binding modal and handler',async()=>{
    const [center,modal]=await Promise.all([readFile('apps/bot/src/service-center.ts','utf8'),readFile('apps/bot/src/pieces/interaction-handlers/service-center-modals.ts','utf8')]);
    expect(center).not.toMatch(/binding-modal|modal:binding|bindingCode/u);expect(modal).not.toMatch(/binding-modal/u);
  });
});
