import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  InMemorySelectionPoolStore,
  type SelectionPoolRecord
} from '@blackcat/api/selection-pools';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import {
  buildSelectionReactionBindings,
  buildSelectionReactionOfferPayload,
  DiscordSelectionPoolAdapter,
  PostgresSelectionPoolWorkerStore
} from '@blackcat/api/selection-pool-worker';
import {
  handleSelectionReactionEvent,
  reconcileSelectionReactionCards
} from '../apps/bot/src/selection-reactions.js';

const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-000000116001';
const poolId = '00000000-0000-0000-0000-000000116002';
const customerDiscordUserId = '111111111111111111';
const playerDiscordUserId = '222222222222222222';
const channelId = '333333333333333333';
const messageId = '444444444444444444';

describe('M11-US-06 numeric reaction signup', () => {
  test('keeps the reaction contract mirrored and explicit', async () => {
    const [spec, outputApi, docsApi, outputBacklog, docsBacklog, outputAcceptance, docsAcceptance, dockerfile] =
      await Promise.all([
        readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8'),
        readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
        readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
        readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
        readFile('docs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
        readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8'),
        readFile('docs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8'),
        readFile('Dockerfile', 'utf8')
      ]);

    expect(outputApi).toBe(docsApi);
    expect(outputBacklog).toBe(docsBacklog);
    expect(outputAcceptance).toBe(docsAcceptance);
    expect(spec).toContain('1️⃣');
    expect(spec).toContain('9️⃣');
    expect(spec).toContain('不得拆卡、分页、截断');
    expect(outputBacklog).toContain('M11-US-06');
    expect(outputAcceptance).toContain('AT-SEL-008');
    expect(outputAcceptance).toContain('AT-SEL-009');
    expect(spec).toContain('正在派单');
    expect(spec).toContain('本单流单');
    expect(spec).toContain('终止招募”进入 <code>SELECTION</code> 不属于取消');
    expect(outputApi).toContain('operationId: observeOrderSelectionReaction');
    expect(outputApi).toContain('operationId: listActiveOrderSelectionReactionCards');
    expect(dockerfile).toContain('COPY --from=build /app/apps/api/assets ./apps/api/assets');
  });

  test('renders one reaction-only card for one through nine requirements and rejects ten', () => {
    const requirements = Array.from({ length: 9 }, (_, index) => requirement(index));
    const bindings = buildSelectionReactionBindings(requirements);
    expect(bindings.map((binding) => binding.emoji)).toEqual([
      '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'
    ]);

    const payload = buildSelectionReactionOfferPayload({
      poolId,
      orderPublicId: 'P-REACTION',
      requirements
    });
    expect(payload.components).toEqual([]);
    expect(JSON.stringify(payload)).toContain('1️⃣');
    expect(JSON.stringify(payload)).toContain('9️⃣');
    expect(JSON.stringify(payload)).not.toContain('STRING_SELECT');
    expect(() => buildSelectionReactionBindings([...requirements, requirement(9)])).toThrow(
      /at most 9/u
    );
  });

  test('converts the mapped legacy dropdown in place and disables duplicate dropdown cards', async () => {
    const duplicateMessageId = '444444444444444443';
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const legacyCustomId = `bc:sp:m:${shortId(orderId)}:${shortId(poolId)}:v1`;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = requestPayload(init?.body);
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.includes('/messages?limit=100')) return Response.json([
        legacyDropdownMessage(duplicateMessageId, legacyCustomId),
        legacyDropdownMessage(messageId, legacyCustomId)
      ]);
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });

    const result = await adapter.syncRecruitmentCard(reactionProjection(messageId));

    expect(result.messageId).toBe(messageId);
    const canonicalPatch = calls.find((call) =>
      call.method === 'PATCH' && call.url.endsWith(`/messages/${messageId}`));
    expect(canonicalPatch?.body?.components).toEqual([]);
    expect(JSON.stringify(canonicalPatch?.body)).toContain(`selection-pool:${poolId}`);
    const duplicatePatch = calls.find((call) =>
      call.method === 'PATCH' && call.url.endsWith(`/messages/${duplicateMessageId}`));
    expect(duplicatePatch?.body?.components).toEqual([]);
    expect(JSON.stringify(duplicatePatch?.body)).toContain('重复报名卡已停用');
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'PUT',
      url: expect.stringContaining(`/messages/${messageId}/reactions/`)
    }));
  });

  test('reuses an unmapped legacy dropdown instead of posting another recruitment card', async () => {
    const legacyMessageId = '444444444444444442';
    const legacyCustomId = `bc:sp:m:${shortId(orderId)}:${shortId(poolId)}:v1`;
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.includes('/messages?limit=100'))
        return Response.json([legacyDropdownMessage(legacyMessageId, legacyCustomId)]);
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });

    const result = await adapter.syncRecruitmentCard(reactionProjection(null));

    expect(result.messageId).toBe(legacyMessageId);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/messages'))).toBe(false);
  });

  test('startup normalization also queues collecting pools that already have a message mapping', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: poolId }] });
    const store = new PostgresSelectionPoolWorkerStore({ query } as never);

    await expect(store.enqueueRecruitmentCardNormalization(
      new Date('2026-08-08T12:00:00.000Z')
    )).resolves.toBe(1);

    expect(query.mock.calls[0]?.[0]).toContain("WHERE pool.status='COLLECTING'");
    expect(query.mock.calls[0]?.[0]).not.toContain('recruitment_message_id IS NULL');
    expect(query.mock.calls[0]?.[0]).toContain('selection-reaction-card-normalize-v2:');
  });

  test('uses the whole-order boss note when a project has no more specific note', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresSelectionPoolWorkerStore({ query } as never);

    await expect(store.projection(poolId)).resolves.toBeNull();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain(
      "COALESCE(NULLIF(BTRIM(requirement.customer_note),''),NULLIF(BTRIM(orders.customer_note),''))"
    );
  });

  test('posts the dispatching image before the unchanged recruitment embed and deduplicates by order', async () => {
    const requests: Array<{ method: string; url: string; body: BodyInit | null | undefined }> = [];
    const statusNonce = createHash('sha256')
      .update(`selection-dispatching:${orderId}`)
      .digest('hex')
      .slice(0, 24);
    let statusExists = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method ?? 'GET', url, body: init?.body });
      if (url.includes('/messages?limit=100'))
        return Response.json(statusExists ? [{ id: 'status-image', nonce: statusNonce }] : []);
      if (init?.method === 'POST' && init.body instanceof FormData) {
        statusExists = true;
        return Response.json({ id: 'status-image' });
      }
      if (init?.method === 'POST') return Response.json({ id: messageId });
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token', apiBaseUrl: 'https://discord.test', fetch: fetcher as typeof fetch
    });

    await adapter.syncRecruitmentCard(reactionProjection(null));
    await adapter.syncRecruitmentCard(reactionProjection(null));

    const posts = requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts[0]?.body).toBeInstanceOf(FormData);
    const form = posts[0]!.body as FormData;
    const attachment = form.get('files[0]');
    expect(attachment).toBeInstanceOf(Blob);
    expect((attachment as File).name).toBe('blackcat-dispatching.png');
    expect(JSON.parse(String(form.get('payload_json')))).toMatchObject({
      nonce: statusNonce,
      enforce_nonce: true,
      attachments: [{ id: 0, filename: 'blackcat-dispatching.png' }]
    });
    expect(posts[1]?.body).toBeInstanceOf(FormData);
    const recruitmentForm = posts[1]!.body as FormData;
    const embedPayload = JSON.parse(String(recruitmentForm.get('payload_json')));
    expect(embedPayload.components).toEqual([]);
    expect(embedPayload.embeds[0]).toMatchObject({ title: '🐾 新单报名 #P-REACTION' });
    expect(embedPayload.embeds[0].image).toEqual({ url: 'attachment://blackcat-game-other.webp' });
    expect((recruitmentForm.get('files[0]') as File).name).toBe('blackcat-game-other.webp');
    expect(posts.filter((request) => request.body instanceof FormData)).toHaveLength(3);
    expect(posts.filter((request) => {
      if (!(request.body instanceof FormData)) return false;
      return (request.body.get('files[0]') as File).name === 'blackcat-dispatching.png';
    })).toHaveLength(1);
  });

  test('posts the sad image only for a truly cancelled order', async () => {
    const forms: FormData[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/messages?limit=100')) return Response.json([]);
      if (init?.body instanceof FormData) {
        forms.push(init.body);
        return Response.json({ id: 'cancel-image' });
      }
      if (init?.method === 'PATCH') return Response.json({ id: messageId });
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token', apiBaseUrl: 'https://discord.test', fetch: fetcher as typeof fetch
    });

    await adapter.sync({
      ...reactionProjection(messageId),
      poolStatus: 'CANCELLED',
      orderStatus: 'CANCELLED'
    }, 'CANCELLED', '2026-08-08T12:05:00.000Z');

    expect(forms).toHaveLength(1);
    const file = forms[0]!.get('files[0]');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('blackcat-order-cancelled.png');
    expect(JSON.parse(String(forms[0]!.get('payload_json')))).toMatchObject({
      enforce_nonce: true,
      attachments: [{ id: 0, filename: 'blackcat-order-cancelled.png' }]
    });
  });

  test('rejects starting a round with ten remaining requirement rows before any pool write', () => {
    const store = fixtureStore(10);
    expect(() => store.createPool({
      orderId,
      actorGuildId: guildId,
      actorDiscordUserId: customerDiscordUserId,
      expectedOrderVersion: 1,
      idempotencyKey: 'reaction:create:too-many',
      now: new Date('2026-08-08T12:00:00.000Z')
    })).toThrow(/at most 9/u);
    expect(store.pools).toHaveLength(0);
  });

  test('adds, removes, and re-adds the mapped requirement idempotently', async () => {
    const store = fixtureStore(1, [reactionPool()]);
    const added = await commit(store.observeReaction(observation('ADDED', 'reaction:add:1')));
    expect(added).toMatchObject({ changed: true, state: 'APPLIED' });
    expect(store.applications).toHaveLength(1);

    const duplicate = await commit(store.observeReaction(observation('ADDED', 'reaction:add:2')));
    expect(duplicate).toMatchObject({ changed: false, state: 'APPLIED' });
    expect(store.applications).toHaveLength(1);

    const removed = await commit(store.observeReaction(observation('REMOVED', 'reaction:remove:1')));
    expect(removed).toMatchObject({ changed: true, state: 'WITHDRAWN' });

    const readded = await commit(store.observeReaction(observation('ADDED', 'reaction:add:3')));
    expect(readded).toMatchObject({ changed: true, state: 'APPLIED' });
    expect(readded.application?.version).toBe(3);
    expect(store.applications).toHaveLength(1);
  });

  test('accepts only actor-scoped observations and exposes reconciliation to the restricted service actor', async () => {
    const store = fixtureStore(1, [reactionPool()]);
    const server = buildApiServer({
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '',
        API_PORT: '0',
        API_BASE_URL: 'http://localhost',
        BOT_SERVICE_TOKEN: 'valid-bot-token'
      },
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore()
      },
      selectionPools: { store, now: () => new Date('2026-08-08T12:01:00.000Z') }
    });
    const observed = await server.inject({
      method: 'PUT',
      url: '/api/v1/internal/discord/selection-reactions',
      headers: actorHeaders('reaction-route-add'),
      payload: { channelId, messageId, emoji: '1️⃣', state: 'ADDED' }
    });
    expect(observed.statusCode, observed.body).toBe(200);
    expect(observed.json().data).toMatchObject({ changed: true, state: 'APPLIED' });

    const forged = await server.inject({
      method: 'PUT',
      url: '/api/v1/internal/discord/selection-reactions',
      headers: actorHeaders('reaction-route-forged'),
      payload: { channelId, messageId, emoji: '1️⃣', state: 'ADDED', orderRequirementId: requirement(0).id }
    });
    expect(forged.statusCode).toBe(400);

    const cards = await server.inject({
      method: 'GET',
      url: `/api/v1/internal/discord/selection-reaction-cards?guildId=${guildId}`,
      headers: { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT' }
    });
    expect(cards.statusCode, cards.body).toBe(200);
    expect(cards.json().data.items[0]).toMatchObject({
      poolId,
      bindings: [expect.objectContaining({ appliedDiscordUserIds: [playerDiscordUserId] })]
    });
    await server.close();
  });

  test('forwards supported add/remove observations and removes an unconfirmed add reaction', async () => {
    const observeSelectionReaction = vi.fn().mockResolvedValueOnce({ changed: true, state: 'APPLIED' })
      .mockRejectedValueOnce(new Error('api unavailable'));
    const remove = vi.fn();
    const send = vi.fn();
    const base = {
      reaction: {
        partial: false,
        emoji: { name: '1️⃣' },
        message: { id: messageId, channelId, guildId }
      },
      user: { id: playerDiscordUserId, bot: false, send },
      api: { observeSelectionReaction },
      logger: { error: vi.fn() }
    };

    await handleSelectionReactionEvent({ ...base, state: 'ADDED', removeUserReaction: remove });
    await handleSelectionReactionEvent({ ...base, state: 'ADDED', removeUserReaction: remove });

    expect(observeSelectionReaction).toHaveBeenCalledWith(
      { channelId, messageId, emoji: '1️⃣', state: 'ADDED' },
      expect.objectContaining({ guildId, discordUserId: playerDiscordUserId }),
      expect.any(String)
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('报名未能确认'));
  });

  test('serializes rapid add then remove events for the same user and project', async () => {
    const states: string[] = [];
    let releaseAdd!: () => void;
    const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
    const observeSelectionReaction = vi.fn(async (input: { state: string }) => {
      states.push(`${input.state}:start`);
      if (input.state === 'ADDED') await addGate;
      states.push(`${input.state}:finish`);
      return { changed: true, state: input.state === 'ADDED' ? 'APPLIED' : 'WITHDRAWN' };
    });
    const base = {
      reaction: { emoji: { name: '1️⃣' }, message: { id: messageId, channelId, guildId } },
      user: { id: playerDiscordUserId, bot: false, send: vi.fn() },
      api: { observeSelectionReaction },
      logger: { error: vi.fn() },
      removeUserReaction: vi.fn()
    };
    const added = handleSelectionReactionEvent({ ...base, state: 'ADDED' });
    const removed = handleSelectionReactionEvent({ ...base, state: 'REMOVED' });
    await Promise.resolve();
    expect(states).toEqual(['ADDED:start']);
    releaseAdd();
    await Promise.all([added, removed]);
    expect(states).toEqual(['ADDED:start', 'ADDED:finish', 'REMOVED:start', 'REMOVED:finish']);
  });

  test('startup reconciliation submits both Discord-only adds and database-only removals', async () => {
    const observeSelectionReaction = vi.fn(async () => ({ changed: true, state: 'APPLIED' }));
    const api = {
      listActiveSelectionReactionCards: vi.fn(async () => ({ items: [{
        guildId,
        channelId,
        messageId,
        poolId,
        bindings: [{
          emoji: '1️⃣',
          orderRequirementId: requirement(0).id,
          label: '项目 1',
          appliedDiscordUserIds: [playerDiscordUserId]
        }]
      }] })),
      observeSelectionReaction
    };
    const result = await reconcileSelectionReactionCards({
      guildId,
      api,
      fetchReactionUserIds: vi.fn(async () => ['555555555555555555']),
      logger: { error: vi.fn() }
    });

    expect(result).toEqual({ added: 1, removed: 1, failed: 0 });
    expect(observeSelectionReaction.mock.calls.map((call) => call[0].state).sort()).toEqual([
      'ADDED', 'REMOVED'
    ]);
  });
});

