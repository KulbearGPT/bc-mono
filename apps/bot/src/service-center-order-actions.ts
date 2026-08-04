import { createHash } from 'node:crypto';
import { BOT_COPY, botCopy } from './bot-copy.js';
import {
  BotApiError,
  type BotActorContext,
  type BotApiClient,
  type OrderChannelSpec,
  type OrderRequirementPageSummary,
  type SelectionPoolSummary
} from './service-center-api.js';
import { type BotFlowResult } from './service-center-components.js';
import { buildServiceCenterMessage } from './service-center-profile.js';
import { buildSelectionPoolRefreshMessage } from './selection-discord.js';
import { buildSubmittedOrderMessage } from './submitted-order-message.js';
import { buildServiceLifecyclePanelMessage } from './service-lifecycle-message.js';
import { buildPlayerWorkbenchMessage } from './player-workbench-message.js';
import {
  buildOrderPanelMessage,
  buildMultiProjectOrderPanelMessage,
  buildGamePickerMessage
} from './service-center-order-panels.js';
import {
  buildCancellationPreviewMessage,
  buildOrderConfirmationMessage,
  buildMultiProjectOrderConfirmationMessage
} from './service-center-order-confirmation.js';
import {
  isApiError,
  requestId,
  formatApiError,
  lifecyclePermissionDeniedMessage,
  formatCustomerMoney,
  buildIncompleteConfirmationMessage
} from './service-center-shared.js';

export async function handleOpenOrderConfirmation(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const order = await input.api.getOrder(input.orderId, input.actor);
  if (order.status !== 'DRAFT') {
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderPanelMessage(order)
    };
  }
  try {
    if (input.api.listOrderRequirements) {
      const [requirements, balance] = await Promise.all([
        input.api.listOrderRequirements(input.orderId, input.actor, undefined, 25),
        input.api.getCurrentBalance(input.actor)
      ]);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildMultiProjectOrderConfirmationMessage({
          order,
          requirements,
          balance
        })
      };
    }
    const [estimate, balance] = await Promise.all([
      input.api.estimateOrder(
        input.orderId,
        { expectedVersion: input.expectedVersion },
        input.actor,
        input.idempotencyKey
      ),
      input.api.getCurrentBalance(input.actor)
    ]);
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildOrderConfirmationMessage({ order, estimate, balance })
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(order),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    if (isApiError(error, 'BUSINESS_RULE_VIOLATION')) {
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildIncompleteConfirmationMessage(order),
        notice: botCopy.orders.incomplete(requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开订单确认面板')
    };
  }
}

export async function handleOrderRefresh(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
}): Promise<Extract<BotFlowResult, { kind: 'EDIT_ORIGINAL_MESSAGE' } | { kind: 'EPHEMERAL_MESSAGE' }>> {
  try {
    const order = await input.api.getOrder(input.orderId, input.actor);
    if (order.status === 'DRAFT') {
      const services = await input.api.listServices(input.actor);
      if (input.api.listOrderRequirements) {
        const requirements = await input.api.listOrderRequirements(input.orderId, input.actor, undefined, 10);
        if (requirements.items.some((item) => item.status === 'ACTIVE'))
          return {
            kind: 'EDIT_ORIGINAL_MESSAGE',
            message: buildMultiProjectOrderPanelMessage(order, requirements, services.items)
          };
      }
      const packages = input.api.listServicePackages
        ? await input.api.listServicePackages(input.actor, undefined, 25)
        : { items: [], nextCursor: null };
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildGamePickerMessage(order, services.items, packages.items)
      };
    }
    if (order.status === 'PENDING_DISPATCH') {
      let currentPool: SelectionPoolSummary | null = null;
      if (input.api.getCurrentSelectionPool) {
        try {
          currentPool = (await input.api.getCurrentSelectionPool(input.orderId, input.actor)).pool;
        } catch (error) {
          if (!isApiError(error, 'NOT_FOUND')) throw error;
        }
      }
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildSelectionPoolRefreshMessage(order, currentPool)
      };
    }
    let requirements: OrderRequirementPageSummary | undefined;
    const needsRequirementDetails =
      Boolean(order.compositionMode) || !order.game || !order.service || !order.billingUnitMinutes || !order.unitCount;
    if (needsRequirementDetails && input.api.listOrderRequirements) {
      try {
        requirements = await input.api.listOrderRequirements(input.orderId, input.actor, undefined, 25);
      } catch (error) {
        if (!isApiError(error, 'PERMISSION_DENIED')) throw error;
      }
    }
    return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildOrderPanelMessage(order, [], requirements) };
  } catch (error) {
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '刷新订单') };
  }
}

export async function handleSubmitFinalOrder(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const result = await input.api.submitOrder(
      input.orderId,
      { expectedVersion: input.expectedVersion },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildSubmittedOrderMessage(result)
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      const refreshed = await input.api.getOrder(input.orderId, input.actor);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(refreshed),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '提交订单')
    };
  }
}

