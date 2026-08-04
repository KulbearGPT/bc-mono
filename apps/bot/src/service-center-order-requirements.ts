import { botCopy } from './bot-copy.js';
import {
  type BotActorContext,
  type BotApiClient,
  type OrderRequirementMutationSummary,
  type OrderRequirementPageSummary,
  type PublicServiceSummary
} from './service-center-api.js';
import { type BotFlowResult } from './service-center-components.js';
import {
  buildOrderPanelMessage,
  buildMultiProjectOrderPanelMessage,
  buildGameOrderingMenuMessage
} from './service-center-order-panels.js';
import {
  requireOrderRequirementApi,
  requirePackageApi,
  isApiError,
  requestId,
  formatApiError
} from './service-center-shared.js';

export async function handleOrderSelectSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  field: 'catalog' | 'duration' | 'preferred-players';
  value: string | string[];
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const [order, catalog] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    input.api.listServices(input.actor)
  ]);
  if (input.field === 'preferred-players') {
    const updated = await input.api.updateOrder(
      input.orderId,
      {
        expectedVersion: input.expectedVersion,
        preferredPlayerDiscordUserIds: Array.isArray(input.value) ? input.value : [input.value]
      },
      input.actor,
      input.idempotencyKey
    );
    if (input.api.listOrderRequirements) {
      const page = await input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildMultiProjectOrderPanelMessage(updated, page, catalog.items)
      };
    }
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(updated, catalog.items)
    };
  }
  const selected =
    input.field === 'catalog'
      ? catalog.items.find((item) => item.id === input.value)
      : catalog.items.find((item) => item.id === order.serviceCatalogId);
  if (!selected) throw new Error('The selected service catalog is unavailable.');
  const payload: Record<string, unknown> = {
    expectedVersion: input.expectedVersion,
    serviceCatalogId: selected.id,
    unitCount:
      input.field === 'duration'
        ? Number.parseInt(String(input.value), 10)
        : Math.max(order.unitCount ?? 0, selected.minimumUnits)
  };
  if (order.preferredPlayerDiscordUserIds?.length) {
    payload.preferredPlayerDiscordUserIds = order.preferredPlayerDiscordUserIds;
  }
  const updated = await input.api.updateOrder(input.orderId, payload, input.actor, input.idempotencyKey);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildOrderPanelMessage(updated, catalog.items)
  };
}

export async function handleOrderRequirementSelectSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  action: 'add' | 'preview' | 'edit' | 'project' | 'units' | 'players';
  requirementId?: string;
  expectedRequirementVersion?: number;
  cursor?: string;
  value: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const requirementApi = requireOrderRequirementApi(input.api);
  const [order, page, catalog] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, input.cursor, 10),
    input.api.listServices(input.actor)
  ]);
  if (input.action === 'preview') {
    return previewRequirementGame(input, order, catalog.items);
  }
  const mutation = await mutateRequirement(input, page, catalog.items, requirementApi);
  const [refreshedOrder, refreshedPage] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, input.cursor, 10)
  ]);
  if (
    mutation.changedRequirement &&
    mutation.selectedRequirementId &&
    !refreshedPage.items.some((item) => item.id === mutation.selectedRequirementId)
  ) {
    refreshedPage.items = [mutation.changedRequirement.requirement];
    refreshedPage.orderVersion = mutation.changedRequirement.orderVersion;
    refreshedPage.derivedTotalMinor = mutation.changedRequirement.derivedTotalMinor;
    refreshedPage.nextCursor = null;
  }
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(
      refreshedOrder,
      refreshedPage,
      catalog.items,
      mutation.selectedRequirementId,
      input.cursor
    )
  };
}

async function previewRequirementGame(
  input: Parameters<typeof handleOrderRequirementSelectSubmit>[0],
  order: Awaited<ReturnType<BotApiClient['getOrder']>>,
  services: PublicServiceSummary[]
): Promise<BotFlowResult> {
  const selected = services.find((item) => item.id === input.value);
  if (!selected) throw new Error('The selected service catalog is unavailable.');
  const packages = await requirePackageApi(input.api).list(input.actor, undefined, 25, selected.game);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildGameOrderingMenuMessage(
      order,
      selected.game,
      services.filter((item) => item.game === selected.game),
      packages,
      selected
    )
  };
}

