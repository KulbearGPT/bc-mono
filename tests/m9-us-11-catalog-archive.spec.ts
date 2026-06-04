import { describe, expect, test } from 'vitest';
import { InMemoryServiceCatalogStore, prepareUpdateServiceCatalogVersion, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import { InMemoryAdminDirectoryStore } from '@blackcat/api/admin-directory';
import { InMemoryAuditSink } from '@blackcat/api/security';

const now=new Date('2026-08-02T22:00:00Z');

describe('M9-US-11 catalog archival',()=>{
  test('archives a service offering without deleting its historical version',async()=>{
    const record:ServiceCatalogRecord={id:'service-v1',offeringKey:'VALORANT|FUN|NA',game:'VALORANT',service:'FUN',region:'NA',billingUnitMinutes:60,minimumUnits:1,customerUnitPriceMinor:20,playerUnitPayoutMinor:12,defaultPlayerPayoutBps:6000,currency:'CAT',status:'ACTIVE',version:1,createdByStaffId:'staff-1',createdAt:now.toISOString(),activatedAt:now.toISOString(),retiredAt:null,archivedAt:null};
    const store=new InMemoryServiceCatalogStore({records:[record]});
    const prepared=await prepareUpdateServiceCatalogVersion({store,actor:{actorLevel:'L3_OPERATIONS',actorStaffId:'staff-1'} as never,serviceCatalogId:record.id,input:{expectedVersion:1,action:'ARCHIVE',reasonCode:'NO_LONGER_SOLD'},now});
    await store.commit!({records:prepared.records,auditRecord:{id:'audit-1'} as never,auditSink:new InMemoryAuditSink()});
    expect(await store.listPage({cursor:null,limit:10} as never)).toMatchObject({items:[]});
    expect(await store.getById(record.id)).toMatchObject({id:record.id,status:'RETIRED',archivedAt:now.toISOString()});
  });

  test('archives a gift from listings while retaining the versioned record',async()=>{
    const store=new InMemoryAdminDirectoryStore({orders:[],users:[],players:[],consumptions:[],giftRequests:[],gifts:[{id:'gift-1',code:'ROCKET',name:'火箭',priceMinor:50,currency:'CAT',enabled:true,version:2,broadcastTemplate:'{gift}',createdAt:now.toISOString()}]});
    const write=await store.updateGiftCatalog({giftCatalogId:'gift-1',expectedVersion:2,action:'ARCHIVE',replacement:null,reasonCode:'NO_LONGER_SOLD',actorStaffId:'staff-1',now});
    await write.commit({id:'audit-2'} as never,new InMemoryAuditSink());
    expect(store.gifts[0]).toMatchObject({id:'gift-1',archived:true,enabled:false});
    expect(store.listGiftCatalog({cursor:null,limit:10})).toMatchObject({items:[]});
  });
});
