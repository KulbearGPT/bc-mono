import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { buildSubmittedOrderMessage } from '@blackcat/bot/service-center';
import {
  buildSelectionCandidateConfirmation,
  buildSelectionCandidatePanel,
  buildSelectionVoicePlan,
  parseSelectionCustomId,
  selectionFinalizeRouteFromConfirmationComponents,
  selectionIdsFromConfirmationComponents
} from '@blackcat/bot/selection-discord';
import {
  createSelectionPoolCloseHandler,
  createSelectionPoolSyncHandler,
  DiscordSelectionPoolAdapter,
  PostgresSelectionPoolWorkerStore,
  SelectionPoolWorkerService
} from '@blackcat/api/selection-pool-worker';
import { BotApiError } from '@blackcat/bot/service-center-api';
import {
  deleteRetiredSelectionChannel,
  RetiredSelectionChannelRegistry
} from '@blackcat/bot/selection-channel-cleanup';
import {
  executeSelectionReselect,
  executeSelectionWaitSelection
} from '../apps/bot/src/pieces/interaction-handlers/selection-selects';

const orderId = '00000000-0000-0000-0000-000000011020';
const poolId = '00000000-0000-0000-0000-000000011040';
const requirementId = '00000000-0000-0000-0000-000000011050';
const applicationId = '00000000-0000-0000-0000-000000011060';

