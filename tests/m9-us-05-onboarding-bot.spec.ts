import { describe,expect,test,vi } from 'vitest';
import { APPLY_COMPANION_CUSTOM_ID,HttpOnboardingApiClient,REGISTER_PLAYER_CUSTOM_ID,buildOnboardingMessage } from '@blackcat/bot/onboarding';

describe('M9-US-05 persistent Discord newcomer entry adapter',()=>{
  test('offers a persistent customer order entry beside registration',()=>{const message=buildOnboardingMessage();expect(message.content).toContain('开始找陪玩');expect(JSON.stringify(message.components)).toContain('bc:entry:create-order');});
  test('renders the three approved stable entry buttons',()=>{const message=buildOnboardingMessage();const json=message.components?.[0]?.toJSON() as {components:Array<{custom_id:string;label:string}>};
    expect(json.components.map(item=>[item.custom_id,item.label])).toEqual([[REGISTER_PLAYER_CUSTOM_ID,'注册为玩家'],[APPLY_COMPANION_CUSTOM_ID,'申请成为陪玩'],['bc:entry:create-order','开始找陪玩']]);});
  test('posts only observed Discord identity and display name to the unified API',async()=>{const fetchMock=vi.fn().mockResolvedValue({ok:true,status:201,json:async()=>({requestId:'req-1',data:{userId:'u',walletAccountId:'w',guildId:'999999999999999999',discordUserId:'111111111111111111',playerRoleId:'222222222222222222',created:true,roleSyncStatus:'PENDING'}})});
    const api=new HttpOnboardingApiClient({apiBaseUrl:'https://api.example.test/',botServiceToken:'token',fetch:fetchMock});await api.registerPlayer({guildId:'999999999999999999',discordUserId:'111111111111111111',interactionId:'777777777777777777',displayName:'New Player'});
    const [,init]=fetchMock.mock.calls[0]!;expect(init).toMatchObject({method:'POST',body:JSON.stringify({displayName:'New Player'})});expect(init.headers).toMatchObject({'x-actor-guild-id':'999999999999999999','x-actor-discord-user-id':'111111111111111111','x-discord-interaction-id':'777777777777777777'});
    expect(init.body).not.toMatch(/roleId|balance|userId/u);});
});
