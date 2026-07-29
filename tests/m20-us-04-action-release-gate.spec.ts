import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import type { BotApiClient } from '@blackcat/bot/service-center-api';
import { executeProfileButton } from '@blackcat/bot/service-center-profile-interactions';
import { parseServiceCenterCustomId } from '@blackcat/bot/service-center-routes';
import { parseSelectionCustomId } from '@blackcat/bot/selection-discord';

const orderId = '00000000-0000-0000-0000-000000020401';
const poolId = '00000000-0000-0000-0000-000000020402';
const cursor = 'c1_12345678901234567890';

describe('M20-US-04 Discord action release gate', () => {
  test('removes superseded dropdown and first-wins renderers from production source', async () => {
    const sources = await Promise.all(
      [
        'apps/bot/src/service-center.ts',
        'apps/bot/src/selection-discord.ts',
        'apps/api/src/worker-adapters.ts',
        'apps/api/src/selection-pool-worker.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    const production = sources.join('\n');

    for (const retired of [
      'buildDispatchOfferMessage',
      'buildAcceptedDispatchMessage',
      'buildSelectionPoolOfferMessage',
      'bc:dispatch:'
    ]) {
      expect(production).not.toContain(retired);
    }
    expect(production).not.toMatch(
      /label:\s*['"](?:进入|查看|单点加入|采用套餐|查看清单|席位偏好|刷新订单|我要申诉|联系客服|终止招募|重新开始招募)['"]/u
    );
  });

  test('keeps every current order and selection action on a registered route', () => {
    for (const customId of [
      `bc:order:${orderId}:cancel:v4`,
      `bc:order:${orderId}:refresh`,
      `bc:service:support:${orderId}:v4`,
      `bc:service:confirm:${orderId}:v4`,
      `bc:gift:open:${orderId}:v4`,
      'bc:profile:orders:first',
      `bc:profile:orders:${cursor}`,
      'bc:reports:list:first'
    ]) {
      expect(parseServiceCenterCustomId(customId).area).not.toBe('unknown');
    }
    for (const customId of [
      `bc:sp:new:${orderId}:o4`,
      `bc:sp:c:${short(orderId)}:${short(poolId)}:v2`,
      `bc:sp:r:${short(orderId)}:${short(poolId)}:v2:o4`
    ]) {
      expect(parseSelectionCustomId(customId).action).not.toBe('unknown');
    }
  });

  test('preserves a previous-page cursor while paging through a live profile interaction', async () => {
    const editReply = vi.fn();
    const interaction = { deferUpdate: vi.fn(), editReply, followUp: vi.fn() };
    const actor = {
      guildId: '999999999999999999',
      discordUserId: '111111111111111111',
      interactionId: '888888888888888888',
      clientSource: 'DISCORD_BOT' as const
    };
    const api = {
      listCurrentUserOrders: vi
        .fn()
        .mockResolvedValueOnce({ items: [], nextCursor: cursor })
        .mockResolvedValueOnce({ items: [], nextCursor: null })
    } as unknown as BotApiClient;

    await executeProfileButton({
      interaction,
      actor,
      api,
      route: { area: 'profile', action: 'orders' }
    });
    await executeProfileButton({
      interaction,
      actor,
      api,
      route: { area: 'profile', action: 'orders', cursor }
    });

    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).not.toContain('← 上一页');
    expect(JSON.stringify(editReply.mock.calls[1]?.[0])).toContain('← 上一页');
    expect(JSON.stringify(editReply.mock.calls[1]?.[0])).toContain('bc:profile:orders:first');
  });
});

function short(uuid: string): string {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url');
}