function requirement(index: number) {
  return {
    id: `00000000-0000-0000-0000-${String(116100 + index).padStart(12, '0')}`,
    label: `项目 ${index + 1}`,
    remainingSlots: 1,
    expectedEarningMinor: 100,
    currency: 'CAT'
  };
}

function requestPayload(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof FormData) return JSON.parse(String(body.get('payload_json'))) as Record<string, unknown>;
  return null;
}

function reactionProjection(recruitmentMessageId: string | null) {
  return {
    poolId,
    poolVersion: 1,
    poolStatus: 'COLLECTING',
    recruitmentChannelId: channelId,
    recruitmentMessageId,
    reactionBindings: [{ emoji: '1️⃣', orderRequirementId: requirement(0).id, label: '项目 1' }],
    orderId,
    orderPublicId: 'P-REACTION',
    orderStatus: 'PENDING_DISPATCH',
    orderVersion: 1,
    guildId,
    orderChannelId: '111111111111111110',
    selectionVoiceChannelId: null,
    voiceChannelId: null,
    customerUserId: '00000000-0000-0000-0000-000000116400',
    customerDiscordUserId,
    dispatchChannelId: channelId,
    staffTaskChannelId: '555555555555555555',
    privateOrderCategoryId: null,
    staffRoleIds: [],
    applicants: [],
    selectedPlayers: [],
    selectedDiscordUserIds: [],
    requirements: [requirement(0)]
  };
}

