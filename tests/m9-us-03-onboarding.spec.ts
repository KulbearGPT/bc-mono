import { describe,expect,test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink,InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryOnboardingStore } from '@blackcat/api/onboarding';

const guildId='999999999999999999',discordUserId='111111111111111111',playerRoleId='222222222222222222',applicantRoleId='333333333333333333';
const env={NODE_ENV:'development',DATABASE_URL:'',API_PORT:'0',API_BASE_URL:'http://localhost:3000',BOT_SERVICE_TOKEN:'valid-bot-token'};
function requestHeaders(interactionId:string){return{authorization:'Bearer valid-bot-token','x-client-source':'DISCORD_BOT','x-actor-guild-id':guildId,
  'x-actor-discord-user-id':discordUserId,'x-discord-interaction-id':interactionId,'idempotency-key':`discord:onboarding:${interactionId}`};}

describe('M9-US-03 Discord self registration and companion application',()=>{
  test('creates one CAT wallet identity and returns the configured basic player role idempotently',async()=>{const store=new InMemoryOnboardingStore({playerRoleId,companionApplicantRoleId:applicantRoleId});
    const server=buildApiServer({env,security:{auditSink:new InMemoryAuditSink(),idempotencyStore:new InMemoryIdempotencyStore()},onboarding:{store}});
    const first=await server.inject({method:'POST',url:'/api/v1/me/player-registration',headers:requestHeaders('777777777777777771'),payload:{displayName:'New Player'}});
    const repeated=await server.inject({method:'POST',url:'/api/v1/me/player-registration',headers:requestHeaders('777777777777777772'),payload:{displayName:'New Player'}});
    expect(first.statusCode).toBe(201);expect(first.json().data).toMatchObject({guildId,discordUserId,playerRoleId,created:true,roleSyncStatus:'PENDING'});
    expect(repeated.statusCode).toBe(201);expect(repeated.json().data).toMatchObject({userId:first.json().data.userId,walletAccountId:first.json().data.walletAccountId,created:false});
    expect(store.registrations).toHaveLength(1);await server.close();});

  test('application includes base registration and creates only one pending companion profile',async()=>{const store=new InMemoryOnboardingStore({playerRoleId,companionApplicantRoleId:applicantRoleId});
    const server=buildApiServer({env,security:{auditSink:new InMemoryAuditSink(),idempotencyStore:new InMemoryIdempotencyStore()},onboarding:{store}});
    const first=await server.inject({method:'POST',url:'/api/v1/me/companion-application',headers:requestHeaders('777777777777777773'),payload:{displayName:'Dual Role User'}});
    const repeat=await server.inject({method:'POST',url:'/api/v1/me/companion-application',headers:requestHeaders('777777777777777774'),payload:{displayName:'Dual Role User'}});
    expect(first.json().data).toMatchObject({reviewStatus:'PENDING_REVIEW',playerRoleId,companionApplicantRoleId:applicantRoleId});
    expect(repeat.json().data.playerProfileId).toBe(first.json().data.playerProfileId);expect(store.registrations).toHaveLength(1);expect(store.applications).toHaveLength(1);await server.close();});

  test('rejects clients that self-report no trusted Discord actor context',async()=>{const store=new InMemoryOnboardingStore({playerRoleId});const server=buildApiServer({env,security:{},onboarding:{store}});
    const response=await server.inject({method:'POST',url:'/api/v1/me/player-registration',headers:{authorization:'Bearer valid-bot-token','x-client-source':'DISCORD_BOT','idempotency-key':'discord:onboarding:missing'},payload:{displayName:'Forged'}});
    expect(response.statusCode).toBe(401);expect(store.registrations).toHaveLength(0);await server.close();});
});
