import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryOnboardingStore } from '@blackcat/api/onboarding';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { botConfigChannelFields } from '@blackcat/bot/bot-config';
import { HttpOnboardingApiClient } from '@blackcat/bot/onboarding';
import {
  buildStandaloneGiftAffordabilityMessage,
  buildStandaloneGiftEntryMessage,
  buildStandaloneGiftRecipientMessage,
  createStandaloneGiftContinuationToken,
  ensureStandaloneGiftEntryMessage,
  executeStandaloneGiftButton,
  readStandaloneGiftContinuationToken,
  type StandaloneGiftCenterData
} from '@blackcat/bot/standalone-gifts';
import { parseServiceCenterCustomId } from '@blackcat/bot/service-center-routes';
import { HttpBotApiClient } from '@blackcat/bot/service-center-api';

const guildId = '900000000000022200';
const channelId = '900000000000022201';
const actor = {
  guildId,
  discordUserId: '900000000000022202',
  interactionId: '900000000000022203',
  clientSource: 'DISCORD_BOT' as const
};
const secret = 'm22-standalone-gift-signing-secret-32-bytes';
const playerProfileId = '00000000-0000-0000-0000-000000022204';
const giftCatalogVersionId = '00000000-0000-0000-0000-000000022205';

function center(): StandaloneGiftCenterData {
  return {
    recipients: [{ playerProfileId, displayName: '阿青', discordUserId: '900000000000022204' }],
    items: [
      {
        id: giftCatalogVersionId,
        code: 'MOON',
        name: '月亮蛋糕',
        version: 2,
        priceMinor: 5_200,
        currency: 'CAT',
        affordable: true
      }
    ],
    balance: {
      ledgerBalanceMinor: 10_000,
      reservedMinor: 0,
      availableMinor: 10_000,
      currency: 'CAT',
      calculatedAt: '2026-08-13T18:00:00.000Z'
    }
  };
}

