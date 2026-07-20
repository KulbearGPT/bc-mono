import type { Pool } from 'pg';
import type { OutboxHandler } from './worker-runtime.js';

export interface SupportResponseReminder { taskId:string;channelId:string;publicId:string;createdAt:string;state:'WAITING'|'RESPONDED';reasonCode?:string;readiness?:{waitMinutes:number;customerReady:boolean;playerReady:boolean} }
export interface SupportResponseJobStore {
  getReminder(taskId:string,now:Date):Promise<SupportResponseReminder|null>|SupportResponseReminder|null;
  markOverdue(taskId:string,now:Date):Promise<boolean>|boolean;
}

export class PostgresSupportResponseJobStore implements SupportResponseJobStore {
  constructor(private readonly pool:Pool){}
  async getReminder(taskId:string,now:Date){
    const result=await this.pool.query<{id:string;channel_id:string;public_id:string;created_at:Date|string;response_status:string;reason_code:string;context_snapshot:unknown;accepted_at:Date|string|null}>(`SELECT st.id,o.channel_id,st.public_id,st.created_at,st.response_status::text,st.reason_code,st.context_snapshot,o.accepted_at
      FROM staff_tasks st JOIN orders o ON o.id=st.order_id
      WHERE st.id=$1 AND ((st.response_status='PENDING' AND st.response_due_at>$2) OR st.response_status='MET') AND o.channel_id IS NOT NULL`,[taskId,now]);
    const row=result.rows[0];
    const readiness=row?.reason_code==='READINESS_TIMEOUT'?readinessReminder(row.context_snapshot,row.accepted_at):undefined;
    return row?{taskId:row.id,channelId:row.channel_id,publicId:row.public_id,createdAt:new Date(row.created_at).toISOString(),
      state:row.response_status==='MET'?'RESPONDED' as const:'WAITING' as const,reasonCode:row.reason_code,readiness}:null;
  }
  async markOverdue(taskId:string,now:Date){
    const result=await this.pool.query(`UPDATE staff_tasks SET response_status='OVERDUE',updated_at=$2
      WHERE id=$1 AND response_status='PENDING' AND response_due_at<=$2 RETURNING id`,[taskId,now]);
    return Boolean(result.rows[0]);
  }
}

interface ReminderMessage {channelId:string;content:string;dedupeKey:string;notBefore:string}
export function createSupportResponseReminderHandler(input:{store:SupportResponseJobStore;send:(message:ReminderMessage)=>Promise<unknown>;update?:(message:ReminderMessage)=>Promise<unknown>;now?:()=>Date}):OutboxHandler {
  return async(job)=>{
    if(job.type!=='SUPPORT_RESPONSE_REMINDER')throw new Error('Expected a SUPPORT_RESPONSE_REMINDER job.');
    const taskId=taskIdFrom(job.payload,job.aggregateId);
    const reminder=await input.store.getReminder(taskId,(input.now??(()=>new Date()))());
    if(!reminder)return;
    const message={channelId:reminder.channelId,
      content:reminderContent(reminder),
      dedupeKey:`support-response-reminder:${taskId}`,notBefore:reminder.createdAt};
    if(reminder.state==='RESPONDED'){
      if(!input.update)throw new Error('Support response reminder update adapter is required.');
      await input.update(message);
      return;
    }
    await input.send(message);
  };
}
export function createSupportResponseOverdueHandler(input:{store:SupportResponseJobStore;now?:()=>Date}):OutboxHandler {
  return async(job)=>{
    if(job.type!=='SUPPORT_RESPONSE_OVERDUE')throw new Error('Expected a SUPPORT_RESPONSE_OVERDUE job.');
    await input.store.markOverdue(taskIdFrom(job.payload,job.aggregateId),(input.now??(()=>new Date()))());
  };
}
function reminderContent(reminder:SupportResponseReminder){
  if(reminder.reasonCode==='READINESS_TIMEOUT'&&reminder.readiness){
    if(reminder.state==='RESPONDED')return `客服已开始处理订单未按时确认开始的问题。任务编号：${reminder.publicId}。`;
    const pending=!reminder.readiness.customerReady&&!reminder.readiness.playerReady?'您和陪玩均未确认开始'
      :!reminder.readiness.customerReady?'您尚未确认开始'
        :!reminder.readiness.playerReady?'陪玩尚未确认开始':'双方尚未完成全部开始确认';
    return `订单匹配成功后已超过 ${reminder.readiness.waitMinutes} 分钟，${pending}。系统已自动请求客服介入，请留意后续处理消息。任务编号：${reminder.publicId}。`;
  }
  return reminder.state==='RESPONDED'?`你的请求（${reminder.publicId}）已由客服响应，排队提醒已结束。`:`你的请求（${reminder.publicId}）已进入客服队列，正在等待处理。`;
}
function readinessReminder(context:unknown,acceptedAt:Date|string|null){
  const snapshot=context&&typeof context==='object'?context as Record<string,unknown>:{};
  const dueAt=typeof snapshot.readinessDueAt==='string'?Date.parse(snapshot.readinessDueAt):Number.NaN;
  const accepted=acceptedAt?new Date(acceptedAt).getTime():Number.NaN;
  const measured=Number.isFinite(dueAt)&&Number.isFinite(accepted)?Math.round((dueAt-accepted)/60_000):10;
  return {waitMinutes:measured>0?measured:10,customerReady:snapshot.customerReady===true,playerReady:snapshot.playerReady===true};
}
function taskIdFrom(payload:unknown,aggregateId:string){
  const taskId=(payload as {staffTaskId?:unknown}|null)?.staffTaskId;
  if(typeof taskId!=='string'||taskId!==aggregateId)throw new Error('Support response job payload is invalid.');
  return taskId;
}
