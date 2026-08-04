import type { GiftAffordabilityResult, GiftPanelData, GiftRequestResult } from './gifts.js';
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
  SelectionFinalizeResult
} from './service-center-api-contracts.js';

export interface BotApiClient {
  listServices(actor: BotActorContext, game?: string): Promise<{ items: PublicServiceSummary[] }>;
  createOrder(
    input: { orderType: 'IMMEDIATE'; channelSpec: OrderChannelSpec },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ statusCode: number; order: OrderSummary }>;
  recoverOrderChannel(
    orderId: string,
    input: {
      expectedVersion: number;
      previousChannelId: string;
      channelSpec: OrderChannelSpec;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary>;
  reportChannelCreationFailure(
    input: { requestId: string; failureCode: 'CHANNEL_CREATE_FAILED' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown>;
  getOrder(orderId: string, actor: BotActorContext): Promise<OrderSummary>;
  updateOrder(
    orderId: string,
    input: Record<string, unknown>,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary>;
  listOrderRequirements?(
    orderId: string,
    actor: BotActorContext,
    cursor?: string,
    limit?: number
  ): Promise<OrderRequirementPageSummary>;
  addOrderRequirement?(
    orderId: string,
    input: {
      expectedOrderVersion: number;
      serviceCatalogVersionId: string;
      unitCount: number;
      requestedPlayerCount: number;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary>;
  updateOrderRequirement?(
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
  ): Promise<OrderRequirementMutationSummary>;
  listServicePackages?(
    actor: BotActorContext,
    cursor?: string,
    limit?: number,
    game?: string
  ): Promise<ServicePackagePageSummary>;
  previewServicePackage?(
    servicePackageVersionId: string,
    actor: BotActorContext
  ): Promise<ServicePackagePreviewSummary>;
  applyServicePackage?(
    orderId: string,
    input: { expectedOrderVersion: number; servicePackageVersionId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<ApplyServicePackageSummary>;
  getCurrentUser(actor: BotActorContext): Promise<CurrentUserSummary>;
  getCurrentBalance(actor: BotActorContext): Promise<BalanceSummary>;
  getCurrentUserProfileSummary(actor: BotActorContext): Promise<CurrentUserProfileSummary>;
  listCurrentUserOrders(actor: BotActorContext, cursor?: string, limit?: number): Promise<CurrentUserOrderPage>;
  listCurrentUserConsumptions(actor: BotActorContext, cursor?: string, limit?: number): Promise<ConsumptionPage>;
  listCurrentPlayerWeeklyReports(
    actor: BotActorContext,
    cursor?: string,
    limit?: number
  ): Promise<CurrentPlayerWeeklyReportPage>;
  getCurrentPlayerWeeklyReport(reportId: string, actor: BotActorContext): Promise<CurrentPlayerWeeklyReport>;
  listCurrentUserCommissions(actor: BotActorContext): Promise<CurrentCommissionPage>;
  estimateOrder(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderEstimateSummary>;
  submitOrder(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderReservationSummaryResult>;
  cancelOrder(
    orderId: string,
    input: CancelOrderRequest,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<CancellationResultSummary>;
  previewOrderCancellation(
    orderId: string,
    input: { expectedVersion: number; reasonCode: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<CancellationPreviewSummary>;
  setOrderReadiness(
    orderId: string,
    input: { expectedVersion: number; readiness: 'READY' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderLifecyclePanelSummary>;
  requestOrderCompletion(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<CompletionRequestSummary>;
  confirmOrder(
    orderId: string,
    input: { expectedVersion: number; confirmation: 'CONFIRM_COMPLETED' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderCompletionSummary>;
  submitSupportRating(
    orderId: string,
    input: { score: number; reason?: string | null; comment?: string | null },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown>;
  syncDiscordPresence(
    input: SyncDiscordPresenceRequest,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<PresenceSyncResult>;
  getPlayerWorkbench(actor: BotActorContext): Promise<PlayerWorkbenchSummary>;
  getCurrentSelectionPool?(orderId: string, actor: BotActorContext): Promise<SelectionPoolResult>;
  createSelectionPool(
    orderId: string,
    input: {
      expectedOrderVersion: number;
      replacesSelectionPoolId?: string;
      expectedSelectionPoolVersion?: number;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<SelectionPoolResult>;
  applyToSelectionPool(
    orderId: string,
    poolId: string,
    input: { expectedPoolVersion: number; orderRequirementId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<SelectionApplicationResult>;
  withdrawSelectionApplication(
    orderId: string,
    poolId: string,
    applicationId: string,
    input: { expectedPoolVersion: number; expectedApplicationVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<SelectionApplicationResult>;
  closeSelectionPool(
    orderId: string,
    poolId: string,
    input: { expectedPoolVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<SelectionPoolResult>;
  listSelectionApplications(
    orderId: string,
    poolId: string,
    actor: BotActorContext,
    cursor?: string
  ): Promise<SelectionApplicationPage>;
  finalizeSelectionPool(
    orderId: string,
    poolId: string,
    input: {
      expectedOrderVersion: number;
      expectedPoolVersion: number;
      applicationIds: string[];
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<SelectionFinalizeResult>;
  listGifts(orderId: string, actor: BotActorContext): Promise<GiftPanelData>;
  checkGiftAffordability(
    orderId: string,
    giftCatalogVersionId: string,
    participantIds: string[],
    actor: BotActorContext
  ): Promise<GiftAffordabilityResult>;
  createOrderGiftRequest(
    orderId: string,
    input: {
      expectedOrderVersion: number;
      giftCatalogVersionId: string;
      participantIds: string[];
      expectedCatalogVersion: number;
      expectedPriceMinor: number;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<GiftRequestResult>;
  createOrderAppeal(
    orderId: string,
    input: {
      type: 'ORDER_ASSIST';
      reasonCode: 'CUSTOMER_DISPUTE';
      note: string;
      voiceChannelId: null;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ id: string; publicId: string }>;
}
