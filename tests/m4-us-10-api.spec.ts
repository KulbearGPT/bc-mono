import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryBotConfigStore,
  type BotConfigDiscordAdapter,
  type BotConfigSnapshot
} from '@blackcat/api/bot-config';
import {
  InMemoryGiftStore,
  captureApprovedGift,
  type GiftRequestRecord,
  type GiftReservationRecord,
  type GiftStaffTaskRecord
} from '@blackcat/api/gifts';
import { InMemoryAuditSink, type StaffAccount } from '@blackcat/api/security';

const guildId = '900000000000001000';
const channelId = '900000000000001100';
const replacementChannelId = '900000000000001101';
const roleId = '900000000000001200';
const replacementRoleId = '900000000000001201';
const now = new Date('2026-07-18T20:00:00.000Z');
const accounts: Record<string, StaffAccount> = {
  l1: { staffId: '00000000-0000-0000-0000-000000010001', userId: '00000000-0000-0000-0000-000000010011', level: 'L1_SUPPORT', permissionsVersion: 1, status: 'ACTIVE' },
  l3: { staffId: '00000000-0000-0000-0000-000000010003', userId: '00000000-0000-0000-0000-000000010013', level: 'L3_OPERATIONS', permissionsVersion: 1, status: 'ACTIVE' },
  l4: { staffId: '00000000-0000-0000-0000-000000010004', userId: '00000000-0000-0000-0000-000000010014', level: 'L4_ADMIN_OWNER', permissionsVersion: 1, status: 'ACTIVE' }
};

const initial: BotConfigSnapshot = {
  guildId,
  version: 1,
  values: {
    gift_broadcast_channel_id: channelId,
    staff_l4_role_id: roleId,
    dispatch_timeout_minutes: 5,
    auto_dispatch_enabled: true
  },
  updatedByStaffId: accounts.l4.staffId,
  updatedAt: now.toISOString()
};

class FakeDiscordAdapter implements BotConfigDiscordAdapter {
  deliveries: Array<{ guildId: string; channelId: string }> = [];
  invalidIds = new Set<string>();

  async validateObject(input: { guildId: string; field: string; value: string }) {
    return this.invalidIds.has(input.value)
      ? { ok: false as const, code: 'MISSING_BOT_PERMISSION', message: 'Bot cannot send to this channel.' }
      : { ok: true as const };
  }

  async sendTestMessage(input: { guildId: string; channelId: string }) {
    this.deliveries.push(input);
    return { messageId: '900000000000001999' };
  }
}

function fixture() {
  const store = new InMemoryBotConfigStore({ snapshots: [initial] });
  const discord = new FakeDiscordAdapter();
  const audit = new InMemoryAuditSink();
  let clock = now;
  const directory = { resolveByDiscord: ({ discordUserId }: { discordUserId: string }) => accounts[discordUserId] ?? null };
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { staffDirectory: directory, auditSink: audit },
    botConfig: { store, discord, validationSecret: 'test-validation-secret-at-least-32-bytes', now: () => clock }
  });
  return { server, store, discord, audit, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); } };
}

function headers(actor: keyof typeof accounts, write = false) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': actor,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': `900000000000009${actor === 'l1' ? '001' : actor === 'l3' ? '003' : '004'}`,
    ...(write ? { 'idempotency-key': `m4-us-10-${actor}-${crypto.randomUUID()}` } : {})
  };
}

async function validate(server: ReturnType<typeof buildApiServer>, actor: 'l3' | 'l4', changes: Record<string, unknown>, expectedVersion = 1) {
  return server.inject({ method: 'POST', url: '/api/v1/admin/bot-config/validate', headers: headers(actor, true), payload: { guildId, expectedVersion, changes, reason: 'Approved configuration change.' } });
}