export async function handleServiceLifecycleAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  action: 'ready' | 'request-completion' | 'confirm' | 'support';
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    if (input.action === 'ready') {
      const result = await input.api.setOrderReadiness(
        input.orderId,
        { expectedVersion: input.expectedVersion, readiness: 'READY' },
        input.actor,
        input.idempotencyKey
      );
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildServiceLifecyclePanelMessage(result)
      };
    }
    if (input.action === 'request-completion') {
      await input.api.requestOrderCompletion(
        input.orderId,
        { expectedVersion: input.expectedVersion },
        input.actor,
        input.idempotencyKey
      );
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: BOT_COPY.orders.completionRequested
      };
    }
    if (input.action === 'confirm') {
      const result = await input.api.confirmOrder(
        input.orderId,
        {
          expectedVersion: input.expectedVersion,
          confirmation: 'CONFIRM_COMPLETED'
        },
        input.actor,
        input.idempotencyKey
      );
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: botCopy.lifecycle.completionConfirmed(formatCustomerMoney(result.capturedMinor, result.currency))
      };
    }
    const task = await input.api.createOrderAppeal(
      input.orderId,
      {
        type: 'ORDER_ASSIST',
        reasonCode: 'CUSTOMER_DISPUTE',
        note: '用户从订单常驻菜单发起申诉。',
        voiceChannelId: null
      },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: botCopy.lifecycle.appealSubmitted(task.publicId)
    };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      const refreshed = await input.api.getOrder(input.orderId, input.actor);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(refreshed),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    if (isApiError(error, 'PERMISSION_DENIED')) {
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: lifecyclePermissionDeniedMessage(input.action, requestId(error))
      };
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '更新订单状态')
    };
  }
}

export async function handleOpenServiceCenterFromPublicEntry(input: {
  api: BotApiClient;
  actor: BotActorContext;
}): Promise<BotFlowResult> {
  try {
    const currentUser = await input.api.getCurrentUser(input.actor);
    const [balance, consumptions, commissions, activeOrder] = await Promise.all([
      input.api.getCurrentBalance(input.actor),
      input.api.listCurrentUserConsumptions(input.actor),
      input.api.listCurrentUserCommissions(input.actor),
      currentUser.activeOrderId ? input.api.getOrder(currentUser.activeOrderId, input.actor) : Promise.resolve(null)
    ]);

    return {
      kind: 'SHOW_SERVICE_CENTER',
      message: buildServiceCenterMessage({
        currentUser,
        balance,
        activeOrder,
        consumptions,
        commissions
      })
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开服务中心')
    };
  }
}

export async function handleOpenPlayerWorkbench(input: {
  api: BotApiClient;
  actor: BotActorContext;
}): Promise<BotFlowResult> {
  try {
    const workbench = await input.api.getPlayerWorkbench(input.actor);
    return {
      kind: 'SHOW_PLAYER_WORKBENCH',
      message: buildPlayerWorkbenchMessage(workbench)
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开陪玩工作台')
    };
  }
}

export async function handleOpenCancellationPreview(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const preview = await input.api.previewOrderCancellation(
      input.orderId,
      {
        expectedVersion: input.expectedVersion,
        reasonCode: 'CUSTOMER_REQUEST'
      },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: buildCancellationPreviewMessage(preview)
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '打开订单取消说明')
    };
  }
}

export async function handleConfirmCancellation(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  previewId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const result = await input.api.cancelOrder(
      input.orderId,
      {
        expectedVersion: input.expectedVersion,
        previewId: input.previewId,
        reasonCode: 'CUSTOMER_REQUEST'
      },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: result.staffTaskId ? BOT_COPY.orders.cancellationEscalated : BOT_COPY.orders.cancellationCompleted
    };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 'CANCELLATION_PREVIEW_STALE') {
      try {
        const order = await input.api.getOrder(input.orderId, input.actor);
        const refreshedPreview = await input.api.previewOrderCancellation(
          input.orderId,
          { expectedVersion: order.version, reasonCode: 'CUSTOMER_REQUEST' },
          input.actor,
          `${input.idempotencyKey}:refresh-preview`
        );
        return {
          kind: 'EDIT_ORIGINAL_MESSAGE',
          message: buildCancellationPreviewMessage(refreshedPreview),
          notice: botCopy.orders.cancellationRefreshed(error.requestId)
        };
      } catch (refreshError) {
        return {
          kind: 'EPHEMERAL_MESSAGE',
          message: formatApiError(refreshError, '刷新取消说明')
        };
      }
    }
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '取消订单')
    };
  }
}

export async function handleCreateOrderFromPublicEntry(input: {
  api: BotApiClient;
  actor: BotActorContext;
  provisionalChannel: OrderChannelSpec | null;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  if (!input.provisionalChannel) {
    const requestId = `req_${createHash('sha256').update(`${input.actor.guildId}:${input.actor.interactionId}`).digest('hex').slice(0, 24)}`;
    let reported = false;
    for (let attempt = 0; attempt < 2 && !reported; attempt += 1) {
      try {
        await input.api.reportChannelCreationFailure(
          { requestId, failureCode: 'CHANNEL_CREATE_FAILED' },
          input.actor,
          `channel-failure:${input.actor.interactionId}`
        );
        reported = true;
      } catch {
        // A second bounded attempt protects the support record without delaying the interaction indefinitely.
      }
    }
    return {
      kind: 'CHANNEL_CREATION_FAILED',
      message: botCopy.orders.channelCreationFailed(requestId, !reported)
    };
  }

  try {
    const response = await input.api.createOrder(
      { orderType: 'IMMEDIATE', channelSpec: input.provisionalChannel },
      input.actor,
      input.idempotencyKey
    );

    if (response.statusCode === 200) {
      return {
        kind: 'OPEN_EXISTING_CHANNEL',
        channelId: response.order.channelSpec.channelId,
        orderId: response.order.id
      };
    }

    return {
      kind: 'CREATE_PRIVATE_CHANNEL',
      order: response.order,
      message: buildOrderPanelMessage(response.order)
    };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '创建订单')
    };
  }
}
