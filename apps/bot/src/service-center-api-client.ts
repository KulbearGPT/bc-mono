import { BotApiTransport, BotApiTransportError } from './api-transport.js';
import { BotApiDataValidationError, validateBotApiData, type BotApiDataKind } from './bot-api-validation.js';
import { BotApiError } from './service-center-api-error.js';
import { pagePath } from './service-center-api-utils.js';
import { OrderExperienceReviewApiClient } from './service-center-api-client-order-reviews.js';
import { GiftApiClient } from './service-center-api-client-gifts.js';
import type {
  BotActorContext,
  OrderChannelSpec,
  OrderSummary,
  PublicServiceSummary,
  ServicePackagePreviewSummary,
  ServicePackagePageSummary,
  ApplyServicePackageSummary,
  OrderRequirementPageSummary,
  OrderRequirementMutationSummary,
  CurrentUserSummary,
  BalanceSummary,
  ConsumptionPage,
  CurrentUserProfileSummary,
  CurrentUserOrderPage,
  CurrentPlayerWeeklyReport,
  CurrentPlayerWeeklyReportPage,
  CurrentCommissionPage,
  OrderEstimateSummary,
  OrderReservationSummaryResult,
  CancelOrderRequest,
  CancellationResultSummary,
  CancellationPreviewSummary,
  SyncDiscordPresenceRequest,
  PresenceSyncResult,
  PlayerWorkbenchSummary,
  OrderLifecyclePanelSummary,
  CompletionRequestSummary,
  OrderCompletionSummary,
  SelectionPoolResult,
  SelectionApplicationResult,
  SelectionApplicationPage,
  SelectionFinalizeResult,
  SelectionReactionObservationResult,
  SelectionReactionCard
} from './service-center-api-contracts.js';
import type { BotApiClient } from './service-center-api-client-contract.js';

export class HttpBotApiClient implements BotApiClient {
  private readonly transport: BotApiTransport;
  private readonly orderReviews: OrderExperienceReviewApiClient;
  private readonly gifts: GiftApiClient;

  public constructor(input: {
    apiBaseUrl: string;
    botServiceToken: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    transport?: BotApiTransport;
  }) {
    this.transport = input.transport ?? new BotApiTransport(input);
    this.orderReviews = new OrderExperienceReviewApiClient((path, request) => this.request(path, request));
    this.gifts = new GiftApiClient((path, request) => this.request(path, request));
  }

