import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSupportResponseOverdueHandler, createSupportResponseReminderHandler, type SupportResponseJobStore } from '@blackcat/api/support-response-jobs';
import type { OutboxJob } from '@blackcat/api/outbox';
import { InMemoryOrderChannelEventStore, recordOrderChannelEvent, type FirstResponseTaskProjection } from '@blackcat/api/order-channel-events';

const now = new Date('2026-08-05T16:05:00.000Z');
const taskId = '00000000-0000-0000-0000-000000004001';
class Store implements SupportResponseJobStore {
  pending = true; responded = false; overdue = false;
  getReminder() {
    if (this.pending) return { taskId, channelId: '777777777777777777', publicId: 'T-4001', createdAt: '2026-08-05T16:00:00.000Z', state: 'WAITING' as const };
    return this.responded
      ? { taskId, channelId: '777777777777777777', publicId: 'T-4001', createdAt: '2026-08-05T16:00:00.000Z', state: 'RESPONDED' as const }
      : null;
  }
  markOverdue() { if (!this.pending) return false; this.pending = false; this.overdue = true; return true; }
}
function job(type: 'SUPPORT_RESPONSE_REMINDER' | 'SUPPORT_RESPONSE_OVERDUE'): OutboxJob {
  return { id:crypto.randomUUID(),type,status:'PROCESSING',payload:{staffTaskId:taskId},aggregateType:'staff_task',aggregateId:taskId,
    dedupeKey:type,attempts:1,maxAttempts:8,runAfter:now.toISOString(),lockedAt:now.toISOString(),lockedBy:'test',lastError:null,
    version:1,createdAt:now.toISOString(),updatedAt:now.toISOString() };
}

describe('M12-US-03 response jobs and transcript projection', () => {
  test('reminder sends once while pending and overdue changes facts without punishment', async () => {
    const store = new Store(); const sent:string[] = []; const updated:string[] = [];
    await createSupportResponseReminderHandler({
      store,
      send: async (message) => { sent.push(message.content); },
      update: async (message) => { updated.push(message.content); },
      now: () => new Date('2026-08-05T16:04:00.000Z') })(job('SUPPORT_RESPONSE_REMINDER'));
    expect(sent).toEqual(['你的请求（T-4001）已进入客服队列，正在等待处理。']);
    await createSupportResponseOverdueHandler({ store, now: () => now })(job('SUPPORT_RESPONSE_OVERDUE'));
    expect(store.overdue).toBe(true);
    await createSupportResponseReminderHandler({ store, send: async (message) => { sent.push(message.content); }, now: () => now })(job('SUPPORT_RESPONSE_REMINDER'));
    expect(sent).toHaveLength(1);
    store.responded = true;
    await createSupportResponseReminderHandler({
      store,
      send: async (message) => { sent.push(message.content); },
      update: async (message) => { updated.push(message.content); },
      now: () => now
    })(job('SUPPORT_RESPONSE_REMINDER'));
    expect(sent).toHaveLength(1);
    expect(updated).toEqual(['你的请求（T-4001）已由客服响应，排队提醒已结束。']);
  });

  test('migration atomically schedules fixed reminder and overdue jobs', () => {
    const sql = readFileSync('database/prisma/migrations/000032_m12_support_response_jobs/migration.sql','utf8');
    expect(sql).toContain("NEW.created_at + interval '4 minutes'");
    expect(sql).toContain("NEW.created_at + interval '5 minutes'");
    expect(sql).toContain("'SUPPORT_RESPONSE_OVERDUE'");
  });

  test('L4 first response claims oldest OPEN task and later staff cannot steal it', async () => {
    const orderId='00000000-0000-0000-0000-000000004101';
    const tasks:FirstResponseTaskProjection[]=[task('00000000-0000-0000-0000-000000004102',orderId,'2026-08-05T15:59:00.000Z'),task('00000000-0000-0000-0000-000000004103',orderId,'2026-08-05T16:00:00.000Z')];
    const base={guildId:'999999999999999999',channelId:'777777777777777777',messageId:'666666666666666666',eventId:'first',eventType:'CREATED' as const,
      authorDiscordId:'444444444444444444',authorDisplayName:'店主',authorIsBot:false,content:'我来处理',embeds:[],attachments:[],replyToMessageId:null,
      discordCreatedAt:'2026-08-05T16:01:00.000Z',discordEditedAt:null};
    const store=new InMemoryOrderChannelEventStore([{guildId:base.guildId,channelId:base.channelId,orderId,orderPublicId:'P-4101'}],{tasks,staff:[
      {staffId:'00000000-0000-0000-0000-000000004104',discordUserId:base.authorDiscordId,guildId:base.guildId,status:'ACTIVE',level:'L4_ADMIN_OWNER'},
      {staffId:'00000000-0000-0000-0000-000000004105',discordUserId:'555555555555555555',guildId:base.guildId,status:'ACTIVE',level:'L1_SUPPORT'}]});
    await recordOrderChannelEvent({store,event:base,observedAt:new Date('2026-08-05T16:01:01Z')});
    await recordOrderChannelEvent({store,event:{...base,eventId:'second',messageId:'666666666666666667',authorDiscordId:'555555555555555555'},observedAt:new Date('2026-08-05T16:01:02Z')});
    expect(tasks[0]).toMatchObject({status:'CLAIMED',claimedBy:'00000000-0000-0000-0000-000000004104',responseStatus:'MET',contextSnapshot:{claimSource:'DISCORD_FIRST_RESPONSE'}});
    expect(tasks[1]).toMatchObject({status:'OPEN',claimedBy:null,responseStatus:'MET'});
  });

  test('Bot, empty content, update events and inactive staff do not count as first response', async () => {
    const orderId='00000000-0000-0000-0000-000000004201';
    const tasks=[task('00000000-0000-0000-0000-000000004202',orderId,'2026-08-05T16:00:00.000Z')];
    const order={guildId:'999999999999999999',channelId:'777777777777777778',orderId,orderPublicId:'P-4201'};
    const store=new InMemoryOrderChannelEventStore([order],{tasks,staff:[{staffId:'00000000-0000-0000-0000-000000004203',discordUserId:'444444444444444444',guildId:order.guildId,status:'DISABLED',level:'L2_SUPERVISOR'}]});
    const base={guildId:order.guildId,channelId:order.channelId,messageId:'666666666666666668',eventId:'ignored',eventType:'UPDATED' as const,
      authorDiscordId:'444444444444444444',authorDisplayName:'停用客服',authorIsBot:false,content:'回复',embeds:[],attachments:[],replyToMessageId:null,
      discordCreatedAt:'2026-08-05T16:01:00.000Z',discordEditedAt:'2026-08-05T16:02:00.000Z'};
    await recordOrderChannelEvent({store,event:base,observedAt:new Date('2026-08-05T16:02:01Z')});
    expect(tasks[0]).toMatchObject({status:'OPEN',responseStatus:'PENDING',firstRespondedAt:null});
  });
});

function task(id:string,orderId:string,createdAt:string):FirstResponseTaskProjection {
  return {id,orderId,status:'OPEN',responseStatus:'PENDING',createdAt,claimedBy:null,claimedAt:null,firstRespondedAt:null,firstResponseEventId:null,contextSnapshot:{}};
}