describe('M11-US-03 Discord selection flow', () => {
  test('replaces the start button with the active round immediately after creation', async () => {
    const events: string[] = [];
    const interaction = selectionInteraction(events);
    const api = selectionApi(events, {
      createSelectionPool: vi.fn(async () => {
        events.push('create');
        return { pool: selectionPool() };
      })
    });

    await executeSelectionWaitSelection({
      interaction: interaction as never,
      api,
      actor: selectionActor(),
      route: { action: 'repeat', orderId, poolId: null, expectedPoolVersion: null, expectedOrderVersion: 3 }
    });

    expect(events).toEqual(['read-order', 'create', 'edit']);
    const rendered = JSON.stringify(interaction.editReply.mock.calls[0]?.[0]);
    expect(rendered).toContain('报名进行中');
    expect(rendered).toContain('结束报名，进入试音');
    expect(rendered).not.toContain('bc:sp:new:');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test('does not present a reselect response as a live application counter', async () => {
    const events: string[] = [];
    const interaction = selectionInteraction(events, '5');
    const api = selectionApi(events, {
      createSelectionPool: vi.fn(async () => {
        events.push('create');
        return { pool: { ...selectionPool(), round: 2, waitMinutes: 5 } };
      })
    });

    await executeSelectionWaitSelection({
      interaction: interaction as never,
      api,
      actor: selectionActor(),
      route: { action: 'repeat', orderId, poolId, expectedPoolVersion: 4, expectedOrderVersion: 3 }
    });

    expect(events).toEqual(['read-order', 'create', 'edit']);
    const rendered = JSON.stringify(interaction.editReply.mock.calls[0]?.[0]);
    expect(rendered).toContain('新一轮报名已开始');
    expect(rendered).toContain('实时报名名单会自动同步到订单主卡');
    expect(rendered).toContain('查看实时订单卡');
    expect(rendered).not.toContain('当前报名：0 人');
  });

  test('recovers the active round when a stale start button is clicked', async () => {
    const events: string[] = [];
    const interaction = selectionInteraction(events, '5');
    const api = selectionApi(events, {
      createSelectionPool: vi.fn(async () => {
        events.push('create');
        throw new BotApiError({
          code: 'CONFLICT',
          message: 'The order already has an active selection pool.',
          requestId: 'req-active-pool',
          statusCode: 409
        });
      }),
      getCurrentSelectionPool: vi.fn(async () => {
        events.push('read-pool');
        return { pool: selectionPool() };
      })
    });

    await executeSelectionWaitSelection({
      interaction: interaction as never,
      api,
      actor: selectionActor(),
      route: { action: 'repeat', orderId, poolId: null, expectedPoolVersion: null, expectedOrderVersion: 3 }
    });

    expect(events).toEqual(['read-order', 'create', 'read-pool', 'edit', 'follow-up']);
    expect(JSON.stringify(interaction.editReply.mock.calls[0]?.[0])).toContain('报名进行中');
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('本轮招募已经开始'),
        ephemeral: true
      })
    );
  });

  test('does not let the retired pending-dispatch panel overwrite the wait-time selector', async () => {
    const source = await readFile('apps/api/src/orders.ts', 'utf8');
    const postgres = source.slice(source.indexOf('export class PostgresOrderStore'));
    const commitSubmit = postgres.slice(
      postgres.indexOf('async commitSubmit(input:'),
      postgres.indexOf('async commitCancel(input:')
    );

    expect(commitSubmit).not.toContain('ORDER_SUBMITTED_CHANNEL_SYNC');
    expect(commitSubmit).not.toContain('insertOrderPanelSync');
  });

  test('offers one manual start button without wait-time presets', () => {
    const message = buildSubmittedOrderMessage({
      orderId,
      status: 'PENDING_DISPATCH',
      version: 3,
      reservation: {
        reservationId: '00000000-0000-0000-0000-000000011090',
        amountMinor: 100,
        capturedMinor: 0,
        releasedMinor: 0,
        currency: 'CAT',
        status: 'ACTIVE',
        version: 1,
        expiresAt: '2026-08-04T12:30:00.000Z'
      },
      balance: {
        ledgerBalanceMinor: 1000,
        reservedMinor: 100,
        availableMinor: 900,
        currency: 'CAT',
        calculatedAt: '2026-08-04T12:00:00.000Z'
      }
    });
    const buttons = message.components
      .flatMap((row) => row.components)
      .filter((component) => component.type === 'BUTTON' && component.customId.startsWith('bc:sp:new:'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ label: '开始招募陪玩' });
    expect(JSON.stringify(message)).not.toContain('等待 3 分钟');
  });

  test('renders private customer selection controls under Discord custom-id limits', () => {
    const panel = buildSelectionCandidatePanel({
      orderId,
      poolId,
      poolVersion: 4,
      orderVersion: 7,
      items: [
        {
          id: applicationId,
          playerDisplayName: '奶糖',
          orderRequirementId: requirementId,
          publicGameTags: ['瓦洛兰特'],
          publicServiceTags: ['技术陪玩']
        }
      ],
      nextCursor: null,
      selectedApplicationIds: [applicationId]
    });
    expect(panel.body).not.toMatch(/评分|排名|审核原因/u);
    expect(
      panel.components.flatMap((row) => row.components).every((component) => component.customId.length <= 100)
    ).toBe(true);
  });

  test('requires an explicit customer confirmation before finalizing selected applicants', async () => {
    const confirmation = buildSelectionCandidateConfirmation({
      orderId,
      poolId,
      poolVersion: 4,
      orderVersion: 7,
      selectedCandidates: [
        { id: applicationId, playerDisplayName: 'Kulbear' },
        {
          id: '00000000-0000-0000-0000-000000011061',
          playerDisplayName: 'OnlyMyKulbear'
        }
      ]
    });

    expect(confirmation.visibility).toBe('EPHEMERAL');
    expect(JSON.stringify(confirmation)).toContain('Kulbear');
    expect(JSON.stringify(confirmation)).toContain('OnlyMyKulbear');
    const components = confirmation.components.flatMap((row) => (row.type === 'ACTION_ROW' ? row.components : []));
    const selected = components.find((component) => component.type === 'STRING_SELECT');
    expect(selected).toMatchObject({ disabled: true, minValues: 2, maxValues: 2 });
    expect(selectionIdsFromConfirmationComponents(confirmation.components)).toEqual([
      applicationId,
      '00000000-0000-0000-0000-000000011061'
    ]);
    expect(
      components.some(
        (component) =>
          component.type === 'BUTTON' &&
          component.label === '确认这些陪玩' &&
          parseSelectionCustomId(component.customId).action === 'finalize'
      )
    ).toBe(true);
    expect(
      components.some(
        (component) =>
          component.type === 'BUTTON' &&
          component.label === '修改陪玩名单' &&
          parseSelectionCustomId(component.customId).action === 'reselect'
      )
    ).toBe(true);
    const reselect = components.find((component) => component.type === 'BUTTON' && component.label === '修改陪玩名单');
    expect(parseSelectionCustomId(reselect!.customId)).toMatchObject({
      action: 'reselect',
      expectedPoolVersion: 4,
      expectedOrderVersion: 7
    });
    expect(selectionFinalizeRouteFromConfirmationComponents(confirmation.components)).toMatchObject({
      action: 'finalize',
      orderId,
      poolId,
      expectedPoolVersion: 4,
      expectedOrderVersion: 7
    });
    expect(parseSelectionCustomId(reselect!.customId.replace(/:v4:o7$/u, ''))).toMatchObject({
      action: 'reselect',
      expectedPoolVersion: null,
      expectedOrderVersion: null
    });

    const selectHandler = await readFile('apps/bot/src/pieces/interaction-handlers/selection-selects.ts', 'utf8');
    const buttonHandler = await readFile('apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts', 'utf8');
    expect(selectHandler).not.toContain('api.finalizeSelectionPool(');
    expect(selectHandler).toContain('buildSelectionCandidateConfirmation');
    expect(buttonHandler).toContain('api.finalizeSelectionPool(');
    expect(buttonHandler).toContain('selectionIdsFromConfirmationComponents');
  });

  test('returns a single candidate to a fresh selectable panel and offers a new round', async () => {
    const events: string[] = [];
    const interaction = selectionInteraction(events);
    const api = selectionApi(events, {
      getOrder: vi.fn(async () => {
        throw new Error('reselect must not require the stricter order read');
      }),
      listSelectionApplications: vi.fn(async () => {
        events.push('list-candidates');
        return {
          pool: { ...selectionPool(), status: 'SELECTION' as const, version: 4, applicationCount: 1 },
          items: [
            {
              id: applicationId,
              playerDisplayName: 'Kulbear',
              orderRequirementId: requirementId,
              publicGameTags: [],
              publicServiceTags: []
            }
          ],
          nextCursor: null
        };
      })
    });

    await executeSelectionReselect({
      interaction: interaction as never,
      api,
      actor: selectionActor(),
      route: { action: 'reselect', orderId, poolId, expectedPoolVersion: 4, expectedOrderVersion: 3 }
    });

    expect(events).toEqual(['list-candidates', 'edit']);
    const rendered = JSON.stringify(interaction.editReply.mock.calls[0]?.[0]);
    expect(rendered).toContain('Kulbear');
    expect(rendered).toContain('选择本页入选陪玩');
    expect(rendered).toContain('再发起一轮报名');
    expect(rendered).toContain('bc:sp:r:');
    expect(rendered).toContain(':v4:o3');
    const update = interaction.editReply.mock.calls[0]?.[0];
    expect(update).toHaveProperty('embeds', []);
    expect(update).toHaveProperty('content', null);
  });

  test('builds an unlimited selection room and plans a separate service room after finalization', () => {
    const selection = buildSelectionVoicePlan({
      phase: 'SELECTION',
      guildId: '999999999999999999',
      orderId,
      orderPublicId: 'P-M11',
      customerDiscordUserId: '111111111111111111',
      applicantDiscordUserIds: ['222222222222222222', '333333333333333333'],
      selectedDiscordUserIds: [],
      staffRoleIds: ['444444444444444444'],
      voiceChannelId: null,
      staffTaskChannelId: '555555555555555555'
    });
    expect(selection.userLimit).toBe(0);
    expect(selection.allowMemberIds).toEqual(['111111111111111111', '222222222222222222', '333333333333333333']);
    expect(selection.staffNotice).toContain('客服可以加入试音房');
    const finalized = buildSelectionVoicePlan({
      ...selection.projection,
      phase: 'FINALIZED',
      voiceChannelId: '666666666666666666',
      selectedDiscordUserIds: ['222222222222222222']
    });
    expect(finalized.revokeMemberIds).toEqual(['333333333333333333']);
    expect(finalized.disconnectMemberIds).toEqual(['333333333333333333']);
    expect(finalized.serviceChannelName).toBe('service-p-m11');
    expect(finalized.moveMemberIds).toEqual(['111111111111111111', '222222222222222222']);
  });

  test('enables voice-state cleanup and deletes a retired selection room only after it is empty', async () => {
    const index = await readFile('apps/bot/src/index.ts', 'utf8');
    expect(index).toContain('GatewayIntentBits.GuildVoiceStates');
    const remove = vi.fn().mockResolvedValue(undefined);
    const occupied = {
      id: '666666666666666666',
      guildId: '999999999999999999',
      parentId: '777777777777777777',
      type: 2,
      name: 'selection-p-m11-closing',
      members: { size: 1 },
      delete: remove
    };
    const registry = new RetiredSelectionChannelRegistry();
    const authorization = registry.authorizeTransition({
      oldChannel: { ...occupied, name: 'selection-p-m11' },
      newChannel: occupied,
      configuredCategoryId: '777777777777777777'
    });
    await expect(deleteRetiredSelectionChannel(occupied, authorization)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
    await expect(deleteRetiredSelectionChannel({ ...occupied, members: { size: 0 } }, authorization)).resolves.toBe(
      true
    );
    expect(remove).toHaveBeenCalledWith('Selection finished and the room is empty');
  });

  test('keeps the selection room for a partial finalization that has not reached ACCEPTED', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = requestPayload(init?.body);
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.endsWith('/guilds/999999999999999999/channels')) {
        return Response.json([{ id: '666666666666666666', name: 'selection-p-m11', type: 2, parent_id: null }]);
      }
      if (url.includes('/messages?limit=100')) return Response.json([]);
      if (init?.method === 'POST') return Response.json({ id: '999999999999999998' });
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });

    await expect(
      adapter.sync(
        {
          poolId,
          poolVersion: 3,
          poolStatus: 'FINALIZED',
          orderId,
          orderPublicId: 'P-M11',
          orderStatus: 'PENDING_DISPATCH',
          orderVersion: 2,
          guildId: '999999999999999999',
          orderChannelId: '111111111111111110',
          selectionVoiceChannelId: '666666666666666666',
          voiceChannelId: null,
          customerUserId: '00000000-0000-0000-0000-000000011001',
          customerDiscordUserId: '111111111111111111',
          dispatchChannelId: '222222222222222220',
          staffTaskChannelId: '555555555555555555',
          privateOrderCategoryId: null,
          staffRoleIds: ['444444444444444444'],
          applicants: [],
          selectedPlayers: [{ discordUserId: '222222222222222222', displayName: '已选陪玩' }],
          selectedDiscordUserIds: ['222222222222222222'],
          requirements: []
        },
        'FINALIZED',
        '2026-08-04T12:01:00Z'
      )
    ).resolves.toBe('666666666666666666');

    expect(calls.some((call) => call.method === 'POST' && call.body?.name === 'service-p-m11')).toBe(false);
    expect(calls.some((call) => call.method === 'PATCH' && call.body?.name === 'selection-p-m11-closing')).toBe(false);
  });

  test('replaces a retired selection room before publishing a later-round staff link', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = requestPayload(init?.body);
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.endsWith('/guilds/999999999999999999/channels') && init?.method === 'GET')
        return Response.json([{ id: '666666666666666666', name: 'selection-p-m11-closing', type: 2, parent_id: null }]);
      if (url.endsWith('/guilds/999999999999999999/channels') && init?.method === 'POST')
        return Response.json({ id: '777777777777777777' });
      if (url.includes('/messages?limit=100')) return Response.json([]);
      if (init?.method === 'POST' && url.endsWith('/messages')) return Response.json({ id: '999999999999999998' });
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });
    const projection = {
      poolId,
      poolVersion: 2,
      poolStatus: 'SELECTION',
      orderId,
      orderPublicId: 'P-M11',
      orderStatus: 'PENDING_DISPATCH',
      orderVersion: 4,
      guildId: '999999999999999999',
      orderChannelId: '111111111111111110',
      selectionVoiceChannelId: '666666666666666666',
      voiceChannelId: null,
      customerUserId: '00000000-0000-0000-0000-000000011001',
      customerDiscordUserId: '111111111111111111',
      dispatchChannelId: '222222222222222220',
      staffTaskChannelId: '555555555555555555',
      privateOrderCategoryId: null,
      staffRoleIds: ['444444444444444444'],
      applicants: [
        {
          applicationId,
          discordUserId: '222222222222222222',
          displayName: '奶糖',
          status: 'APPLIED',
          applicationVersion: 1,
          requirementId
        }
      ],
      selectedPlayers: [],
      selectedDiscordUserIds: [],
      requirements: []
    };

    await expect(adapter.sync(projection, 'SELECTION', '2026-08-04T12:00:00Z')).resolves.toBe('777777777777777777');

    expect(calls).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        url: 'https://discord.test/guilds/999999999999999999/channels',
        body: expect.objectContaining({ name: 'selection-p-m11' })
      })
    );
    const staffPost = calls.find(
      (call) => call.method === 'POST' && call.url === 'https://discord.test/channels/555555555555555555/messages'
    );
    expect(JSON.stringify(staffPost?.body)).toContain('777777777777777777');
    expect(JSON.stringify(staffPost?.body)).not.toContain('666666666666666666');
  });

  test('persists a recreated selection room by replacing only the projected stale mapping', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: orderId }] });
    const store = new PostgresSelectionPoolWorkerStore({ query } as never);

    await store.setSelectionVoice(orderId, '777777777777777777', '666666666666666666');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('selection_voice_channel_id IS NOT DISTINCT FROM $3'), [
      orderId,
      '777777777777777777',
      '666666666666666666'
    ]);
  });

  test('passes the projected selection room to the optimistic mapping replacement', async () => {
    const projection = {
      poolId,
      poolVersion: 2,
      poolStatus: 'SELECTION',
      orderId,
      orderPublicId: 'P-M11',
      orderStatus: 'PENDING_DISPATCH',
      orderVersion: 4,
      guildId: '999999999999999999',
      orderChannelId: '111111111111111110',
      selectionVoiceChannelId: '666666666666666666',
      voiceChannelId: null,
      customerUserId: '00000000-0000-0000-0000-000000011001',
      customerDiscordUserId: '111111111111111111',
      dispatchChannelId: '222222222222222220',
      staffTaskChannelId: '555555555555555555',
      privateOrderCategoryId: null,
      staffRoleIds: [],
      applicants: [],
      selectedPlayers: [],
      selectedDiscordUserIds: [],
      requirements: []
    };
    const store = {
      projection: vi.fn().mockResolvedValue(projection),
      setSelectionVoice: vi.fn().mockResolvedValue(undefined)
    };
    const discord = { sync: vi.fn().mockResolvedValue('777777777777777777') };
    const service = new SelectionPoolWorkerService(store as never, discord as never);

    await service.sync(poolId, 'SELECTION', '2026-08-04T12:00:00Z');

    expect(store.setSelectionVoice).toHaveBeenCalledWith(orderId, '777777777777777777', '666666666666666666');
  });

  test('validates close/sync jobs and delegates idempotent work', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const sync = vi.fn().mockResolvedValue(undefined);
    const closeHandler = createSelectionPoolCloseHandler({ close });
    const syncHandler = createSelectionPoolSyncHandler({ sync });
    await closeHandler(job('SELECTION_POOL_CLOSE', { orderId, selectionPoolId: poolId }));
    await syncHandler(
      job('SELECTION_POOL_SYNC', {
        orderId,
        selectionPoolId: poolId,
        phase: 'CANCELLED'
      })
    );
    expect(close).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledWith(poolId, 'CANCELLED', '2026-08-04T12:00:00.000Z');
  });

  test('closes cancelled offers in place and removes applicants from an existing selection room', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const posted: Array<{ id: string; nonce: string; timestamp: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = requestPayload(init?.body);
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.endsWith('/guilds/999999999999999999/channels') && init?.method === 'GET')
        return Response.json([{ id: '666666666666666666', name: 'selection-p-m11', type: 2, parent_id: null }]);
      if (url.includes('/messages?limit=100')) return Response.json(posted);
      if (init?.method === 'POST' && url.endsWith('/messages')) {
        posted.push({
          id: '999999999999999998',
          nonce: String(body?.nonce),
          timestamp: '2026-08-04T12:00:00.000Z'
        });
        return Response.json({ id: '999999999999999998' });
      }
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });
    const projection = {
      poolId,
      poolVersion: 2,
      poolStatus: 'COLLECTING',
      orderId,
      orderPublicId: 'P-M11',
      orderStatus: 'PENDING_DISPATCH',
      orderVersion: 1,
      guildId: '999999999999999999',
      orderChannelId: '111111111111111110',
      voiceChannelId: null,
      customerUserId: '00000000-0000-0000-0000-000000011001',
      customerDiscordUserId: '111111111111111111',
      dispatchChannelId: '222222222222222220',
      staffTaskChannelId: '555555555555555555',
      privateOrderCategoryId: null,
      staffRoleIds: ['444444444444444444'],
      applicants: [],
      selectedPlayers: [],
      selectedDiscordUserIds: [],
      requirements: [
        {
          id: requirementId,
          label: '瓦洛兰特 · 技术陪玩',
          remainingSlots: 1,
          expectedEarningMinor: 120,
          currency: 'CAT'
        }
      ]
    };
    await adapter.sync(projection, 'COLLECTING', '2026-08-04T12:00:00Z');
    await adapter.sync(
      { ...projection, poolStatus: 'CANCELLED', orderStatus: 'CANCELLED' },
      'CANCELLED',
      '2026-08-04T12:01:00Z'
    );

    const patch = calls.find((call) => call.method === 'PATCH' && JSON.stringify(call.body).includes('订单已取消'));
    expect(JSON.stringify(patch?.body)).toContain('订单已取消');
    expect(patch?.body?.components).toEqual([]);
    expect(calls.some((call) => call.url.includes('/guilds/999999999999999999/channels'))).toBe(false);

    const selectionProjection = {
      ...projection,
      poolId: '00000000-0000-0000-0000-000000011041',
      voiceChannelId: '666666666666666666',
      applicants: [
        {
          applicationId,
          discordUserId: '222222222222222222',
          displayName: '奶糖',
          status: 'APPLIED',
          applicationVersion: 1,
          requirementId
        }
      ]
    };
    await adapter.sync(selectionProjection, 'COLLECTING', '2026-08-04T12:02:00Z');
    await adapter.sync({ ...selectionProjection, poolStatus: 'SELECTION' }, 'SELECTION', '2026-08-04T12:03:00Z');
    await adapter.sync(
      { ...selectionProjection, poolStatus: 'CANCELLED', orderStatus: 'CANCELLED' },
      'CANCELLED',
      '2026-08-04T12:04:00Z'
    );

    expect(calls).toContainEqual(
      expect.objectContaining({
        url: expect.stringContaining('/channels/666666666666666666/permissions/222222222222222222'),
        method: 'PUT'
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: expect.stringContaining('/guilds/999999999999999999/members/222222222222222222'),
        method: 'PATCH'
      })
    );
    expect(
      calls.some(
        (call) =>
          call.method === 'PATCH' &&
          call.url.includes('/channels/111111111111111110/messages/') &&
          JSON.stringify(call.body).includes('陪玩选择已经关闭')
      )
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === 'PATCH' &&
          call.url.includes('/channels/555555555555555555/messages/') &&
          JSON.stringify(call.body).includes('订单已取消')
      )
    ).toBe(true);
  });

  test('recreates a missing closed offer and continues publishing the customer candidate panel', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = requestPayload(init?.body);
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.endsWith('/guilds/999999999999999999/channels') && init?.method === 'GET')
        return Response.json([{ id: '666666666666666666', name: 'selection-p-m11', type: 2, parent_id: null }]);
      if (url.includes('/messages?limit=100')) return Response.json([]);
      if (init?.method === 'POST' && url.endsWith('/messages')) return Response.json({ id: `message-${calls.length}` });
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });
    const projection = {
      poolId,
      poolVersion: 2,
      poolStatus: 'SELECTION',
      orderId,
      orderPublicId: 'P-M11',
      orderStatus: 'PENDING_DISPATCH',
      orderVersion: 3,
      guildId: '999999999999999999',
      orderChannelId: '111111111111111110',
      voiceChannelId: '666666666666666666',
      customerUserId: '00000000-0000-0000-0000-000000011001',
      customerDiscordUserId: '111111111111111111',
      dispatchChannelId: '222222222222222220',
      staffTaskChannelId: '555555555555555555',
      privateOrderCategoryId: null,
      staffRoleIds: ['444444444444444444'],
      applicants: [
        {
          applicationId,
          discordUserId: '222222222222222222',
          displayName: '奶糖',
          status: 'APPLIED',
          applicationVersion: 1,
          requirementId
        }
      ],
      selectedPlayers: [],
      selectedDiscordUserIds: [],
      requirements: []
    };

    await expect(adapter.sync(projection, 'SELECTION', '2026-08-04T12:00:00Z')).resolves.toBe('666666666666666666');

    const posts = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/messages'));
    expect(posts).toHaveLength(3);
    expect(JSON.stringify(posts[0]?.body)).toContain('报名已结束');
    expect(JSON.stringify(posts[1]?.body)).toContain('<@222222222222222222>');
    expect(JSON.stringify(posts[1]?.body)).toContain('bc:sp:s:');
    expect(JSON.stringify(posts[1]?.body)).toContain('bc:sp:r:');
    expect(JSON.stringify(posts[1]?.body)).toContain('本轮暂无合适陪玩，再发起一轮报名');
    expect(JSON.stringify(posts[2]?.body)).toContain('已进入试音匹配');
  });

  test('creates one recovery task only on the terminal Discord sync attempt', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('Discord unavailable'));
    const terminalFailure = vi.fn().mockResolvedValue(undefined);
    const handler = createSelectionPoolSyncHandler({
      sync,
      onTerminalFailure: terminalFailure
    });
    await expect(
      handler({
        ...job('SELECTION_POOL_SYNC', {
          orderId,
          selectionPoolId: poolId,
          phase: 'FINALIZED'
        }),
        attempts: 7,
        maxAttempts: 8
      })
    ).rejects.toThrow('Discord unavailable');
    expect(terminalFailure).not.toHaveBeenCalled();
    await expect(
      handler({
        ...job('SELECTION_POOL_SYNC', {
          orderId,
          selectionPoolId: poolId,
          phase: 'FINALIZED'
        }),
        attempts: 8,
        maxAttempts: 8
      })
    ).rejects.toThrow('Discord unavailable');
    expect(terminalFailure).toHaveBeenCalledOnce();
  });

  test('uses Discord REST idempotently with user_limit zero and explicit loser cleanup', async () => {
    const calls: Array<{
      url: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    let selectionCreated = false;
    let serviceCreated = false;
    const postedMessages = new Map<string, Array<{ id: string; nonce: string; timestamp: string }>>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = requestPayload(init?.body);
      calls.push({ url, method: init?.method ?? 'GET', body });
      if (url.endsWith('/guilds/999999999999999999/channels') && init?.method === 'GET')
        return Response.json([
          ...(selectionCreated
            ? [{ id: '666666666666666666', name: 'selection-p-m11', type: 2, parent_id: null }]
            : []),
          ...(serviceCreated ? [{ id: '777777777777777777', name: 'service-p-m11', type: 2, parent_id: null }] : [])
        ]);
      if (url.endsWith('/guilds/999999999999999999/channels') && init?.method === 'POST') {
        if (body?.name === 'service-p-m11') {
          serviceCreated = true;
          return Response.json({ id: '777777777777777777' });
        }
        selectionCreated = true;
        return Response.json({ id: '666666666666666666' });
      }
      if (url.endsWith('/users/@me/channels')) return Response.json({ id: '888888888888888888' });
      if (url.includes('/messages?limit=100'))
        return Response.json(postedMessages.get(url.split('/messages?')[0]!) ?? []);
      if (init?.method === 'POST') {
        if (url.endsWith('/messages') && typeof body?.nonce === 'string') {
          const channel = url.slice(0, -'/messages'.length);
          postedMessages.set(channel, [
            ...(postedMessages.get(channel) ?? []),
            {
              id: '999999999999999998',
              nonce: body.nonce,
              timestamp: '2026-08-04T12:00:00.000Z'
            }
          ]);
        }
        return Response.json({ id: '999999999999999998' });
      }
      return new Response(null, { status: 204 });
    });
    const adapter = new DiscordSelectionPoolAdapter({
      token: 'token',
      apiBaseUrl: 'https://discord.test',
      fetch: fetcher as typeof fetch
    });
    const projection = {
      poolId,
      poolVersion: 3,
      poolStatus: 'SELECTION',
      orderId,
      orderPublicId: 'P-M11',
      orderStatus: 'PENDING_DISPATCH',
      orderVersion: 1,
      guildId: '999999999999999999',
      orderChannelId: '111111111111111110',
      voiceChannelId: null,
      customerUserId: '00000000-0000-0000-0000-000000011001',
      customerDiscordUserId: '111111111111111111',
      dispatchChannelId: '222222222222222220',
      staffTaskChannelId: '555555555555555555',
      privateOrderCategoryId: null,
      staffRoleIds: ['444444444444444444'],
      applicants: Array.from({ length: 9 }, (_, index) => ({
        applicationId:
          index === 0 ? applicationId : `00000000-0000-0000-0000-${String(11060 + index).padStart(12, '0')}`,
        discordUserId: String(222222222222222222n + BigInt(index)),
        displayName: `陪玩${index + 1}`,
        status: 'APPLIED',
        applicationVersion: 1,
        requirementId
      })),
      selectedPlayers: [],
      selectedDiscordUserIds: [],
      requirements: [
        {
          id: requirementId,
          label: '瓦洛兰特 · 技术陪玩',
          remainingSlots: 1,
          expectedEarningMinor: 120,
          currency: 'CAT'
        }
      ]
    };
    await adapter.sync({ ...projection, poolStatus: 'COLLECTING' }, 'COLLECTING', '2026-08-04T11:57:00Z');
    const voice = await adapter.sync(projection, 'SELECTION', '2026-08-04T12:00:00Z');
    expect(voice).toBe('666666666666666666');
    const closedOffer = calls.find(
      (call) =>
        call.url.endsWith('/channels/222222222222222220/messages/999999999999999998') &&
        call.method === 'PATCH' &&
        JSON.stringify(call.body).includes('报名已结束')
    )!;
    expect(JSON.stringify(closedOffer.body)).toContain('报名已结束');
    expect(closedOffer.body?.components).toEqual([]);
    const create = calls.find(
      (call) => call.url.endsWith('/guilds/999999999999999999/channels') && call.method === 'POST'
    )!;
    expect(create.body).toMatchObject({ user_limit: 0 });
    expect(JSON.stringify(create.body)).toContain('222222222222222230');
    await expect(adapter.sync(projection, 'SELECTION', '2026-08-04T12:00:00Z')).resolves.toBe(voice);
    expect(
      calls.filter((call) => call.url.endsWith('/guilds/999999999999999999/channels') && call.method === 'POST')
    ).toHaveLength(1);
    const emptyProjection = {
      ...projection,
      poolId: '00000000-0000-0000-0000-000000011041',
      voiceChannelId: voice,
      applicants: []
    };
    await adapter.sync({ ...emptyProjection, poolStatus: 'COLLECTING' }, 'COLLECTING', '2026-08-04T12:00:20Z');
    await adapter.sync(emptyProjection, 'SELECTION', '2026-08-04T12:00:30Z');
    const emptyRoundNotice = calls.find(
      (call) =>
        call.url.endsWith('/channels/111111111111111110/messages') &&
        call.method === 'POST' &&
        String(call.body?.content).includes('当前报名：暂无')
    )!;
    const repeatButtons = (
      emptyRoundNotice.body?.components as Array<{
        components: Array<{
          type: number;
          custom_id?: string;
          label?: string;
        }>;
      }>
    )
      .flatMap((row) => row.components)
      .filter((component) => component.type === 2 && component.custom_id?.startsWith('bc:sp:r:'));
    expect(repeatButtons).toHaveLength(1);
    expect(repeatButtons[0]).toMatchObject({ label: '再发起一轮报名' });
    const selectedPlayers = projection.applicants.slice(0, 3).map((item) => ({
      discordUserId: item.discordUserId,
      displayName: item.displayName
    }));
    const serviceVoice = await adapter.sync(
      {
        ...projection,
        poolStatus: 'FINALIZED',
        orderStatus: 'ACCEPTED',
        voiceChannelId: voice,
        selectedPlayers,
        selectedDiscordUserIds: selectedPlayers.map((item) => item.discordUserId)
      },
      'FINALIZED',
      '2026-08-04T12:01:00Z'
    );
    expect(serviceVoice).toBe('777777777777777777');
    const voiceCreates = calls.filter(
      (call) => call.url.endsWith('/guilds/999999999999999999/channels') && call.method === 'POST'
    );
    expect(voiceCreates).toHaveLength(2);
    expect(voiceCreates[1]?.body).toMatchObject({ name: 'service-p-m11', type: 2 });
    const retiredSelection = calls.find(
      (call) =>
        call.url.endsWith('/channels/666666666666666666') &&
        call.method === 'PATCH' &&
        call.body?.name === 'selection-p-m11-closing'
    );
    expect(retiredSelection).toBeDefined();
    expect(calls.filter((call) => call.url.includes('/permissions/') && call.method === 'PUT')).toHaveLength(6);
    const memberMoves = calls.filter((call) => call.url.includes('/members/') && call.method === 'PATCH');
    expect(memberMoves).toHaveLength(10);
    const serviceMoves = memberMoves.filter((call) => call.body?.channel_id === '777777777777777777');
    expect(serviceMoves[0]).toMatchObject({
      url: expect.stringContaining('/members/111111111111111111'),
      body: { channel_id: '777777777777777777' }
    });
    expect(serviceMoves.slice(1, 4).map((call) => call.body?.channel_id)).toEqual([
      '777777777777777777',
      '777777777777777777',
      '777777777777777777'
    ]);
    expect(JSON.stringify(calls)).toContain('已确认陪玩：陪玩1、陪玩2、陪玩3');
    const finalizedCustomerPanel = calls.find(
      (call) =>
        call.url.endsWith('/channels/111111111111111110/messages/999999999999999998') &&
        call.method === 'PATCH' &&
        String(call.body?.content).includes('本轮试音匹配已完成')
    );
    expect(finalizedCustomerPanel?.body).toMatchObject({
      components: [
        {
          components: [expect.objectContaining({ label: '进入服务房间' })]
        }
      ]
    });
    expect(JSON.stringify(finalizedCustomerPanel?.body)).toContain('陪玩1、陪玩2、陪玩3');
    expect(JSON.stringify(finalizedCustomerPanel?.body)).toContain('/777777777777777777');
    const finalizedStaffNotice = calls.find(
      (call) =>
        call.url.endsWith('/channels/555555555555555555/messages/999999999999999998') &&
        call.method === 'PATCH' &&
        String(call.body?.content).includes('试音匹配已完成')
    );
    expect(JSON.stringify(finalizedStaffNotice?.body)).toContain('陪玩1、陪玩2、陪玩3');
  });

  test('retires first-wins and manual availability from runtime interaction paths', async () => {
    const [handler, center, worker] = await Promise.all([
      readFile('apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts', 'utf8'),
      readFile('apps/bot/src/service-center.ts', 'utf8'),
      readFile('apps/api/src/worker.ts', 'utf8')
    ]);
    expect(handler).toContain('applyToSelectionPool');
    expect(handler).not.toContain('acceptOrder(');
    expect(center).not.toContain('setPlayerAvailability(');
    expect(center).not.toContain('设为可接单');
    expect(worker).not.toContain('auto_dispatch_enabled');
    expect(worker).toContain('createSelectionPoolCloseHandler');
    expect(worker).toContain('createSelectionPoolSyncHandler');
  });
});