  public async createOrder(
    input: { orderType: 'IMMEDIATE'; channelSpec: OrderChannelSpec },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ statusCode: number; order: OrderSummary }> {
    const response = await this.request<OrderSummary>('/api/v1/orders', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input,
      includeStatus: true
    });
    return { statusCode: response.statusCode, order: response.data };
  }

  public async recoverOrderChannel(
    orderId: string,
    input: {
      expectedVersion: number;
      previousChannelId: string;
      channelSpec: OrderChannelSpec;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary> {
    return this.request<OrderSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/channel-recovery`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input,
      validateAs: 'order'
    });
  }

  public async listServices(actor: BotActorContext, game?: string): Promise<{ items: PublicServiceSummary[] }> {
    const query = game ? `?game=${encodeURIComponent(game)}` : '';
    return this.request(`/api/v1/services${query}`, { method: 'GET', actor });
  }

  public async reportChannelCreationFailure(
    input: { requestId: string; failureCode: 'CHANNEL_CREATE_FAILED' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown> {
    return this.request('/api/v1/internal/discord/channel-failures', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async getOrder(orderId: string, actor: BotActorContext): Promise<OrderSummary> {
    return this.request<OrderSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      actor,
      validateAs: 'order'
    });
  }

  public async updateOrder(
    orderId: string,
    input: Record<string, unknown>,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary> {
    return this.request<OrderSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      actor,
      idempotencyKey,
      body: input,
      validateAs: 'order'
    });
  }

  public async listOrderRequirements(
    orderId: string,
    actor: BotActorContext,
    cursor?: string,
    limit = 10
  ): Promise<OrderRequirementPageSummary> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return this.request<OrderRequirementPageSummary>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/requirements?${query.toString()}`,
      { method: 'GET', actor }
    );
  }

  public async addOrderRequirement(
    orderId: string,
    input: {
      expectedOrderVersion: number;
      serviceCatalogVersionId: string;
      unitCount: number;
      requestedPlayerCount: number;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary> {
    return this.request<OrderRequirementMutationSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/requirements`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async updateOrderRequirement(
    orderId: string,
    requirementId: string,
    input: {
      expectedOrderVersion: number;
      expectedRequirementVersion: number;
      action: 'CHANGE_PROJECT' | 'CHANGE_QUANTITY' | 'CHANGE_NOTE' | 'REMOVE';
      serviceCatalogVersionId?: string | null;
      unitCount?: number | null;
      requestedPlayerCount?: number | null;
      customerNote?: string | null;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary> {
    return this.request<OrderRequirementMutationSummary>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/requirements/${encodeURIComponent(requirementId)}`,
      { method: 'PATCH', actor, idempotencyKey, body: input }
    );
  }

  public async listServicePackages(
    actor: BotActorContext,
    cursor?: string,
    limit = 25,
    game?: string
  ): Promise<ServicePackagePageSummary> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    if (game) query.set('game', game);
    return this.request<ServicePackagePageSummary>(`/api/v1/service-packages?${query.toString()}`, {
      method: 'GET',
      actor
    });
  }
  public async previewServicePackage(
    servicePackageVersionId: string,
    actor: BotActorContext
  ): Promise<ServicePackagePreviewSummary> {
    return this.request<ServicePackagePreviewSummary>(
      `/api/v1/service-packages/${encodeURIComponent(servicePackageVersionId)}/preview`,
      { method: 'POST', actor }
    );
  }
  public async applyServicePackage(
    orderId: string,
    input: { expectedOrderVersion: number; servicePackageVersionId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<ApplyServicePackageSummary> {
    return this.request<ApplyServicePackageSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/package`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async getCurrentUser(actor: BotActorContext): Promise<CurrentUserSummary> {
    return this.request<CurrentUserSummary>('/api/v1/me', {
      method: 'GET',
      actor
    });
  }

  public async getCurrentBalance(actor: BotActorContext): Promise<BalanceSummary> {
    return this.request<BalanceSummary>('/api/v1/me/balance', {
      method: 'GET',
      actor,
      validateAs: 'balance'
    });
  }

  public async getCurrentUserProfileSummary(actor: BotActorContext): Promise<CurrentUserProfileSummary> {
    return this.request<CurrentUserProfileSummary>('/api/v1/me/profile', {
      method: 'GET',
      actor
    });
  }

  public async listCurrentUserOrders(
    actor: BotActorContext,
    cursor?: string,
    limit = 5
  ): Promise<CurrentUserOrderPage> {
    return this.request<CurrentUserOrderPage>(pagePath('/api/v1/me/orders', cursor, limit), { method: 'GET', actor });
  }

  public listGifts: BotApiClient['listGifts'] = (...args) => this.gifts.listOrder(...args);
  public checkGiftAffordability: BotApiClient['checkGiftAffordability'] = (...args) => this.gifts.checkOrder(...args);
  public createOrderGiftRequest: BotApiClient['createOrderGiftRequest'] = (...args) => this.gifts.createOrder(...args);
  public getStandaloneGiftCenter: BotApiClient['getStandaloneGiftCenter'] = (...args) =>
    this.gifts.getStandaloneCenter(...args);
  public checkStandaloneGiftAffordability: BotApiClient['checkStandaloneGiftAffordability'] = (...args) =>
    this.gifts.checkStandalone(...args);
  public createStandaloneGiftRequest: BotApiClient['createStandaloneGiftRequest'] = (...args) =>
    this.gifts.createStandalone(...args);
  public createStaffGiftAssistChallenge: BotApiClient['createStaffGiftAssistChallenge'] = (...args) =>
    this.gifts.createStaffAssistChallenge(...args);
  public getStaffGiftAssistChallenge: BotApiClient['getStaffGiftAssistChallenge'] = (...args) =>
    this.gifts.getStaffAssistChallenge(...args);
  public checkStaffGiftAssistAffordability: BotApiClient['checkStaffGiftAssistAffordability'] = (...args) =>
    this.gifts.checkStaffAssist(...args);
  public createStaffAssistedGiftRequest: BotApiClient['createStaffAssistedGiftRequest'] = (...args) =>
    this.gifts.createStaffAssisted(...args);

  public async createOrderAppeal(
    orderId: string,
    input: {
      type: 'ORDER_ASSIST';
      reasonCode: 'CUSTOMER_DISPUTE';
      note: string;
      voiceChannelId: null;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ id: string; publicId: string }> {
    return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/staff-tasks`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async listCurrentUserConsumptions(
    actor: BotActorContext,
    cursor?: string,
    limit?: number
  ): Promise<ConsumptionPage> {
    const path =
      cursor !== undefined || limit !== undefined
        ? pagePath('/api/v1/me/consumptions', cursor, limit ?? 5)
        : '/api/v1/me/consumptions';
    return this.request<ConsumptionPage>(path, {
      method: 'GET',
      actor
    });
  }

  public async listCurrentPlayerWeeklyReports(
    actor: BotActorContext,
    cursor?: string,
    limit = 5
  ): Promise<CurrentPlayerWeeklyReportPage> {
    return this.request<CurrentPlayerWeeklyReportPage>(pagePath('/api/v1/players/me/weekly-reports', cursor, limit), {
      method: 'GET',
      actor
    });
  }

  public async getCurrentPlayerWeeklyReport(
    reportId: string,
    actor: BotActorContext
  ): Promise<CurrentPlayerWeeklyReport> {
    return this.request<CurrentPlayerWeeklyReport>(
      `/api/v1/players/me/weekly-reports/${encodeURIComponent(reportId)}`,
      { method: 'GET', actor }
    );
  }

  public async listCurrentUserCommissions(actor: BotActorContext): Promise<CurrentCommissionPage> {
    return this.request<CurrentCommissionPage>('/api/v1/me/commissions', {
      method: 'GET',
      actor
    });
  }

  public async estimateOrder(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderEstimateSummary> {
    return this.request<OrderEstimateSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/estimate`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async submitOrder(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderReservationSummaryResult> {
    return this.request<OrderReservationSummaryResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/submit`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async cancelOrder(
    orderId: string,
    input: CancelOrderRequest,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<CancellationResultSummary> {
    return this.request<CancellationResultSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async previewOrderCancellation(
    orderId: string,
    input: { expectedVersion: number; reasonCode: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<CancellationPreviewSummary> {
    return this.request<CancellationPreviewSummary>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/cancellation-preview`,
      {
        method: 'POST',
        actor,
        idempotencyKey,
        body: input
      }
    );
  }

  public async setOrderReadiness(
    orderId: string,
    input: { expectedVersion: number; readiness: 'READY' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderLifecyclePanelSummary> {
    return this.request<OrderLifecyclePanelSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/readiness`, {
      method: 'PUT',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async requestOrderCompletion(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<CompletionRequestSummary> {
    return this.request<CompletionRequestSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/request-completion`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async confirmOrder(
    orderId: string,
    input: { expectedVersion: number; confirmation: 'CONFIRM_COMPLETED' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderCompletionSummary> {
    return this.request<OrderCompletionSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/confirm`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async submitSupportRating(
    orderId: string,
    input: { score: number; reason?: string | null; comment?: string | null },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown> {
    return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/support-rating`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public getOrderExperienceReview(orderId: string, actor: BotActorContext) {
    return this.orderReviews.getCenter(orderId, actor);
  }

  public async createOrderExperienceRatings(
    orderId: string,
    input: { targetKeys: string[]; score: number },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.orderReviews.createRatings(orderId, input, actor, idempotencyKey);
  }

  public async appendOrderExperienceReviewComment(
    orderId: string,
    reviewId: string,
    input: { comment: string },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.orderReviews.appendComment(orderId, reviewId, input, actor, idempotencyKey);
  }

  public async publishOrderFiveStarReview(
    orderId: string,
    input: { confirmation: 'PUBLISH_FIVE_STAR_SNAPSHOT' },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.orderReviews.publish(orderId, input, actor, idempotencyKey);
  }

  public async syncDiscordPresence(
    input: SyncDiscordPresenceRequest,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<PresenceSyncResult> {
    return this.request<PresenceSyncResult>('/api/v1/internal/discord/presence', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async getPlayerWorkbench(actor: BotActorContext): Promise<PlayerWorkbenchSummary> {
    return this.request<PlayerWorkbenchSummary>('/api/v1/players/me/workbench', { method: 'GET', actor });
  }

  public getCurrentSelectionPool(orderId: string, actor: BotActorContext) {
    return this.request<SelectionPoolResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools/current`, {
      method: 'GET',
      actor
    });
  }

  public createSelectionPool(
    orderId: string,
    input: {
      expectedOrderVersion: number;
      replacesSelectionPoolId?: string;
      expectedSelectionPoolVersion?: number;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<SelectionPoolResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }
  public applyToSelectionPool(
    orderId: string,
    poolId: string,
    input: { expectedPoolVersion: number; orderRequirementId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<SelectionApplicationResult>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools/${encodeURIComponent(poolId)}/applications`,
      { method: 'POST', actor, idempotencyKey, body: input }
    );
  }
  public withdrawSelectionApplication(
    orderId: string,
    poolId: string,
    applicationId: string,
    input: { expectedPoolVersion: number; expectedApplicationVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<SelectionApplicationResult>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools/${encodeURIComponent(poolId)}/applications/${encodeURIComponent(applicationId)}/withdraw`,
      { method: 'POST', actor, idempotencyKey, body: input }
    );
  }
  public closeSelectionPool(
    orderId: string,
    poolId: string,
    input: { expectedPoolVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<SelectionPoolResult>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools/${encodeURIComponent(poolId)}/close`,
      { method: 'POST', actor, idempotencyKey, body: input }
    );
  }
  public listSelectionApplications(orderId: string, poolId: string, actor: BotActorContext, cursor?: string) {
    return this.request<SelectionApplicationPage>(
      pagePath(
        `/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools/${encodeURIComponent(poolId)}/applications`,
        cursor,
        25
      ),
      { method: 'GET', actor, validateAs: 'selection-page' }
    );
  }
  public finalizeSelectionPool(
    orderId: string,
    poolId: string,
    input: {
      expectedOrderVersion: number;
      expectedPoolVersion: number;
      applicationIds: string[];
    },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<SelectionFinalizeResult>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/selection-pools/${encodeURIComponent(poolId)}/finalize`,
      { method: 'POST', actor, idempotencyKey, body: input }
    );
  }
  public observeSelectionReaction(
    input: { channelId: string; messageId: string; emoji: string; state: 'ADDED' | 'REMOVED' },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<SelectionReactionObservationResult>('/api/v1/internal/discord/selection-reactions', {
      method: 'PUT',
      actor,
      idempotencyKey,
      body: input
    });
  }
  public listActiveSelectionReactionCards(guildId: string) {
    return this.request<{ items: SelectionReactionCard[] }>(
      `/api/v1/internal/discord/selection-reaction-cards?guildId=${encodeURIComponent(guildId)}`,
      { method: 'GET' }
    );
  }

  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      actor?: BotActorContext;
      idempotencyKey?: string;
      body?: unknown;
      includeStatus?: false;
      validateAs?: BotApiDataKind;
    }
  ): Promise<T>;
  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      actor?: BotActorContext;
      idempotencyKey?: string;
      body?: unknown;
      includeStatus: true;
      validateAs?: BotApiDataKind;
    }
  ): Promise<{ statusCode: number; data: T }>;
  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      actor?: BotActorContext;
      idempotencyKey?: string;
      body?: unknown;
      includeStatus?: boolean;
      validateAs?: BotApiDataKind;
    }
  ): Promise<T | { statusCode: number; data: T }> {
    try {
      const { validateAs, ...transportInput } = input;
      if (input.includeStatus) {
        const response = await this.transport.request<T>(path, { ...transportInput, includeStatus: true });
        return {
          statusCode: response.statusCode,
          data: validateAs ? validateBotApiData(validateAs, response.data) : response.data
        };
      }
      const data = await this.transport.request<T>(path, transportInput);
      return validateAs ? validateBotApiData(validateAs, data) : data;
    } catch (error) {
      if (error instanceof BotApiDataValidationError) {
        throw new BotApiError({
          code: 'INVALID_RESPONSE',
          message: error.message,
          requestId: 'bot-api-invalid-data',
          statusCode: 502
        });
      }
      if (!(error instanceof BotApiTransportError)) throw error;
      throw new BotApiError({
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        statusCode: error.statusCode,
        details: error.details
      });
    }
  }
}