describe('M22-US-03 Discord standalone gift entry', () => {
  test('exposes gift entry configuration and durable internal message projection', async () => {
    const [apiConfig, dashboardConfig, openapi] = await Promise.all([
      readFile('apps/api/src/bot-config.ts', 'utf8'),
      readFile('apps/dashboard/src/bot-config-dashboard.ts', 'utf8'),
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8')
    ]);
    expect(botConfigChannelFields).toContain('gift_entry_channel_id');
    expect(apiConfig).toContain('"gift_entry_channel_id"');
    expect(dashboardConfig).toContain("'gift_entry_channel_id'");
    expect(openapi).toContain('operationId: getInternalGiftEntryMessage');
    expect(openapi).toContain('operationId: saveInternalGiftEntryMessage');

    const store = new InMemoryOnboardingStore({ playerRoleId: '900000000000022210' });
    const server = buildApiServer({
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '',
        API_PORT: '0',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'valid-bot-token'
      },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      onboarding: { store }
    });
    const headers = { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT' };
    const saved = await server.inject({
      method: 'PUT',
      url: '/api/v1/internal/gift-entry-message',
      headers: { ...headers, 'idempotency-key': 'gift-entry-message:save:22200' },
      payload: { guildId, channelId, messageId: '900000000000022211', renderedVersion: 1 }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const loaded = await server.inject({
      method: 'GET',
      url: `/api/v1/internal/gift-entry-message?guildId=${guildId}`,
      headers
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json().data).toMatchObject({
      guildId,
      channelId,
      messageId: '900000000000022211',
      renderedVersion: 1
    });
    await server.close();
  });

  test('reconciles one pinned managed card and saves the current message pointer', async () => {
    const payloads: unknown[] = [];
    const deleted: string[] = [];
    const makeMessage = (id: string) => ({
      id,
      author: { id: '900000000000022299' },
      pinned: false,
      components: [{ components: [{ customId: 'bc:g2:o' }] }],
      edit: vi.fn(async (payload: unknown) => {
        payloads.push(payload);
      }),
      delete: vi.fn(async () => {
        deleted.push(id);
      }),
      pin: vi.fn(async () => undefined)
    });
    const kept = makeMessage('900000000000022220');
    const duplicate = makeMessage('900000000000022221');
    const messages = new Map([
      [kept.id, kept],
      [duplicate.id, duplicate]
    ]);
    const channel = {
      id: channelId,
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async (value: unknown) => {
          const messageId =
            typeof value === 'object' && value && 'message' in value
              ? String((value as { message: unknown }).message)
              : null;
          return messageId ? (messages.get(messageId) ?? null) : messages;
        })
      },
      send: vi.fn()
    };
    const api = {
      getGiftEntryMessage: vi.fn(async () => ({
        guildId,
        channelId,
        messageId: kept.id,
        renderedVersion: 1,
        updatedAt: '2026-08-13T18:00:00.000Z'
      })),
      saveGiftEntryMessage: vi.fn(async (value: unknown) => value)
    };
    const guild = {
      id: guildId,
      client: { user: { id: '900000000000022299' } },
      channels: { fetch: vi.fn(async () => channel) }
    };

    await expect(
      ensureStandaloneGiftEntryMessage({ guild: guild as never, channelId, api: api as never })
    ).resolves.toEqual({ messageId: kept.id, created: false, removedDuplicates: 1, pinned: true });
    expect(kept.edit).toHaveBeenCalledOnce();
    expect(kept.pin).toHaveBeenCalledOnce();
    expect(deleted).toEqual([duplicate.id]);
    expect(api.saveGiftEntryMessage).toHaveBeenCalledWith(
      expect.objectContaining({ guildId, channelId, messageId: kept.id })
    );
    expect(JSON.stringify(payloads)).toContain('bc:g2:o');
  });

  test('bypasses the Discord cache and recreates a deleted projected card', async () => {
    const created = {
      id: '900000000000022223',
      author: { id: '900000000000022299' },
      pinned: false,
      components: [{ components: [{ customId: 'bc:g2:o' }] }],
      edit: vi.fn(),
      delete: vi.fn(),
      pin: vi.fn(async function (this: { pinned: boolean }) {
        this.pinned = true;
      })
    };
    const fetch = vi.fn(async (value: unknown) => {
      if (typeof value === 'object' && value && 'message' in value) return null;
      return new Map();
    });
    const channel = { id: channelId, isTextBased: () => true, messages: { fetch }, send: vi.fn(async () => created) };
    const api = {
      getGiftEntryMessage: vi.fn(async () => ({
        guildId,
        channelId,
        messageId: '900000000000022222',
        renderedVersion: 1,
        updatedAt: '2026-08-13T18:00:00.000Z'
      })),
      saveGiftEntryMessage: vi.fn(async (value: unknown) => value)
    };
    const guild = {
      id: guildId,
      client: { user: { id: '900000000000022299' } },
      channels: { fetch: vi.fn(async () => channel) }
    };

    await expect(
      ensureStandaloneGiftEntryMessage({ guild: guild as never, channelId, api: api as never })
    ).resolves.toMatchObject({ messageId: created.id, created: true, pinned: true });
    expect(fetch).toHaveBeenCalledWith({ message: '900000000000022222', cache: false, force: true });
    expect(channel.send).toHaveBeenCalledOnce();
  });

  test('uses a private sequential picker and an actor-bound restart-safe continuation token', () => {
    const entry = buildStandaloneGiftEntryMessage();
    const picker = buildStandaloneGiftRecipientMessage(center());
    expect(entry.visibility).toBe('PUBLIC');
    expect(JSON.stringify(entry)).toContain('bc:g2:o');
    expect(picker.visibility).toBe('EPHEMERAL');
    expect(JSON.stringify(picker)).toContain(playerProfileId);

    const token = createStandaloneGiftContinuationToken(
      { playerProfileId, giftCatalogVersionId, catalogVersion: 2, priceMinor: 5_200 },
      actor,
      secret,
      new Date('2026-08-13T18:00:00.000Z')
    );
    expect(readStandaloneGiftContinuationToken(token, actor, secret, new Date('2026-08-13T18:10:00.000Z'))).toEqual({
      playerProfileId,
      giftCatalogVersionId,
      catalogVersion: 2,
      priceMinor: 5_200
    });
    expect(() =>
      readStandaloneGiftContinuationToken(
        token,
        { ...actor, discordUserId: '900000000000022299' },
        secret,
        new Date('2026-08-13T18:10:00.000Z')
      )
    ).toThrow();
    const confirmation = buildStandaloneGiftAffordabilityMessage(
      {
        playerProfileId,
        giftCatalogVersionId,
        catalogVersion: 2,
        priceMinor: 5_200,
        recipientCount: 1,
        totalPriceMinor: 5_200,
        ledgerBalanceMinor: 10_000,
        reservedMinor: 0,
        availableMinor: 10_000,
        shortfallMinor: 0,
        currency: 'CAT',
        calculatedAt: '2026-08-13T18:00:00.000Z',
        stale: false,
        canAfford: true,
        topUpInstructions: '联系客服'
      },
      token,
      '阿青',
      '月亮蛋糕'
    );
    expect(JSON.stringify(confirmation)).toContain('公开赠送');
    expect(JSON.stringify(confirmation)).toContain('匿名赠送');
  });

  test('submits anonymous only from the final explicit button and preserves idempotency', async () => {
    const token = createStandaloneGiftContinuationToken(
      { playerProfileId, giftCatalogVersionId, catalogVersion: 2, priceMinor: 5_200 },
      actor,
      secret,
      new Date('2026-08-13T18:00:00.000Z')
    );
    const create = vi.fn(async () => ({
      origin: 'STANDALONE',
      senderVisibility: 'ANONYMOUS',
      orderId: null,
      playerProfileId,
      receiverId: '00000000-0000-0000-0000-000000022206',
      id: '00000000-0000-0000-0000-000000022207',
      publicId: 'G-22207',
      status: 'PENDING_REVIEW',
      expiresAt: '2026-08-13T18:30:00.000Z',
      gift: { code: 'MOON', name: '月亮蛋糕', priceMinor: 5_200, currency: 'CAT' },
      reservation: {
        id: '00000000-0000-0000-0000-000000022208',
        status: 'ACTIVE',
        amountMinor: 5_200,
        currency: 'CAT',
        expiresAt: '2026-08-13T18:30:00.000Z'
      },
      staffTask: {
        id: '00000000-0000-0000-0000-000000022209',
        publicId: 'T-22209',
        type: 'GIFT_REVIEW',
        status: 'OPEN'
      },
      balance: {
        ledgerBalanceMinor: 10_000,
        reservedMinor: 5_200,
        availableMinor: 4_800,
        currency: 'CAT',
        calculatedAt: '2026-08-13T18:00:00.000Z'
      }
    }));
    const interaction = { id: '900000000000022230', deferUpdate: vi.fn(), editReply: vi.fn(), followUp: vi.fn() };
    await executeStandaloneGiftButton({
      interaction: interaction as never,
      route: { area: 'standalone-gift', action: 'confirm-anonymous', token },
      actor,
      api: { createStandaloneGiftRequest: create } as never,
      secret: () => secret
    });
    expect(create).toHaveBeenCalledWith(
      { playerProfileId, giftCatalogVersionId, expectedCatalogVersion: 2, expectedPriceMinor: 5_200, anonymous: true },
      actor,
      expect.stringContaining('gift:standalone:confirm')
    );
    expect(interaction.editReply).toHaveBeenCalledOnce();
  });

  test('routes real Sapphire buttons/selects and the HTTP client uses the three unified APIs', async () => {
    expect(parseServiceCenterCustomId('bc:g2:o')).toEqual({ area: 'standalone-gift', action: 'open' });
    expect(parseServiceCenterCustomId('bc:g2:r')).toEqual({ area: 'standalone-gift-recipient-select' });
    expect(parseServiceCenterCustomId('bc:g2:g')).toEqual({ area: 'standalone-gift-catalog-select' });
    const [buttons, selects, startup, client] = await Promise.all([
      readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8'),
      readFile('apps/bot/src/pieces/interaction-handlers/order-selects.ts', 'utf8'),
      readFile('apps/bot/src/runtime-startup.ts', 'utf8'),
      readFile('apps/bot/src/service-center-api-client-gifts.ts', 'utf8')
    ]);
    expect(buttons).toContain('executeStandaloneGiftButton');
    expect(selects).toContain('executeStandaloneGiftSelect');
    expect(startup).toContain('ensureStandaloneGiftEntryMessage');
    expect(client).toContain("'/api/v1/gift-center'");
    expect(client).toContain("'/api/v1/gift-center/affordability'");
    expect(client).toContain("'/api/v1/gift-center/gift-requests'");

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ requestId: 'req-gift-entry', data: center() }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const api = new HttpOnboardingApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'valid-bot-token',
      fetch: fetchMock
    });
    await api.getGiftEntryMessage(guildId);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/internal/gift-entry-message?guildId=${guildId}`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('validates and sends the standalone center, affordability, and final-create DTOs', async () => {
    const affordability = {
      playerProfileId,
      giftCatalogVersionId,
      catalogVersion: 2,
      priceMinor: 5_200,
      recipientCount: 1,
      totalPriceMinor: 5_200,
      ledgerBalanceMinor: 10_000,
      reservedMinor: 0,
      availableMinor: 10_000,
      shortfallMinor: 0,
      currency: 'CAT',
      calculatedAt: '2026-08-13T18:00:00.000Z',
      stale: false,
      canAfford: true,
      topUpInstructions: '联系客服'
    };
    const created = {
      origin: 'STANDALONE',
      senderVisibility: 'PUBLIC',
      orderId: null,
      playerProfileId,
      receiverId: '00000000-0000-0000-0000-000000022206',
      id: '00000000-0000-0000-0000-000000022207',
      publicId: 'G-22207',
      status: 'PENDING_REVIEW',
      expiresAt: '2026-08-13T18:30:00.000Z',
      gift: { code: 'MOON', name: '月亮蛋糕', priceMinor: 5_200, currency: 'CAT' },
      reservation: {
        id: '00000000-0000-0000-0000-000000022208',
        status: 'ACTIVE',
        amountMinor: 5_200,
        currency: 'CAT',
        expiresAt: '2026-08-13T18:30:00.000Z'
      },
      staffTask: {
        id: '00000000-0000-0000-0000-000000022209',
        publicId: 'T-22209',
        type: 'GIFT_REVIEW',
        status: 'OPEN'
      },
      balance: {
        ledgerBalanceMinor: 10_000,
        reservedMinor: 5_200,
        availableMinor: 4_800,
        currency: 'CAT',
        calculatedAt: '2026-08-13T18:00:00.000Z'
      }
    };
    const values = [center(), affordability, created];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ requestId: 'req-gift', data: values.shift() }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const api = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'valid-bot-token',
      fetch: fetchMock
    });

    await expect(api.getStandaloneGiftCenter(actor)).resolves.toMatchObject({ recipients: [{ playerProfileId }] });
    await expect(
      api.checkStandaloneGiftAffordability(playerProfileId, giftCatalogVersionId, actor)
    ).resolves.toMatchObject({ canAfford: true });
    await expect(
      api.createStandaloneGiftRequest(
        {
          playerProfileId,
          giftCatalogVersionId,
          expectedCatalogVersion: 2,
          expectedPriceMinor: 5_200,
          anonymous: false
        },
        actor,
        'gift:standalone:http:22200'
      )
    ).resolves.toMatchObject({ origin: 'STANDALONE' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.example.test/api/v1/gift-center',
      'https://api.example.test/api/v1/gift-center/affordability',
      'https://api.example.test/api/v1/gift-center/gift-requests'
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      playerProfileId,
      giftCatalogVersionId,
      expectedCatalogVersion: 2,
      expectedPriceMinor: 5_200,
      anonymous: false
    });
  });
});
