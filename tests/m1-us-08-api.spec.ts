import { describe,expect,test } from 'vitest';
import { InMemoryWalletStore,WalletService } from '@blackcat/api/wallet';

describe('M1-US-08 reusable internal reservation lifecycle',()=>{
  test('release restores available balance and appends no debit',async()=>{
    const now=new Date('2026-07-21T18:00:00Z');const userId='00000000-0000-0000-0000-000000001820';const service=new WalletService(new InMemoryWalletStore());
    await service.createTopUp({userId,amountMinor:500,paymentChannel:'cash',externalTransactionId:'m1_08',paidAt:now.toISOString(),note:'verified',idempotencyKey:'m1:08:t',actorStaffId:'00000000-0000-0000-0000-000000001821',actorLevel:'L1_SUPPORT',now});
    const held=await service.reserve({userId,sourceType:'ORDER',sourceId:'00000000-0000-0000-0000-000000001822',amountMinor:300,idempotencyKey:'m1:08:r',expiresAt:now,now});
    await service.release({reservationId:held.reservationId,expectedVersion:1,idempotencyKey:'m1:08:release',now});
    expect(await service.getBalance({userId,now})).toMatchObject({ledgerBalanceMinor:500,reservedMinor:0,availableMinor:500,currency:'USD'});
    expect(await service.listEntries({userId})).toHaveLength(1);
  });
});