async function mutateRequirement(
  input: Parameters<typeof handleOrderRequirementSelectSubmit>[0],
  page: OrderRequirementPageSummary,
  services: PublicServiceSummary[],
  api: ReturnType<typeof requireOrderRequirementApi>
): Promise<{ selectedRequirementId?: string; changedRequirement: OrderRequirementMutationSummary | null }> {
  const selectedRequirementId = input.action === 'edit' ? input.value : input.requirementId;
  if (input.action === 'add') {
    const service = services.find((item) => item.id === input.value);
    if (!service) throw new Error('The selected service catalog is unavailable.');
    await api.add(
      input.orderId,
      {
        expectedOrderVersion: input.expectedVersion,
        serviceCatalogVersionId: service.id,
        unitCount: service.minimumUnits,
        requestedPlayerCount: 1
      },
      input.actor,
      input.idempotencyKey
    );
    return { selectedRequirementId: undefined, changedRequirement: null };
  }
  if (input.action !== 'project' && input.action !== 'units' && input.action !== 'players')
    return { selectedRequirementId, changedRequirement: null };
  const requirement = page.items.find((item) => item.id === input.requirementId && item.status === 'ACTIVE');
  const requirementVersion = requirement?.version ?? input.expectedRequirementVersion;
  if (!input.requirementId || !requirementVersion) throw new Error('The selected order requirement is unavailable.');
  const quantity = input.action === 'project' ? null : Number.parseInt(input.value, 10);
  if (input.action !== 'project' && (!Number.isSafeInteger(quantity) || Number(quantity) < 1))
    throw new Error('The selected quantity is invalid.');
  const changedRequirement = await api.update(
    input.orderId,
    input.requirementId,
    {
      expectedOrderVersion: input.expectedVersion,
      expectedRequirementVersion: requirementVersion,
      action: input.action === 'project' ? 'CHANGE_PROJECT' : 'CHANGE_QUANTITY',
      serviceCatalogVersionId: input.action === 'project' ? input.value : null,
      unitCount: input.action === 'units' ? Number(quantity) : null,
      requestedPlayerCount: input.action === 'players' ? Number(quantity) : null
    },
    input.actor,
    input.idempotencyKey
  );
  return { selectedRequirementId, changedRequirement };
}

export async function handleOrderRequirementAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  action: 'back' | 'remove' | 'page';
  cursor?: string;
  requirementId?: string;
  expectedRequirementVersion?: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const requirementApi = requireOrderRequirementApi(input.api);
  if (input.action === 'remove') {
    if (!input.requirementId || !input.expectedRequirementVersion)
      throw new Error('Requirement identity and version are required.');
    await requirementApi.update(
      input.orderId,
      input.requirementId,
      {
        expectedOrderVersion: input.expectedVersion,
        expectedRequirementVersion: input.expectedRequirementVersion,
        action: 'REMOVE'
      },
      input.actor,
      input.idempotencyKey
    );
  }
  const cursor = input.action === 'page' ? input.cursor : undefined;
  const [order, page, services] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, cursor, 10),
    input.api.listServices(input.actor)
  ]);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(order, page, services.items, undefined, cursor)
  };
}

export async function handleOrderNotesSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  notes: string;
  returnGame?: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const updated = await input.api.updateOrder(
      input.orderId,
      { expectedVersion: input.expectedVersion, notes: input.notes },
      input.actor,
      input.idempotencyKey
    );
    if (input.returnGame) {
      if (!input.api.listServicePackages) throw new Error('Service package API is unavailable.');
      const [services, packages] = await Promise.all([
        input.api.listServices(input.actor, input.returnGame),
        input.api.listServicePackages(input.actor, undefined, 25, input.returnGame)
      ]);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildGameOrderingMenuMessage(updated, input.returnGame, services.items, packages)
      };
    }
    if (input.api.listOrderRequirements) {
      const [page, services] = await Promise.all([
        input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10),
        input.api.listServices(input.actor)
      ]);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildMultiProjectOrderPanelMessage(updated, page, services.items)
      };
    }
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(updated)
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      const refreshed = await input.api.getOrder(input.orderId, input.actor);
      if (input.returnGame) {
        if (!input.api.listServicePackages) throw new Error('Service package API is unavailable.');
        const [services, packages] = await Promise.all([
          input.api.listServices(input.actor, input.returnGame),
          input.api.listServicePackages(input.actor, undefined, 25, input.returnGame)
        ]);
        return {
          kind: 'EDIT_ORIGINAL_MESSAGE',
          message: buildGameOrderingMenuMessage(refreshed, input.returnGame, services.items, packages),
          notice: botCopy.orders.conflictRefreshed(requestId(error))
        };
      }
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(refreshed),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '保存订单备注')
    };
  }
}

export async function handleRequirementNoteSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  requirementId: string;
  expectedVersion: number;
  expectedRequirementVersion: number;
  customerNote: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const requirementApi = requireOrderRequirementApi(input.api);
  await requirementApi.update(
    input.orderId,
    input.requirementId,
    {
      expectedOrderVersion: input.expectedVersion,
      expectedRequirementVersion: input.expectedRequirementVersion,
      action: 'CHANGE_NOTE',
      customerNote: input.customerNote || null
    },
    input.actor,
    input.idempotencyKey
  );
  const [order, page, services] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, undefined, 10),
    input.api.listServices(input.actor)
  ]);
  return {
    kind: 'EDIT_ORIGINAL_MESSAGE',
    message: buildMultiProjectOrderPanelMessage(order, page, services.items, input.requirementId)
  };
}