function requestPayload(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof FormData) return JSON.parse(String(body.get('payload_json'))) as Record<string, unknown>;
  return null;
}

function selectionActor() {
  return {
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    interactionId: '777777777777777777',
    clientSource: 'DISCORD_BOT' as const
  };
}

function selectionPool() {
  return {
    id: poolId,
    orderId,
    round: 1,
    status: 'COLLECTING' as const,
    version: 1,
    waitMinutes: null,
    openedAt: '2026-08-07T21:25:44.504Z',
    closesAt: null,
    applicationCount: 0
  };
}

function selectionApi(events: string[], overrides: Record<string, unknown>) {
  return {
    getOrder: vi.fn(async () => {
      events.push('read-order');
      return {
        id: orderId,
        publicId: 'P-BE7E43CE',
        status: 'PENDING_DISPATCH',
        version: 3,
        channelSpec: {
          channelId: '555555555555555555',
          panelMessageId: '666666666666666666',
          voiceChannelId: null
        }
      };
    }),
    ...overrides
  } as never;
}

function selectionInteraction(events: string[], waitMinutes = '3') {
  return {
    id: '777777777777777777',
    values: [waitMinutes],
    editReply: vi.fn(async () => events.push('edit')),
    followUp: vi.fn(async () => events.push('follow-up')),
    client: { logger: { error: vi.fn() } }
  };
}

function job(type: 'SELECTION_POOL_CLOSE' | 'SELECTION_POOL_SYNC', payload: Record<string, unknown>) {
  return {
    id: '00000000-0000-0000-0000-000000011099',
    type,
    status: 'PROCESSING' as const,
    payload,
    aggregateType: 'selection_pool',
    aggregateId: poolId,
    dedupeKey: `m11:${type}`,
    attempts: 1,
    maxAttempts: 8,
    runAfter: '2026-08-04T12:03:00.000Z',
    lockedAt: '2026-08-04T12:03:00.000Z',
    lockedBy: 'worker',
    lastError: null,
    version: 2,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:03:00.000Z'
  };
}
