import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { HttpBotApiClient, buildDiscordIdempotencyKey, type OrderSummary } from '@blackcat/bot/service-center';
import { BotApiError } from '@blackcat/bot/service-center-api';

describe('M17-US-06 service-center API boundary', () => {
  test('keeps the old facade compatible while making API types and client directly importable', () => {
    expect(HttpBotApiClient).toBeTypeOf('function');
    expect(BotApiError).toBeTypeOf('function');
    expect(buildDiscordIdempotencyKey('order:test', 'interaction-1')).toBe('discord:order:test:interaction-1');
    const order = { id: 'order-1', publicId: 'P-1', status: 'DRAFT', version: 1 } as OrderSummary;
    expect(order.publicId).toBe('P-1');
  });

  test('API module contains no Discord presentation or copy construction', async () => {
    const [facade, client, contract] = await Promise.all([
      readFile('apps/bot/src/service-center-api.ts', 'utf8'),
      readFile('apps/bot/src/service-center-api-client.ts', 'utf8'),
      readFile('apps/bot/src/service-center-api-client-contract.ts', 'utf8')
    ]);
    const apiSource = [client, contract].join('\n');
    expect(facade).toContain("export * from './service-center-api-client.js'");
    expect(facade).toContain("export * from './service-center-api-client-contract.js'");
    expect(client).toContain('export class HttpBotApiClient');
    expect(contract).toContain('export interface BotApiClient');
    expect(client).toContain('BotApiTransport');
    expect(apiSource).not.toMatch(/MessageSpec|ComponentSpec|botCopy|discord-renderer|ButtonBuilder|EmbedBuilder/u);
    expect(client.split('\n').length).toBeLessThan(700);
    expect(contract.split('\n').length).toBeLessThan(300);
  });

  test('facade no longer owns the HTTP client and API-only consumers use the direct boundary', async () => {
    const [facade, presence] = await Promise.all([
      readFile('apps/bot/src/service-center.ts', 'utf8'),
      readFile('apps/bot/src/pieces/listeners/presence-update.ts', 'utf8')
    ]);
    expect(facade).toContain("export * from './service-center-api.js'");
    expect(facade).not.toContain('class HttpBotApiClient');
    expect(facade.split('\n').length).toBeLessThan(3_300);
    expect(presence).toContain("from '../../service-center-api.js'");
  });
});