describe('M4-US-10 Bot configuration API', () => {
  test('keeps the four reusable operation contracts identical in both OpenAPI mirrors', () => {
    const docs = readFileSync('docs/P0开发交付包/02-API/openapi.yaml', 'utf8');
    const output = readFileSync('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8');
    expect(output).toBe(docs);
    for (const operationId of ['getBotConfig', 'updateBotConfig', 'validateBotConfigChange', 'testBotConfigDelivery']) expect(docs).toContain(`operationId: ${operationId}`);
    expect(docs).toContain('x-validation-token-required: true');
    expect(docs).toContain('permission: bot_config.security.manage');
  });

  test('AT-CFG-001/002 exposes manageable fields to L3 and cumulative L4', async () => {
    const { server } = fixture();
    const [l1, l3, l4] = await Promise.all([
      server.inject({ method: 'GET', url: `/api/v1/admin/bot-config?guildId=${guildId}`, headers: headers('l1') }),
      server.inject({ method: 'GET', url: `/api/v1/admin/bot-config?guildId=${guildId}`, headers: headers('l3') }),
      server.inject({ method: 'GET', url: `/api/v1/admin/bot-config?guildId=${guildId}`, headers: headers('l4') })
    ]);
    expect(l1.statusCode).toBe(403);
    expect(l3.statusCode).toBe(200);
    expect(l3.json().data.manageableFields).toContain('gift_broadcast_channel_id');
    expect(l3.json().data.manageableFields).not.toContain('staff_l4_role_id');
    expect(l4.json().data.manageableFields).toEqual(expect.arrayContaining(['gift_broadcast_channel_id', 'staff_l4_role_id']));
  });

  test('AT-CFG-009 allows trusted Bot startup to reload a Guild without impersonating staff', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: `/api/v1/admin/bot-config?guildId=${guildId}`, headers: { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ guildId, version: 1, values: { gift_broadcast_channel_id: channelId } });
  });

  test('returns a controlled validation error for malformed Guild input', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/bot-config?guildId=bad', headers: headers('l3') });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.json().requestId).toMatch(/^req_/);
  });

  test('AT-CFG-003 rejects L3 Role validation and update at the API boundary', async () => {
    const { server, store } = fixture();
    const preview = await validate(server, 'l3', { staff_l4_role_id: '900000000000001201' });
    expect(preview.statusCode).toBe(403);
    const update = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, changes: { staff_l4_role_id: '900000000000001201' }, reason: 'Unauthorized Role change.', validationToken: 'x'.repeat(32) } });
    expect(update.statusCode).toBe(403);
    expect(store.snapshot(guildId)?.version).toBe(1);
  });

  test('AT-CFG-005 returns a non-applicable preview for invalid Discord objects', async () => {
    const { server, discord, store } = fixture();
    discord.invalidIds.add(replacementChannelId);
    const response = await validate(server, 'l3', { gift_broadcast_channel_id: replacementChannelId });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ mayApply: false, validationToken: null, validationExpiresAt: null });
    expect(response.json().data.errors[0]).toMatchObject({ field: 'gift_broadcast_channel_id', code: 'MISSING_BOT_PERMISSION' });
    expect(store.snapshot(guildId)?.version).toBe(1);
  });

  test('AT-CFG-006 requires an unexpired preview token bound to actor, Guild, version, changes and reason', async () => {
    const { server, advance } = fixture();
    const preview = await validate(server, 'l3', { gift_broadcast_channel_id: replacementChannelId });
    expect(preview.statusCode).toBe(200);
    const token = preview.json().data.validationToken as string;
    expect(token.length).toBeGreaterThanOrEqual(32);

    const missing = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, changes: { gift_broadcast_channel_id: replacementChannelId }, reason: 'Approved configuration change.', validationToken: '' } });
    expect(missing.statusCode).toBe(400);
    const changed = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, changes: { gift_broadcast_channel_id: channelId }, reason: 'Approved configuration change.', validationToken: token } });
    expect(changed.statusCode).toBe(422);
    advance(5 * 60_000 + 1);
    const expired = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, changes: { gift_broadcast_channel_id: replacementChannelId }, reason: 'Approved configuration change.', validationToken: token } });
    expect(expired.statusCode).toBe(422);
  });

  test('AT-CFG-001/008 applies a previewed change, appends event/audit, and immediately serves the new value', async () => {
    const { server, store, audit } = fixture();
    const preview = await validate(server, 'l3', { gift_broadcast_channel_id: replacementChannelId });
    const update = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, changes: { gift_broadcast_channel_id: replacementChannelId }, reason: 'Approved configuration change.', validationToken: preview.json().data.validationToken } });
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toMatchObject({ guildId, previousVersion: 1, version: 2 });
    expect(store.snapshot(guildId)?.values.gift_broadcast_channel_id).toBe(replacementChannelId);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ guildId, version: 2, previousValues: { gift_broadcast_channel_id: channelId }, actorStaffId: accounts.l3.staffId, source: 'DISCORD_BOT' });
    expect(audit.records.at(-1)).toMatchObject({ permissionCode: 'bot_config.operational.manage', action: 'UPDATE_BOT_CONFIG', outcome: 'SUCCEEDED' });
    const current = await server.inject({ method: 'GET', url: `/api/v1/admin/bot-config?guildId=${guildId}`, headers: headers('l3') });
    expect(current.json().data).toMatchObject({ version: 2, values: { gift_broadcast_channel_id: replacementChannelId } });
  });

  test('AT-CFG-003 lets L4 replace a canonical staff Role mapping', async () => {
    const { server, store } = fixture();
    const preview = await validate(server, 'l4', { staff_l4_role_id: replacementRoleId });
    const update = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l4', true), payload: {
      guildId, expectedVersion: 1, changes: { staff_l4_role_id: replacementRoleId },
      reason: 'Approved configuration change.', validationToken: preview.json().data.validationToken
    } });

    expect(update.statusCode).toBe(200);
    expect(store.roleMapping(guildId, 'staff_l4_role_id')).toBe(replacementRoleId);
  });

  test('AT-CFG-001 uses the updated gift channel on the next real business action', async () => {
    const config = new InMemoryBotConfigStore({ snapshots: [{
      ...initial,
      version: 2,
      values: { ...initial.values, gift_broadcast_channel_id: replacementChannelId }
    }] });
    const gift = approvedGiftFixture();
    const store = new InMemoryGiftStore({
      requests: [gift.request], reservations: [gift.reservation], staffTasks: [gift.task],
      externalUserIds: { [gift.request.senderId]: 'mock-user-ok' },
      displayNames: { [gift.request.senderId]: '用户小林', [gift.request.receiverId]: '陪玩阿青' },
      guildIdsByOrder: { [gift.request.orderId]: guildId }
    });
    await captureApprovedGift({ store,
      broadcastChannelId: channelId, botConfigStore: config, giftRequestId: gift.request.id, now });

    expect(store.broadcasts[0]?.payload).toMatchObject({ channelId: replacementChannelId });
  });

  test('AT-CFG-007 rejects a stale preview without overwriting a newer value', async () => {
    const { server, store } = fixture();
    const stalePreview = await validate(server, 'l3', { gift_broadcast_channel_id: replacementChannelId });
    const l4Preview = await validate(server, 'l4', { auto_dispatch_enabled: false });
    const first = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l4', true), payload: { guildId, expectedVersion: 1, changes: { auto_dispatch_enabled: false }, reason: 'Approved configuration change.', validationToken: l4Preview.json().data.validationToken } });
    expect(first.statusCode).toBe(200);
    const stale = await server.inject({ method: 'PATCH', url: '/api/v1/admin/bot-config', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, changes: { gift_broadcast_channel_id: replacementChannelId }, reason: 'Approved configuration change.', validationToken: stalePreview.json().data.validationToken } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONFIG_VERSION_CONFLICT');
    expect(store.snapshot(guildId)?.values).toMatchObject({ gift_broadcast_channel_id: channelId, auto_dispatch_enabled: false });
  });

  test('AT-CFG-005 test delivery sends only a marked Discord test message', async () => {
    const { server, discord, store } = fixture();
    const response = await server.inject({ method: 'POST', url: '/api/v1/admin/bot-config/test-delivery', headers: headers('l3', true), payload: { guildId, expectedVersion: 1, channelField: 'gift_broadcast_channel_id', channelId, reason: 'Verify Discord delivery.' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ guildId, version: 1, channelField: 'gift_broadcast_channel_id', channelId, delivered: true, messageId: '900000000000001999' });
    expect(discord.deliveries).toMatchObject([{ guildId, channelId }]);
    expect(store.snapshot(guildId)?.version).toBe(1);
    expect(store.events).toHaveLength(0);
  });
});

