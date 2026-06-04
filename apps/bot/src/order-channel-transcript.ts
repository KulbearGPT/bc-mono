import type { Message, PartialMessage } from 'discord.js';
import { botConfigCache } from './bot-config.js';

export type TranscriptEventType='CREATED'|'UPDATED'|'DELETED';
export class OrderChannelTranscriptApi {
  constructor(private readonly input:{apiBaseUrl:string;botServiceToken:string;fetch?:typeof fetch}){}
  async record(message:Message|PartialMessage,eventType:TranscriptEventType):Promise<void>{
    if(!message.guildId)return;
    const categoryId=botConfigCache.get(message.guildId)?.values.private_order_category_id;
    const channel=message.channel;
    const directParent='parentId'in channel?channel.parentId:null;
    const grandParent='parent'in channel&&channel.parent&&'parentId'in channel.parent?channel.parent.parentId:null;
    if(typeof categoryId!=='string'||(directParent!==categoryId&&grandParent!==categoryId))return;
    const edited=message.editedTimestamp?new Date(message.editedTimestamp).toISOString():null;
    const eventId=`${message.id}:${eventType}:${eventType==='UPDATED'?edited??'unknown':'v1'}`;
    const body={guildId:message.guildId,channelId:message.channelId,messageId:message.id,eventId,eventType,
      authorDiscordId:message.author?.id??null,authorDisplayName:message.member?.displayName??message.author?.globalName??message.author?.username??null,
      authorIsBot:message.author?.bot??null,content:message.content??null,embeds:message.embeds?.map((item)=>item.toJSON())??[],
      attachments:message.attachments?.map((item)=>({id:item.id,name:item.name,size:item.size,contentType:item.contentType,url:item.url}))??[],
      replyToMessageId:message.reference?.messageId??null,discordCreatedAt:message.createdTimestamp?new Date(message.createdTimestamp).toISOString():null,
      discordEditedAt:edited};
    const response=await(this.input.fetch??fetch)(`${this.input.apiBaseUrl.replace(/\/$/u,'')}/api/v1/internal/order-channel-events`,{method:'POST',headers:{authorization:`Bearer ${this.input.botServiceToken}`,
      'content-type':'application/json','x-client-source':'DISCORD_BOT','idempotency-key':`transcript:${eventId}`.replaceAll(/[^A-Za-z0-9:_-]/gu,'_').slice(0,200)},body:JSON.stringify(body)});
    if(!response.ok){const envelope=await response.json().catch(()=>null) as {error?:{code?:string}}|null;if(response.status===404&&envelope?.error?.code==='NOT_FOUND')return;throw new Error(`Transcript API failed with HTTP ${response.status}.`);}
  }
}
export const orderChannelTranscriptApi=new OrderChannelTranscriptApi({apiBaseUrl:process.env.API_BASE_URL??'',botServiceToken:process.env.BOT_SERVICE_TOKEN??''});
