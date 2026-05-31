import { describe,expect,test } from 'vitest';
import { getAdminCustomerProfileSummary,InMemoryCustomerProfileStore } from '@blackcat/api/customer-profiles';
import { InMemoryWalletStore,WalletService } from '@blackcat/api/wallet';

const now=new Date('2026-07-21T18:00:00Z');
const userId='00000000-0000-0000-0000-000000006401';

describe('M6-US-04 internal wallet customer profile',()=>{
  test('returns wallet balance and server-side statistics without Provider fallback fields',async()=>{
    const store=new InMemoryCustomerProfileStore({users:[{id:userId,guildId:'guild-1',discordUserId:'discord-user',displayName:'Customer',status:'ACTIVE',provider:'legacy',externalUserId:'legacy-id'}]});
    const wallet=new WalletService(new InMemoryWalletStore());
    await wallet.createTopUp({userId,amountMinor:50_000,paymentChannel:'CASH',externalTransactionId:'m6_04',paidAt:now.toISOString(),note:'verified',idempotencyKey:'m6:04:topup',actorStaffId:'00000000-0000-0000-0000-000000006402',actorLevel:'L2_SUPERVISOR',now});
    const result=await getAdminCustomerProfileSummary({store,walletFunding:wallet,userId,window:'ALL',now,actor:{actorId:'00000000-0000-0000-0000-000000006403',actorUserId:null,
      actorStaffId:'00000000-0000-0000-0000-000000006402',actorLevel:'L2_SUPERVISOR',actorSource:'DASHBOARD',clientId:'DASHBOARD',guildId:'guild-1',discordUserId:'staff-discord',interactionId:null,permissionsVersion:1}});
    expect(result.balance).toMatchObject({ledgerBalanceMinor:50_000,reservedMinor:0,availableMinor:50_000,currency:'CAT'});
    expect(JSON.stringify(result)).not.toMatch(/providerBalanceMinor|providerError|fetchedAt|stale/u);
  });
});
