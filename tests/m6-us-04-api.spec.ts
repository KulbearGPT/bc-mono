import { describe,expect,test } from 'vitest';
import { appendAdminCustomerProfileNote,getAdminCustomerProfileSummary,InMemoryCustomerProfileStore } from '@blackcat/api/customer-profiles';
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

  test('appends immutable notes for an assigned L1 customer and same-Guild L2 customer',async()=>{
    const assignedOrder={id:'order-assigned',publicId:'P-ASSIGNED',customerId:userId,guildId:'guild-1',status:'ACCEPTED',gameKey:null,serviceKey:null,
      playerUserId:null,playerDisplayName:null,amountMinor:1_000,currency:'CAT',createdAt:now.toISOString(),completedAt:null,assignedStaffIds:['staff-l1']};
    const store=new InMemoryCustomerProfileStore({
      users:[{id:userId,guildId:'guild-1',discordUserId:'discord-user',displayName:'Customer',status:'ACTIVE'}],orders:[assignedOrder]
    });
    const l1=actor('staff-l1','L1_SUPPORT');
    const first=await appendAdminCustomerProfileNote({store,actor:l1,userId,body:'  老板游戏中掉线，稍后回访  ',now});
    expect(first).toMatchObject({text:'老板游戏中掉线，稍后回访',createdAt:now.toISOString()});
    const second=await appendAdminCustomerProfileNote({store,actor:actor('staff-l2','L2_SUPERVISOR'),userId,body:'已完成回访',now:new Date(now.getTime()+1_000)});
    expect(second.text).toBe('已完成回访');
    const summary=await store.getSummaryData({userId,actorStaffId:'staff-l1',actorLevel:'L1_SUPPORT',guildId:'guild-1',window:'ALL',now:new Date(now.getTime()+2_000)});
    expect(summary?.internalNotes.map((note)=>note.text)).toEqual(['已完成回访','老板游戏中掉线，稍后回访']);
    expect(JSON.stringify(summary?.internalNotes)).not.toContain('staff-l1');
  });

  test('rejects invalid notes and hides unassigned L1 customers',async()=>{
    const store=new InMemoryCustomerProfileStore({users:[{id:userId,guildId:'guild-1',discordUserId:'discord-user',displayName:'Customer',status:'ACTIVE'}]});
    await expect(appendAdminCustomerProfileNote({store,actor:actor('staff-l1','L1_SUPPORT'),userId,body:'follow up',now})).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(appendAdminCustomerProfileNote({store,actor:actor('staff-l2','L2_SUPERVISOR'),userId,body:'   ',now})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await expect(appendAdminCustomerProfileNote({store,actor:actor('staff-l2','L2_SUPERVISOR'),userId,body:'x'.repeat(2001),now})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  });
});

function actor(actorStaffId:string,actorLevel:'L1_SUPPORT'|'L2_SUPERVISOR'){
  return {actorId:actorStaffId,actorUserId:null,actorStaffId,actorLevel,actorSource:'DASHBOARD' as const,clientId:'DASHBOARD',guildId:'guild-1',discordUserId:'staff-discord',interactionId:null,permissionsVersion:1};
}