function legacyDropdownMessage(id: string, customId: string) {
  return {
    id,
    embeds: [{ title: '候选池 #P-REACTION' }],
    components: [{ type: 1, components: [{ type: 3, custom_id: customId }] }]
  };
}

function shortId(uuid: string) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url');
}

function reactionPool(): SelectionPoolRecord {
  return {
    id: poolId,
    orderId,
    round: 1,
    status: 'COLLECTING',
    version: 1,
    waitMinutes: null,
    openedAt: '2026-08-08T12:00:00.000Z',
    closesAt: null,
    closedAt: null,
    closeReason: null,
    applicationCount: 0,
    recruitmentChannelId: channelId,
    recruitmentMessageId: messageId,
    reactionBindings: [{ emoji: '1️⃣', orderRequirementId: requirement(0).id, label: '项目 1' }]
  };
}

function observation(state: 'ADDED' | 'REMOVED', idempotencyKey: string) {
  return {
    actorGuildId: guildId,
    actorDiscordUserId: playerDiscordUserId,
    channelId,
    messageId,
    emoji: '1️⃣',
    state,
    idempotencyKey,
    now: new Date('2026-08-08T12:01:00.000Z')
  };
}

function fixtureStore(requirementCount: number, pools: SelectionPoolRecord[] = []) {
  return new InMemorySelectionPoolStore({
    orders: [{
      id: orderId,
      guildId,
      customerDiscordUserId,
      status: 'PENDING_DISPATCH',
      version: 1,
      reservationId: 'reservation-reaction'
    }],
    requirements: Array.from({ length: requirementCount }, (_, index) => ({
      ...requirement(index),
      orderId,
      status: 'ACTIVE' as const,
      serviceCatalogVersionId: `00000000-0000-0000-0000-${String(116200 + index).padStart(12, '0')}`,
      requestedPlayerCount: 1,
      filledPlayerCount: 0,
      game: 'valorant',
      gameDisplayName: '瓦洛兰特',
      service: 'duo',
      serviceDisplayName: `项目 ${index + 1}`,
      region: null,
      regionDisplayName: null,
      billingUnitMinutes: 60,
      unitCount: 1,
      customerUnitPriceMinor: 200,
      linePriceMinor: 200
    })),
    players: [{
      id: '00000000-0000-0000-0000-000000116300',
      guildId,
      discordUserId: playerDiscordUserId,
      displayName: 'Reaction Player',
      reviewStatus: 'ACTIVE',
      matchingCatalogIds: Array.from({ length: requirementCount }, (_, index) =>
        `00000000-0000-0000-0000-${String(116200 + index).padStart(12, '0')}`),
      activeOrderId: null,
      compensationType: 'PERCENT_BPS',
      compensationValue: 5000
    }],
    pools
  });
}

async function commit<T>(staged: { data: T; commit(audit: never): Promise<void> | void }): Promise<T> {
  await staged.commit({} as never);
  return staged.data;
}

function actorHeaders(key: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': playerDiscordUserId,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '777777777777777777',
    'idempotency-key': `discord:m11:${key}:0001`
  };
}
