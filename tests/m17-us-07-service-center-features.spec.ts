import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  assertDiscordMessageSpec,
  paginationCustomId,
  type MessageSpec
} from '@blackcat/bot/service-center-components';
import {
  buildCurrentWalletMessage,
  buildServiceCenterMessage
} from '@blackcat/bot/service-center-profile';
import { parseServiceCenterCustomId } from '@blackcat/bot/service-center-routes';

const orderId = '11111111-1111-4111-8111-111111111111';

describe('M17-US-07 service-center feature boundaries', () => {
  test('exports profile presentation and custom-id routes through dedicated modules', () => {
    const wallet = buildCurrentWalletMessage({
      ledgerBalanceMinor: 120,
      reservedMinor: 20,
      availableMinor: 100,
      currency: 'CAT',
      calculatedAt: '2026-08-06T00:00:00.000Z'
    });
    expect(wallet.title).toBe('我的猫条钱包');
    expect(buildServiceCenterMessage).toBeTypeOf('function');
    expect(parseServiceCenterCustomId('bc:profile:orders:first')).toEqual({
      area: 'profile',
      action: 'orders',
      cursor: undefined
    });
    expect(parseServiceCenterCustomId(`bc:gift:open:${orderId}:v3`)).toEqual({
      area: 'gift',
      action: 'open',
      orderId,
      expectedVersion: 3
    });
  });

  test('builds pagination IDs that round-trip and rejects Discord limit violations', () => {
    const cursor = `c1_${'a'.repeat(24)}`;
    const customId = paginationCustomId('bc:profile:orders', cursor);
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(parseServiceCenterCustomId(customId)).toEqual({
      area: 'profile',
      action: 'orders',
      cursor
    });

    const valid: MessageSpec = {
      title: 'ok',
      body: 'ok',
      visibility: 'EPHEMERAL',
      components: [{
        type: 'ACTION_ROW',
        components: [{ type: 'BUTTON', style: 'PRIMARY', customId: 'bc:profile:open', label: '打开' }]
      }]
    };
    expect(() => assertDiscordMessageSpec(valid)).not.toThrow();
    expect(() => assertDiscordMessageSpec({
      ...valid,
      components: [{
        type: 'ACTION_ROW',
        components: [{ type: 'BUTTON', style: 'PRIMARY', customId: 'x'.repeat(101), label: '打开' }]
      }]
    })).toThrow(/custom ID exceeds 100/u);
  });

  test('keeps presentation pure and the compatibility facade below the review budget', async () => {
    const [profile, components, routes, facade, gifts] = await Promise.all([
      readFile('apps/bot/src/service-center-profile.ts', 'utf8'),
      readFile('apps/bot/src/service-center-components.ts', 'utf8'),
      readFile('apps/bot/src/service-center-routes.ts', 'utf8'),
      readFile('apps/bot/src/service-center.ts', 'utf8'),
      readFile('apps/bot/src/gifts.ts', 'utf8')
    ]);
    expect(profile).not.toContain('process.env');
    expect(components).not.toContain('process.env');
    expect(routes).not.toContain('process.env');
    expect(gifts).not.toContain('parseWalletDisplayConfig(process.env)');
    expect(facade).toContain("export * from './service-center-components.js'");
    expect(facade).toContain("export * from './service-center-profile.js'");
    expect(facade).toContain("export * from './service-center-routes.js'");
    expect(facade.split('\n').length).toBeLessThan(2_500);
  });
});
