import { describe, expect, test } from 'vitest';
import { InMemoryWalletStore, WalletService } from '@blackcat/api/wallet';

const now=new Date('2026-07-21T18:00:00Z');
const userId='00000000-0000-0000-0000-000000007501';
const staffId='00000000-0000-0000-0000-000000007502';

describe('M7-US-05 wallet funding lifecycle',()=>{
  test('reserves, captures once, releases without debit, and credits business refund without Provider calls',async()=>{
    const providerCalls:string[]=[];
    const wallet=new WalletService(new InMemoryWalletStore());
    await wallet.createTopUp({userId,amountMinor:1_000_000,paymentChannel:'stripe',externalTransactionId:'pi_m7_05',paidAt:now.toISOString(),
      note:'checked',idempotencyKey:'m7:05:topup:0001',actorStaffId:staffId,actorLevel:'L2_SUPERVISOR',now});
    const order=await wallet.reserve({userId,sourceType:'ORDER',sourceId:'00000000-0000-0000-0000-000000007503',amountMinor:120_000,
      idempotencyKey:'m7:05:reserve:order',expiresAt:new Date(now.getTime()+60_000),now});
    expect(order.balance).toMatchObject({ledgerBalanceMinor:1_000_000,reservedMinor:120_000,availableMinor:880_000,currency:'USD'});
    const captured=await wallet.capture({reservationId:order.reservationId,expectedVersion:1,idempotencyKey:'m7:05:capture:order',now});
    expect(captured.balance).toMatchObject({ledgerBalanceMinor:880_000,reservedMinor:0,availableMinor:880_000});
    expect(await wallet.capture({reservationId:order.reservationId,expectedVersion:1,idempotencyKey:'m7:05:capture:order',now})).toEqual(captured);
    const gift=await wallet.reserve({userId,sourceType:'GIFT',sourceId:'00000000-0000-0000-0000-000000007504',amountMinor:20_000,
      idempotencyKey:'m7:05:reserve:gift',expiresAt:new Date(now.getTime()+60_000),now});
    await wallet.release({reservationId:gift.reservationId,expectedVersion:1,idempotencyKey:'m7:05:release:gift',now});
    expect((await wallet.getBalance({userId,now})).ledgerBalanceMinor).toBe(880_000);
    await wallet.creditBusinessRefund({userId,orderId:'00000000-0000-0000-0000-000000007503',refundId:'00000000-0000-0000-0000-000000007505',
      amountMinor:30_000,idempotencyKey:'m7:05:refund:order',now});
    expect(await wallet.getBalance({userId,now})).toMatchObject({ledgerBalanceMinor:910_000,availableMinor:910_000,currency:'USD'});
    expect(providerCalls).toEqual([]);
  });
});
