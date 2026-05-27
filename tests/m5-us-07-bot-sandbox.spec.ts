import { describe, expect, it, vi } from 'vitest';
import { BotConfigCache, BotConfigFlow, BotConfigSessionStore } from '@blackcat/bot/bot-config';
import {
  decorateSandboxPrivateMessage,
  sandboxDisplayRole,
  configureDiscordRendererEnvironment,
  toDiscordReply
} from '@blackcat/bot/discord-renderer';

describe('M5-US-07 Sandbox Bot presentation', () => {
  it('adds the warning only to private Sandbox messages', () => {
    expect(decorateSandboxPrivateMessage({ visibility: 'EPHEMERAL', body: '余额' }, 'SANDBOX').body)
      .toContain('SANDBOX 测试环境 · 测试余额不代表真实资金');
    expect(decorateSandboxPrivateMessage({ visibility: 'PUBLIC', body: '入口' }, 'SANDBOX').body).toBe('入口');
    expect(decorateSandboxPrivateMessage({ visibility: 'EPHEMERAL', body: '余额' }, 'PRODUCTION').body).toBe('余额');
  });

  it('maps only approved display roles without creating L1 or L3 defaults', () => {
    expect(sandboxDisplayRole('L2_SUPERVISOR')).toBe('STAFF');
    expect(sandboxDisplayRole('L4_ADMIN_OWNER')).toBe('OWNER');
    expect(sandboxDisplayRole('L1_SUPPORT')).toBeNull();
    expect(sandboxDisplayRole('L3_OPERATIONS')).toBeNull();
    expect(sandboxDisplayRole(null)).toBeNull();
  });

  it('applies the configured warning at the final Discord render boundary', () => {
    configureDiscordRendererEnvironment('SANDBOX');
    const reply = toDiscordReply({ title: '个人中心', body: '余额', visibility: 'EPHEMERAL', components: [] });
    expect(reply.content).toContain('SANDBOX 测试环境 · 测试余额不代表真实资金');
    configureDiscordRendererEnvironment('PRODUCTION');
  });

  it('shows only API-provided Sandbox environment and display role in Bot staff operations', async () => {
    const flow = new BotConfigFlow({
      api: {
        getBotConfig: vi.fn().mockResolvedValue({
          guildId: '999999999999999999', version: 1, values: {}, manageableFields: [],
          enabledFeatures: ['CORE_ORDER'], businessEnvironment: 'SANDBOX', displayRole: 'OWNER',
          updatedByStaffId: null, updatedAt: '2026-07-19T12:00:00.000Z'
        })
      } as never,
      cache: new BotConfigCache(),
      sessions: new BotConfigSessionStore({ idFactory: () => 'sandbox01' })
    });
    const reply = await flow.open({
      guildId: '999999999999999999', discordUserId: '111111111111111111', interactionId: '222222222222222222', clientSource: 'DISCORD_BOT'
    });
    expect(reply.content).toContain('SANDBOX 测试环境 · 测试余额不代表真实资金');
    expect(reply.content).toContain('Bot 配置 · OWNER');
  });
});
