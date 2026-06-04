import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild, type MessageEditOptions } from 'discord.js';

export const REGISTER_PLAYER_CUSTOM_ID = 'onboarding:register-player:v1';
export const APPLY_COMPANION_CUSTOM_ID = 'onboarding:apply-companion:v1';
export const ONBOARDING_RENDERED_VERSION = 2;

export interface OnboardingActor { guildId:string;discordUserId:string;interactionId:string;displayName:string }
export interface PlayerRegistrationResult {userId:string;walletAccountId:string;guildId:string;discordUserId:string;playerRoleId:string;created:boolean;roleSyncStatus:'PENDING'}
export interface CompanionApplicationResult extends PlayerRegistrationResult {playerProfileId:string;reviewStatus:'PENDING_REVIEW';companionApplicantRoleId:string|null}
export interface OnboardingMessageProjection {guildId:string;channelId:string;messageId:string|null;renderedVersion:number;updatedAt:string}
export interface DiscordProductRoleTask {id:string;guildId:string;discordUserId:string;roleId:string;action:'ADD'|'REMOVE';status:'PENDING'|'FAILED';attemptCount:number}

export class OnboardingApiError extends Error {
  constructor(readonly code:string,readonly requestId:string,message:string){super(message);this.name='OnboardingApiError';}
}

export class HttpOnboardingApiClient {
  private readonly baseUrl:string;
  constructor(private readonly input:{apiBaseUrl:string;botServiceToken:string;fetch?:typeof fetch}){this.baseUrl=input.apiBaseUrl.replace(/\/$/u,'');}
  registerPlayer(actor:OnboardingActor){return this.actorRequest<PlayerRegistrationResult>('/api/v1/me/player-registration',actor);}
  applyForCompanion(actor:OnboardingActor){return this.actorRequest<CompanionApplicationResult>('/api/v1/me/companion-application',actor);}
  async getMessage(guildId:string){return this.request<OnboardingMessageProjection|null>(`/api/v1/internal/onboarding-message?guildId=${encodeURIComponent(guildId)}`,{method:'GET'});}
  async saveMessage(value:Omit<OnboardingMessageProjection,'updatedAt'>){return this.request<OnboardingMessageProjection>('/api/v1/internal/onboarding-message',{
    method:'PUT',body:value,idempotencyKey:`onboarding-message:${value.guildId}:${value.channelId}:${value.messageId??'none'}:v${value.renderedVersion}`});}
  async listRoleTasks(guildId:string){return this.request<DiscordProductRoleTask[]>(`/api/v1/internal/product-role-tasks?guildId=${encodeURIComponent(guildId)}`,{method:'GET'});}
  async completeRoleTask(taskId:string,applied:boolean,errorCode:string|null){return this.request<{taskId:string;status:'APPLIED'|'FAILED'}>(`/api/v1/internal/product-role-tasks/${encodeURIComponent(taskId)}/result`,{
    method:'POST',body:{applied,errorCode},idempotencyKey:`product-role-task:${taskId}:${applied?'applied':`failed:${errorCode}`}`});}
  private actorRequest<T>(path:string,actor:OnboardingActor){return this.request<T>(path,{method:'POST',body:{displayName:actor.displayName},idempotencyKey:`discord:onboarding:${actor.interactionId}`,
    actor});}
  private async request<T>(path:string,input:{method:'GET'|'POST'|'PUT';body?:unknown;idempotencyKey?:string;actor?:OnboardingActor}):Promise<T>{
    const headers:Record<string,string>={authorization:`Bearer ${this.input.botServiceToken}`,'x-client-source':'DISCORD_BOT'};
    if(input.body!==undefined)headers['content-type']='application/json';if(input.idempotencyKey)headers['idempotency-key']=input.idempotencyKey;
    if(input.actor){headers['x-actor-guild-id']=input.actor.guildId;headers['x-actor-discord-user-id']=input.actor.discordUserId;headers['x-discord-interaction-id']=input.actor.interactionId;}
    let response:Response;try{response=await(this.input.fetch??fetch)(`${this.baseUrl}${path}`,{method:input.method,headers,body:input.body===undefined?undefined:JSON.stringify(input.body)});}catch{throw new OnboardingApiError('SERVICE_UNAVAILABLE','bot-api-unreachable','统一 API 暂时不可用。');}
    const envelope=await response.json().catch(()=>null) as {requestId?:string;data?:T;error?:{code?:string;message?:string}}|null;
    if(!response.ok||!envelope||!('data'in envelope))throw new OnboardingApiError(envelope?.error?.code??'SERVICE_UNAVAILABLE',envelope?.requestId??'unknown',envelope?.error?.message??'统一 API 请求失败。');
    return envelope.data as T;
  }
}

export async function reconcileProductRoleTasks(input:{guild:Guild;api:HttpOnboardingApiClient}):Promise<{applied:number;failed:number}>{
  const tasks=await input.api.listRoleTasks(input.guild.id);let applied=0;let failed=0;
  for(const task of tasks){try{const member=await input.guild.members.fetch(task.discordUserId);if(task.action==='ADD')await member.roles.add(task.roleId,'Blackcat product role reconciliation');
      else await member.roles.remove(task.roleId,'Blackcat product role reconciliation');await input.api.completeRoleTask(task.id,true,null);applied+=1;
    }catch(error){const code=error instanceof Error?error.name:'DISCORD_ROLE_SYNC_FAILED';await input.api.completeRoleTask(task.id,false,code.slice(0,100)).catch(()=>undefined);failed+=1;}}
  return {applied,failed};
}

export function buildOnboardingMessage():MessageEditOptions{
  return {content:'**欢迎来到 Blackcat Companion**\n\n点击「注册为玩家」创建账户；点击「开始找陪玩」即可创建订单。你也可以申请成为陪玩，陪玩仍然保留玩家身份。',
    components:[new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(REGISTER_PLAYER_CUSTOM_ID).setLabel('注册为玩家').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(APPLY_COMPANION_CUSTOM_ID).setLabel('申请成为陪玩').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('bc:entry:create-order').setLabel('开始找陪玩').setStyle(ButtonStyle.Success)
    )],allowedMentions:{parse:[]}};
}

export async function ensureOnboardingMessage(input:{guild:Guild;channelId:string;api:HttpOnboardingApiClient}):Promise<{messageId:string;created:boolean}>{
  const channel=await input.guild.channels.fetch(input.channelId);if(!channel||!channel.isTextBased()||!('messages'in channel))throw new Error('新人入口频道必须是 Bot 可读写的文字频道。');
  const projection=await input.api.getMessage(input.guild.id);const payload=buildOnboardingMessage();let message=null;
  if(projection?.channelId===input.channelId&&projection.messageId){message=await channel.messages.fetch(projection.messageId).catch(()=>null);}
  const created=!message;if(message)await message.edit(payload);else message=await channel.send({content:payload.content??undefined,components:payload.components,allowedMentions:payload.allowedMentions});
  await input.api.saveMessage({guildId:input.guild.id,channelId:input.channelId,messageId:message.id,renderedVersion:ONBOARDING_RENDERED_VERSION});
  return {messageId:message.id,created};
}

export const onboardingApi=new HttpOnboardingApiClient({apiBaseUrl:process.env.API_BASE_URL??'',botServiceToken:process.env.BOT_SERVICE_TOKEN??''});
