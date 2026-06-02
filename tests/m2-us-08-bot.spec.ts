import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  HttpBotApiClient,
  buildPlayerWorkbenchMessage,
  handleOpenPlayerWorkbench,
  type BotActorContext,
  type BotApiClient,
  type PlayerWorkbenchSummary
} from '@blackcat/bot/service-center';

const actor: BotActorContext = {
  guildId: '999999999999999999',
  discordUserId: '111111111111111111',
  interactionId: '777777777777777777',
  clientSource: 'DISCORD_BOT'
};

const workbench: PlayerWorkbenchSummary = {
  profile: {
    playerId: '00000000-0000-0000-0000-00000000a001', reviewStatus: 'ACTIVE', availability: 'AVAILABLE',
    discordPresence: 'ONLINE', gameTags: ['VALORANT'], serviceTags: ['ENTERTAINMENT'], activeOrderId: null, version: 3
  },
  eligibility: { eligible: true, evaluatedAt: '2026-07-18T00:00:00.000Z', checks: [] },
  currentOrder: null,
  matchingOrders: [{
    dispatchAttemptId: '00000000-0000-0000-0000-00000000d001', acceptBy: '2026-07-18T00:02:00.000Z', secondsRemaining: 120,
    nextAction: 'ACCEPT_OR_DECLINE',
    order: {
      id: '00000000-0000-0000-0000-00000000b001', publicId: 'P-1042', status: 'PENDING_DISPATCH', version: 5,
      game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA', durationMinutes: 120, playerEarningMinor: 8_000,
      currency: 'CAT', requirements: ['中文交流'], voiceChannelId: null
    }
  }],
  earningsSummary: { pendingMinor: 8_000, confirmedMinor: 3_000, paidMinor: 20_000, currency: 'CAT', calculatedAt: '2026-07-18T00:00:00.000Z' },
  nextActions: ['REVIEW_MATCH', 'ACCEPT_ORDER']
};

describe('M2-US-08 Sapphire player workbench', () => {
  test('renders the API projection without recomputing eligibility or actions in the Bot', () => {
    const message = buildPlayerWorkbenchMessage(workbench);
    expect(message.visibility).toBe('EPHEMERAL');
    expect(message.body).toContain('准入状态：可接单');
    expect(message.body).toContain('Discord 在线状态：ONLINE');
    expect(message.body).toContain('业务可接单开关：AVAILABLE');
    expect(message.body).toContain('#P-1042');
    expect(message.body).toContain('剩余 120 秒');
    expect(message.body).toContain('预计收益：800.0 CAT');
    expect(message.body).toContain('待确认收益：800.0 CAT');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual([
      'bc:entry:player-workbench',
      'bc:reports:list:first',
      `bc:dispatch:${workbench.matchingOrders[0]!.dispatchAttemptId}:accept:${workbench.matchingOrders[0]!.order.id}:v5`,
      `bc:dispatch:${workbench.matchingOrders[0]!.dispatchAttemptId}:decline:${workbench.matchingOrders[0]!.order.id}:v5`
    ]);
  });

  test('shows a stable empty state and preserves only capabilities returned by the API', () => {
    const message = buildPlayerWorkbenchMessage({ ...workbench, matchingOrders: [], nextActions: ['SET_AVAILABLE'] });
    expect(message.body).toContain('待接订单：暂无');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual([
      'bc:entry:player-workbench',
      'bc:reports:list:first',
      'bc:player:availability:AVAILABLE:v3'
    ]);
  });

  test('opens the workbench through the reusable API client', async () => {
    const api = { getPlayerWorkbench: vi.fn().mockResolvedValue(workbench) } as unknown as BotApiClient;
    const result = await handleOpenPlayerWorkbench({ api, actor });
    expect(api.getPlayerWorkbench).toHaveBeenCalledWith(actor);
    expect(result.kind).toBe('SHOW_PLAYER_WORKBENCH');
  });

  test('HTTP client calls the reusable workbench endpoint with trusted actor headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: workbench }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({ apiBaseUrl: 'https://api.example.test', botServiceToken: 'bot-token' });
    await client.getPlayerWorkbench(actor);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/players/me/workbench',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'x-actor-discord-user-id': actor.discordUserId }) })
    );
  });

  test('registers a dedicated Sapphire slash command without adding complexity to the customer public entry', async () => {
    const source = await readFile('apps/bot/src/pieces/commands/player-workbench.ts', 'utf8');
    expect(source).toContain(".setName('player-workbench')");
    expect(source).toContain('handleOpenPlayerWorkbench');
  });

  test('loads repository pieces and targets the configured test guild for immediate slash-command registration', async () => {
    const source = await readFile('apps/bot/src/index.ts', 'utf8');
    expect(source).toContain('baseUserDirectory: join(dirname(fileURLToPath(import.meta.url)), \'pieces\')');
    expect(source).toContain('ApplicationCommandRegistries.setDefaultGuildIds([configuredGuildId])');
  });
});
