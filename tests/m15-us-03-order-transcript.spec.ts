import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { InMemoryOrderChannelEventStore, recordOrderChannelEvent } from '../apps/api/src/order-channel-events.js';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage, type AdminBusinessDetailState } from '../apps/dashboard/src/admin-business.js';

const orderId='00000000-0000-0000-0000-000000015301';
const guildId='1533309755873955880';
const channelId='1533615769303257283';
const base={guildId,channelId,messageId:'1533615770179866746',authorDiscordId:'1533309755873955881',authorDisplayName:'老板小陈',authorIsBot:false,embeds:[],replyToMessageId:null,discordCreatedAt:'2026-08-06T01:00:00.000Z',discordEditedAt:null};
const l2={actorUserId:'user-l2',actorStaffId:'staff-l2',actorLevel:'L2_SUPERVISOR' as const,actorSource:'DASHBOARD' as const,clientId:'dashboard',guildId,discordUserId:'1533309755873955999',interactionId:null,permissionsVersion:1};

describe('M15-US-03 read-only order transcript',()=>{
  test('returns immutable lifecycle events with stable cursor pages and deletion metadata',async()=>{
    const store=new InMemoryOrderChannelEventStore([{orderId,orderPublicId:'P-TRANSCRIPT-1',guildId,channelId}]);
    await recordOrderChannelEvent({store,event:{...base,eventId:'msg:create',eventType:'CREATED',content:'玩到一半掉线了',attachments:[{name:'disconnect.png'}]},observedAt:new Date('2026-08-06T01:00:01Z')});
    await recordOrderChannelEvent({store,event:{...base,eventId:'msg:delete',eventType:'DELETED',content:'玩到一半掉线了',attachments:[]},observedAt:new Date('2026-08-06T01:00:02Z')});
    const first=store.listTranscript({orderId,actor:l2,cursor:null,limit:1});
    expect(first.items[0]).toMatchObject({eventType:'CREATED',content:'玩到一半掉线了',deleted:false,attachmentMetadata:[{name:'disconnect.png'}]});
    expect(first.nextCursor).toBeTruthy();
    const second=store.listTranscript({orderId,actor:l2,cursor:first.nextCursor,limit:1});
    expect(second.items[0]).toMatchObject({eventType:'DELETED',deleted:true});
    expect(second.nextCursor).toBeNull();
  });

  test('L1 needs a personally claimed task and cross-guild reads fail closed',()=>{
    const store=new InMemoryOrderChannelEventStore([{orderId,orderPublicId:'P-TRANSCRIPT-1',guildId,channelId}],{tasks:[],staff:[]});
    const l1={...l2,actorStaffId:'staff-l1',actorLevel:'L1_SUPPORT' as const};
    expect(()=>store.listTranscript({orderId,actor:l1,cursor:null,limit:25})).toThrow('not found');
    expect(()=>store.listTranscript({orderId,actor:{...l2,guildId:'999999999999999999'},cursor:null,limit:25})).toThrow('not found');
  });

  test('renders a read-only transcript without any message mutation controls',()=>{
    const model=buildAdminBusinessPage({page:'orders',permissions:['order.read'],status:'READY',items:[{id:orderId}]});
    const detail:AdminBusinessDetailState={kind:'READY',page:'orders',requestId:null,data:{order:{id:orderId,publicId:'P-TRANSCRIPT-1',status:'IN_SERVICE',amountMinor:4000,currency:'USD'},requirements:{items:[]},participants:{items:[]},timeline:{items:[],nextCursor:null},transcript:{items:[{eventId:'msg:create',messageId:base.messageId,eventType:'CREATED',authorDisplayName:'老板小陈',content:'玩到一半掉线了',replyToMessageId:null,attachmentMetadata:[{name:'disconnect.png'}],occurredAt:'2026-08-06T01:00:01Z',deleted:false}],nextCursor:null}},transcriptPage:{kind:'READY',requestId:null}};
    const html=renderToStaticMarkup(createElement(AdminBusinessPage,{model,detail}));
    expect(html).toContain('订单频道记录（只读）');expect(html).toContain('玩到一半掉线了');expect(html).toContain('附件 1 个');
    expect(html).not.toContain('发送消息');expect(html).not.toContain('编辑消息');expect(html).not.toContain('删除消息');
  });
});