function approvedGiftFixture(): { request: GiftRequestRecord; reservation: GiftReservationRecord; task: GiftStaffTaskRecord } {
  const request: GiftRequestRecord = {
    id: '00000000-0000-0000-0000-000000010100', publicId: 'G-10100',
    orderId: '00000000-0000-0000-0000-000000010101', giftCatalogVersionId: '00000000-0000-0000-0000-000000010102',
    senderId: '00000000-0000-0000-0000-000000010103', receiverId: '00000000-0000-0000-0000-000000010104',
    status: 'APPROVED', version: 3, giftCodeSnapshot: 'STAR', giftNameSnapshot: '星光礼盒', priceMinor: 5000,
    currency: 'USD', broadcastTemplateSnapshot: '{sender_name} 送给 {receiver_name} {gift_name}',
    verifiedByStaffId: accounts.l3.staffId, verifiedAt: now.toISOString(), verificationNote: 'confirmed',
    verificationPayloadHash: 'hash', executionCredentialExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    approvedByStaffId: accounts.l3.staffId, approvedAt: now.toISOString(), rejectedReason: null,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const reservation: GiftReservationRecord = {
    id: '00000000-0000-0000-0000-000000010105', userId: request.senderId, sourceType: 'GIFT', orderId: null,
    giftRequestId: request.id, mode: 'LOCAL_RESERVATION', provider: 'mock-provider', providerHoldRef: null,
    amountMinor: request.priceMinor, currency: 'USD', status: 'ACTIVE', version: 2, idempotencyKey: 'gift:10100',
    expiresAt: request.expiresAt, activatedAt: now.toISOString(), settledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const task: GiftStaffTaskRecord = {
    id: '00000000-0000-0000-0000-000000010106', publicId: 'T-GIFT-10106', type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED',
    status: 'APPROVED', version: 3, orderId: request.orderId, giftRequestId: request.id, claimedBy: accounts.l3.staffId,
    voiceChannelId: '900000000000001300', contextSnapshot: {
      orderId: request.orderId, orderPublicId: 'P-10101', channelId: '900000000000001301', voiceChannelId: '900000000000001300',
      senderId: request.senderId, receiverId: request.receiverId, giftCode: request.giftCodeSnapshot,
      giftName: request.giftNameSnapshot, priceMinor: request.priceMinor, currency: request.currency, reservationId: reservation.id
    }, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  return { request, reservation, task };
}
