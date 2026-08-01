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
    playerId: '00000000-0000-0000-0000-00000000a001',
    reviewStatus: 'ACTIVE',
    gameTags: ['VALORANT'],
    serviceTags: ['ENTERTAINMENT'],
    activeOrderId: null,
    version: 3
  },
  eligibility: {
    eligible: true,
    evaluatedAt: '2026-07-18T00:00:00.000Z',
    checks: []
  },
  currentOrder: null,
  matchingOrders: [
    {
      selectionPoolId: '00000000-0000-0000-0000-00000000d001',
      applicationStatus: null,
      nextAction: 'APPLY',
      order: {
        id: '00000000-0000-0000-0000-00000000b001',
        publicId: 'P-1042',
        status: 'PENDING_DISPATCH',
        version: 5,
        game: 'VALORANT',
        gameDisplayName: '瓦洛兰特',
        service: 'ENTERTAINMENT',
        serviceDisplayName: '娱乐陪玩',
        region: 'NA',
        regionDisplayName: '北美',
        durationMinutes: 120,
        playerEarningMinor: 8_000,
        currency: 'CAT',
        requirements: ['中文交流'],
        voiceChannelId: null
      }
    }
  ],
  earningsSummary: {
    pendingMinor: 8_000,
    confirmedMinor: 3_000,
    paidMinor: 20_000,
    currency: 'CAT',
    calculatedAt: '2026-07-18T00:00:00.000Z'
  },
  nextActions: ['REVIEW_SELECTION_POOL', 'APPLY_SELECTION']
};

describe('M2-US-08 Sapphire player workbench', () => {
  test('renders the API projection without recomputing eligibility or actions in the Bot', () => {
    const message = buildPlayerWorkbenchMessage(workbench);
    expect(message.body).toContain('可报名新单');
    expect(message.visibility).toBe('EPHEMERAL');
    expect(message.body).toContain('准入状态：可报名');
    expect(message.body).not.toContain('Discord 在线状态');
    expect(message.body).not.toContain('业务可接单开关');
    expect(message.body).toContain('待确认收益：800.0 CAT');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual([
      'bc:entry:player-workbench',
      'bc:reports:list:first'
    ]);
  });

  test('shows a stable empty state and preserves only capabilities returned by the API', () => {
    const message = buildPlayerWorkbenchMessage({
      ...workbench,
      matchingOrders: [],
      nextActions: ['REVIEW_SELECTION_POOL']
    });
    expect(message.body).toContain('可报名新单');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual([
      'bc:entry:player-workbench',
      'bc:reports:list:first'
    ]);
  });

  test('opens the workbench through the reusable API client', async () => {
    const api = {
      getPlayerWorkbench: vi.fn().mockResolvedValue(workbench)
    } as unknown as BotApiClient;
    const result = await handleOpenPlayerWorkbench({ api, actor });
    expect(api.getPlayerWorkbench).toHaveBeenCalledWith(actor);
    expect(result.kind).toBe('SHOW_PLAYER_WORKBENCH');
  });

  test('HTTP client calls the reusable workbench endpoint with trusted actor headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: workbench })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'bot-token'
    });
    await client.getPlayerWorkbench(actor);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/players/me/workbench',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-actor-discord-user-id': actor.discordUserId
        })
      })
    );
  });

  test('registers a dedicated Sapphire slash command without adding complexity to the customer public entry', async () => {
    const source = await readFile('apps/bot/src/pieces/commands/player-workbench.ts', 'utf8');
    expect(source).toContain(".setName('player-workbench')");
    expect(source).toContain('executePlayerWorkbenchInteraction');
  });

  test('loads repository pieces and targets the configured test guild for immediate slash-command registration', async () => {
    const source = await readFile('apps/bot/src/index.ts', 'utf8');
    expect(source).toContain("baseUserDirectory: join(dirname(fileURLToPath(import.meta.url)), 'pieces')");
    expect(source).toContain('ApplicationCommandRegistries.setDefaultGuildIds([configuredGuildId])');
  });
});
