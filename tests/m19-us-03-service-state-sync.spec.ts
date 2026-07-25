import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { DiscordRestWorkerAdapter } from '@blackcat/api/worker-adapters';
import { createSupportResponseReminderHandler, type SupportResponseJobStore } from '@blackcat/api/support-response-jobs';
import type { OutboxJob } from '@blackcat/api/outbox';
import { SupportOrderContextPreview } from '../apps/dashboard/src/SupportWorkbenchPage.js';

const notBefore = '2026-08-08T12:00:00.000Z';

describe('M19-US-03 service lifecycle cross-role state sync', () => {
  test('patches the existing staff coordination card for partial readiness while status remains ACCEPTED', async () => {
    const orderId = '00000000-0000-0000-0000-000000019003';
    const channelId = '710000000000000001';
    const staffChannelId = '710000000000000002';
    const panelMessageId = '710000000000000003';
    const staffMessageId = '710000000000000004';
    const staffNonce = createHash('sha256').update(`accepted-staff:${orderId}`).digest('hex').slice(0, 24);
    const customerNonce = createHash('sha256').update(`accepted-customer:${orderId}`).digest('hex').slice(0, 24);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/channels/${channelId}/messages?`)) {
        return response(200, [{ id: 'customer-notice', nonce: customerNonce, timestamp: notBefore }]);
      }
      if (url.includes(`/channels/${staffChannelId}/messages?`)) {
        return response(200, [{ id: staffMessageId, nonce: staffNonce, timestamp: notBefore }]);
      }
      if (url.endsWith(`/channels/${staffChannelId}/messages/${staffMessageId}`) && init?.method === 'PATCH') {
        return response(200, { id: staffMessageId });
      }
      if (url.endsWith(`/channels/${channelId}/messages/${panelMessageId}`) && init?.method === 'PATCH') {
        return response(200, { id: panelMessageId });
      }
      return response(204);
    });

    await new DiscordRestWorkerAdapter({ token: 'test-token', fetch: fetchMock }).upsertOrderPanel({
      orderId,
      publicId: 'P-M19-003',
      status: 'ACCEPTED',
      version: 8,
      channelId,
      panelMessageId,
      customerDiscordUserId: '710000000000000010',
      playerDiscordUserId: null,
      playerDiscordUserIds: ['710000000000000011', '710000000000000012'],
      participants: [
        { discordUserId: '710000000000000011', displayName: '阿灰', readiness: 'READY', linePriceMinor: 100, expectedEarningMinor: 60, compensationSource: 'CATALOG_DEFAULT' },
        { discordUserId: '710000000000000012', displayName: '小白', readiness: 'NOT_READY', linePriceMinor: 100, expectedEarningMinor: 60, compensationSource: 'CATALOG_DEFAULT' }
      ],
      allActivePlayersReady: false,
      readyDeadlineAt: '2026-08-08T12:10:00.000Z',
      startedAt: null,
      amountMinor: 200,
      currency: 'CAT',
      guildId: '710000000000000020',
      voiceChannelId: '710000000000000021',
      staffTaskChannelId: staffChannelId,
      staffRoleIds: []
    }, notBefore);

    const patch = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(`/channels/${staffChannelId}/messages/${staffMessageId}`) && init?.method === 'PATCH'
    );
    expect(patch).toBeDefined();
    const payload = JSON.parse(patch?.[1]?.body as string);
    const fields = payload.embeds[0].fields as Array<{ name: string; value: string }>;
    expect(fields).toContainEqual(expect.objectContaining({ name: '陪玩准备状态', value: expect.stringContaining('阿灰：✅ 已就绪') }));
    expect(fields).toContainEqual(expect.objectContaining({ name: '陪玩准备状态', value: expect.stringContaining('小白：⏳ 未就绪') }));
    expect(JSON.stringify(payload)).not.toContain('客户未就绪');
  });

  test('readiness timeout reminder names only pending players and never asks the customer to confirm', async () => {
    const sent: string[] = [];
    const store: SupportResponseJobStore = {
      getReminder: () => ({
        taskId: 'task-m19',
        channelId: '710000000000000001',
        publicId: 'TASK-P-M19-READY',
        createdAt: notBefore,
        state: 'WAITING',
        reasonCode: 'READINESS_TIMEOUT',
        readiness: { waitMinutes: 10, pendingPlayers: ['小白'], activePlayerCount: 2 }
      }),
      markOverdue: () => false
    };
    await createSupportResponseReminderHandler({ store, send: async (message) => sent.push(message.content) })(job());
    expect(sent).toEqual([
      '订单匹配成功后已超过 10 分钟，仍有陪玩未确认开始：小白。系统已自动请求客服介入，请留意后续处理消息。任务编号：TASK-P-M19-READY。'
    ]);
    expect(sent[0]).not.toMatch(/您尚未|客户|双方/);
  });

  test('support order preview renders per-player readiness instead of customer readiness', () => {
    const html = renderToStaticMarkup(createElement(SupportOrderContextPreview, { context: {
      order: { id: 'order-m19', publicId: 'P-M19-003', version: 8, status: 'ACCEPTED' },
      readiness: {
        participants: [
          { participantId: 'p1', displayName: '阿灰', readiness: 'READY' },
          { participantId: 'p2', displayName: '小白', readiness: 'NOT_READY' }
        ],
        allActivePlayersReady: false,
        readyDeadlineAt: '2026-08-08T12:10:00.000Z',
        startedAt: null
      }
    } }));
    expect(html).toContain('阿灰：已就绪');
    expect(html).toContain('小白：未就绪');
    expect(html).not.toMatch(/用户 READY|用户 NOT_READY|客户：(已|未)就绪/);
  });
});

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' }
  });
}

function job(): OutboxJob {
  return {
    id: 'job-m19', type: 'SUPPORT_RESPONSE_REMINDER', aggregateType: 'staff_task', aggregateId: 'task-m19',
    dedupeKey: 'm19', payload: { staffTaskId: 'task-m19' }, status: 'PROCESSING', attempts: 1, maxAttempts: 8,
    availableAt: notBefore, lockedAt: notBefore, lockedBy: 'worker', lastError: null, createdAt: notBefore, updatedAt: notBefore
  };
}
