import { describe,expect,test } from 'vitest';
import { InMemoryWalletStore,WalletService,resolveWalletActorUserId } from '@blackcat/api/wallet';
import { buildWalletRequest,formatWalletMoney } from '@blackcat/dashboard/customer-wallet';
import { formatCustomerWalletAmount,parseWalletDisplayConfig } from '@blackcat/bot/wallet-display';

const now=new Date('2026-08-02T12:00:00.000Z'),userId='00000000-0000-0000-0000-000000009401',staffId='00000000-0000-0000-0000-000000009402';
describe('M9-US-04 fixed USD receipt to CAT wallet conversion',()=>{
  test('one USD cent credits one CAT subunit and keeps USD only in receipt evidence',async()=>{const wallet=new WalletService(new InMemoryWalletStore());const result=await wallet.createTopUp({
      userId,amountMinor:2550,paymentChannel:'ZELLE',externalTransactionId:'receipt-2550',paidAt:now.toISOString(),note:'Zelle receipt checked',reasonCode:'MANUAL_TOP_UP',
      idempotencyKey:'m9:topup:receipt:2550',actorStaffId:staffId,actorLevel:'L2_SUPERVISOR',now});
    expect(result).toMatchObject({paidAmountUsdCents:2550,paidCurrency:'USD',rateCatPerUsd:10,creditedCatSubunits:2550,currency:'CAT',balance:{availableMinor:2550,currency:'CAT'}});
    expect(formatCustomerWalletAmount(result.balance.availableMinor)).toBe('255.0 CAT');expect(formatWalletMoney(2550)).toBe('255.0 猫条');});

  test('Dashboard sends fixed fields without a selectable currency or rate',()=>{const request=buildWalletRequest('TOP_UP',userId,{amountMinor:2550,paymentChannel:'PAYPAL',externalTransactionId:'paypal-1',
      occurredAt:now.toISOString(),note:'receipt',reasonCode:'MANUAL_TOP_UP'});expect(request.body).toEqual({paidAmountUsdCents:2550,paidCurrency:'USD',paymentMethod:'PAYPAL',receiptNumber:'paypal-1',paidAt:now.toISOString(),note:'receipt',reasonCode:'MANUAL_TOP_UP'});
    expect(request.body).not.toHaveProperty('currency');expect(request.body).not.toHaveProperty('rateCatPerUsd');});

  test('wallet display is fixed and rejects legacy configurable token branding',()=>{expect(parseWalletDisplayConfig({})).toEqual({displayName:'猫条',symbol:'CAT',subunitsPerCat:10});
    expect(()=>parseWalletDisplayConfig({WALLET_DISPLAY_SYMBOL:'CAT'})).toThrow(/fixed/u);});

  test('Discord customers resolve their wallet through the trusted Guild account binding',async()=>{
    const findByDiscord=async()=>({userId,guildId:'1533309755873955880',discordUserId:'1349164563869859955',status:'ACTIVE' as const,version:1});
    await expect(resolveWalletActorUserId({actorUserId:null,guildId:'1533309755873955880',discordUserId:'1349164563869859955'}, {findByDiscord})).resolves.toBe(userId);
  });
});
