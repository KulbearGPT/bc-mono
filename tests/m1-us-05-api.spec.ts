import { describe, expect, test } from 'vitest';
import { InMemoryWalletStore, WalletService } from '@blackcat/api/wallet';

describe('M1-US-05 internal wallet reservation contract',()=>{
  test('submits against one USD balance fact without capturing funds',async()=>{
    const now=new Date('2026-07-21T18:00:00Z');const userId='00000000-0000-0000-0000-000000001505';
    const wallet=new WalletService(new InMemoryWalletStore());
    await wallet.createTopUp({userId,amountMinor:200_000,paymentChannel:'ZELLE',externalTransactionId:'pi_m1_05',paidAt:now.toISOString(),note:'verified',
      idempotencyKey:'m1:05:topup',actorStaffId:'00000000-0000-0000-0000-000000001506',actorLevel:'L2_SUPERVISOR',now});
    const reserved=await wallet.reserve({userId,sourceType:'ORDER',sourceId:'00000000-0000-0000-0000-000000001507',amountMinor:120_000,
      idempotencyKey:'m1:05:reserve',expiresAt:new Date(now.getTime()+1_800_000),now});
    expect(reserved.balance).toMatchObject({ledgerBalanceMinor:200_000,reservedMinor:120_000,availableMinor:80_000,currency:'CAT'});
    expect((await wallet.listEntries({userId})).map(item=>item.entryType)).toEqual(['TOP_UP_CREDIT']);
  });

  test('rejects a competing reservation that exceeds available balance',async()=>{
    const now=new Date('2026-07-21T18:00:00Z');const userId='00000000-0000-0000-0000-000000001515';
    const wallet=new WalletService(new InMemoryWalletStore());
    await wallet.createTopUp({userId,amountMinor:100,paymentChannel:'CASH',externalTransactionId:'cash_m1_05',paidAt:now.toISOString(),note:'verified',
      idempotencyKey:'m1:05:topup:2',actorStaffId:'00000000-0000-0000-0000-000000001516',actorLevel:'L2_SUPERVISOR',now});
    await wallet.reserve({userId,sourceType:'ORDER',sourceId:'00000000-0000-0000-0000-000000001517',amountMinor:80,idempotencyKey:'m1:05:r1',expiresAt:now,now});
    await expect(wallet.reserve({userId,sourceType:'ORDER',sourceId:'00000000-0000-0000-0000-000000001518',amountMinor:21,idempotencyKey:'m1:05:r2',expiresAt:now,now}))
      .rejects.toMatchObject({code:'INSUFFICIENT_AVAILABLE_BALANCE'});
  });
});
