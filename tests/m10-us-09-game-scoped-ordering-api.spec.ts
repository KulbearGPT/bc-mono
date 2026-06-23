import { describe, expect, test } from 'vitest';
import { InMemoryOrderRequirementStore } from '@blackcat/api/order-requirements';
import { InMemoryServicePackageStore, ServicePackageError, type ServicePackageVersionRecord } from '@blackcat/api/service-packages';

const orderId = '00000000-0000-0000-0000-000000109001';
const guildId = '999999999999999999';
const customerDiscordUserId = '111111111111111111';

describe('M10-US-09 game-scoped ordering API', () => {
  test('filters packages by their server-derived stable game', () => {
    const store = packages();
    expect(store.list({actorGuildId:guildId,actorDiscordUserId:customerDiscordUserId,game:'LOLNA',cursor:null,limit:10}).items.map(item=>item.code)).toEqual(['LOL_DUO']);
    expect(store.list({actorGuildId:guildId,actorDiscordUserId:customerDiscordUserId,game:'VALORANT',cursor:null,limit:10}).items.map(item=>item.code)).toEqual(['VAL_DUO']);
  });

  test('rejects mixed-game package versions and preserves the stable package game', () => {
    const store = packages();
    expect(() => store.createAdmin({actorStaffId:'staff',payload:{code:'LOL_DUO',displayName:'混合套餐',description:'不允许跨游戏',currency:'CAT',activate:false,slots:[{serviceCatalogVersionId:'00000000-0000-0000-0000-000000109101',unitCount:1,customerNoteTemplate:null},{serviceCatalogVersionId:'00000000-0000-0000-0000-000000109201',unitCount:1,customerNoteTemplate:null}],reasonCode:'CREATE_PACKAGE'},now:new Date()})).toThrowError(ServicePackageError);
    expect(() => store.createAdmin({actorStaffId:'staff',payload:{code:'LOL_DUO',displayName:'错误新版本',description:'稳定套餐不能改游戏',currency:'CAT',activate:false,slots:[{serviceCatalogVersionId:'00000000-0000-0000-0000-000000109201',unitCount:1,customerNoteTemplate:null}],reasonCode:'CREATE_PACKAGE'},now:new Date()})).toThrowError(ServicePackageError);
  });

  test('rejects cross-game requirement replacement without mutating the draft', () => {
    const requirement = requirementRecord();
    const store = new InMemoryOrderRequirementStore({orders:[{id:orderId,guildId,customerDiscordUserId,status:'DRAFT',version:1,amountMinor:30,sourcePackageVersionId:'00000000-0000-0000-0000-000000109010',compositionMode:'PACKAGE_DEFAULT'}],requirements:[requirement],catalogs:[catalog('00000000-0000-0000-0000-000000109202','VALORANT','瓦洛兰特')]});
    expect(() => store.update({orderId,requirementId:requirement.id,actorGuildId:guildId,actorDiscordUserId:customerDiscordUserId,expectedOrderVersion:1,expectedRequirementVersion:1,action:'CHANGE_PROJECT',serviceCatalogVersionId:'00000000-0000-0000-0000-000000109202',unitCount:1,requestedPlayerCount:1,idempotencyKey:'cross-game',now:new Date()})).toThrowError(/same game/i);
    expect(store.orders[0]).toMatchObject({version:1,amountMinor:30,compositionMode:'PACKAGE_DEFAULT'});
    expect(store.requirements[0]).toEqual(requirement);
  });

  test('allows another game as a separate single item while preserving same-game slot replacement',async()=>{const requirement=requirementRecord();const store=new InMemoryOrderRequirementStore({orders:[{id:orderId,guildId,customerDiscordUserId,status:'DRAFT',version:1,amountMinor:30,sourcePackageVersionId:null,compositionMode:null}],requirements:[requirement],catalogs:[catalog('00000000-0000-0000-0000-000000109202','VALORANT','瓦洛兰特')]});const staged=store.add({orderId,actorGuildId:guildId,actorDiscordUserId:customerDiscordUserId,expectedOrderVersion:1,serviceCatalogVersionId:'00000000-0000-0000-0000-000000109202',unitCount:1,requestedPlayerCount:1,idempotencyKey:'cross-game-add',now:new Date()});await staged.commit({actorStaffId:null,actorDiscordUserId:customerDiscordUserId,guildId,targetType:'order_requirement',targetId:staged.data.requirement.id,action:'ADD_ORDER_REQUIREMENT',reasonCode:null,before:null,after:staged.data,requestId:'cross-game-add',createdAt:new Date().toISOString()});expect(store.orders[0]).toMatchObject({version:2,amountMinor:60});expect(store.requirements.map(item=>item.game)).toEqual(['LOLNA','VALORANT']);});
});

function packages(){return new InMemoryServicePackageStore({orders:[],packages:[pkg('00000000-0000-0000-0000-000000109010','LOL_DUO','LOLNA','英雄联盟美服','00000000-0000-0000-0000-000000109101'),pkg('00000000-0000-0000-0000-000000109020','VAL_DUO','VALORANT','瓦洛兰特','00000000-0000-0000-0000-000000109201')]});}
function pkg(id:string,code:string,game:string,gameDisplayName:string,catalogId:string):ServicePackageVersionRecord{return{id,code,version:1,status:'ACTIVE',game,gameDisplayName,displayName:code,description:code,defaultCustomerPriceMinor:30,currency:'CAT',slots:[{id:`${id.slice(0,-1)}1`,position:1,serviceCatalogVersionId:catalogId,game,gameDisplayName,service:'FUN',serviceDisplayName:'娱乐陪玩',region:null,regionDisplayName:null,billingUnitMinutes:60,unitCount:1,customerUnitPriceMinor:30,customerNoteTemplate:null}]};}
function catalog(id:string,game:string,gameDisplayName:string){return{id,status:'ACTIVE' as const,game,gameDisplayName,service:'FUN',serviceDisplayName:'娱乐陪玩',region:null,regionDisplayName:null,billingUnitMinutes:60,customerUnitPriceMinor:30};}
function requirementRecord(){return{id:'00000000-0000-0000-0000-000000109301',orderId,sourcePackageSlotId:'00000000-0000-0000-0000-000000109011',serviceCatalogVersionId:'00000000-0000-0000-0000-000000109101',game:'LOLNA',gameDisplayName:'英雄联盟美服',service:'FUN',serviceDisplayName:'娱乐陪玩',region:null,regionDisplayName:null,billingUnitMinutes:60,unitCount:1,requestedPlayerCount:1,customerUnitPriceMinor:30,estimatedLinePriceMinor:30,filledPlayerCount:0,customerNote:null,status:'ACTIVE' as const,version:1,createdAt:'2026-08-04T00:00:00.000Z',updatedAt:'2026-08-04T00:00:00.000Z'};}
