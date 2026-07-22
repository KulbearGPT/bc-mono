import { randomUUID } from 'node:crypto';
import type { DiscordBotActorContext } from './actor-context.js';
import { BotApiTransport, BotApiTransportError } from './api-transport.js';
import type { GiftAffordabilityResult, GiftPanelData, GiftRequestResult } from './gifts.js';

export type ClientSource = 'DISCORD_BOT';
export type BotActorContext = DiscordBotActorContext;

export function buildDiscordSourceEventId(kind: 'presence'): string {
  const compactId = randomUUID().replaceAll('-', '');
  return `${kind}:${compactId.slice(0, 32 - kind.length - 1)}`;
}

export interface OrderChannelSpec {
  channelId: string;
  panelMessageId: string;
  voiceChannelId: string | null;
}

export interface OrderSummary {
  id: string;
  publicId: string;
  status: string;
  version: number;
  serviceCatalogId?: string | null;
  game: string | null;
  gameDisplayName?: string | null;
  service: string | null;
  serviceDisplayName?: string | null;
  region: string | null;
  regionDisplayName?: string | null;
  billingUnitMinutes: number | null;
  unitCount: number | null;
  amountMinor: number;
  sourcePackageVersionId?: string | null;
  compositionMode?: 'PACKAGE_DEFAULT' | 'CUSTOMIZED' | null;
  currency: string;
  notes: string | null;
  preferredPlayerDiscordUserIds?: string[];
  channelSpec: OrderChannelSpec;
  matching: {
    stage: 'SEARCHING' | 'WAITING_FOR_ACCEPTANCE' | 'TIMED_OUT' | 'ACCEPTED';
    notifiedCandidateCount: number;
    requestedPlayerCount?: number;
    filledPlayerCount?: number;
    timeoutAt: string | null;
    nextStep: 'WAIT_FOR_PLAYER' | 'CHOOSE_CONTINUE_OR_CANCEL' | 'CONFIRM_READINESS';
    playerSummary: { playerId: string; displayName: string } | null;
  } | null;
  automation?: {
    state: 'RUNNING' | 'PAUSED';
    reasonCode: string | null;
    expiresAt: string | null;
  };
}

export interface PublicServiceSummary {
  id: string;
  game: string;
  gameDisplayName?: string;
  service: string;
  serviceDisplayName?: string;
  region: string | null;
  regionDisplayName?: string | null;
  billingUnitMinutes: number;
  minimumUnits: number;
  customerUnitPriceMinor: number;
  currency: string;
  version: number;
}

export interface OrderRequirementSummary {
  id: string;
  orderId: string;
  sourcePackageSlotId?: string | null;
  serviceCatalogVersionId: string;
  game: string;
  gameDisplayName: string;
  service: string;
  serviceDisplayName: string;
  region: string | null;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  unitCount: number;
  requestedPlayerCount: number;
  customerUnitPriceMinor: number;
  estimatedLinePriceMinor: number;
  filledPlayerCount: number;
  customerNote?: string | null;
  status: 'ACTIVE' | 'REMOVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServicePackageSlotSummary {
  id: string;
  position: number;
  serviceCatalogVersionId: string;
  gameDisplayName: string;
  serviceDisplayName: string;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  unitCount: number;
  customerNoteTemplate: string | null;
}
export interface ServicePackageSummary {
  id: string;
  code: string;
  version: number;
  game: string;
  gameDisplayName: string;
  displayName: string;
  description: string;
  defaultCustomerPriceMinor: number | null;
  currency: 'CAT';
  slots: ServicePackageSlotSummary[];
}
export interface ServicePackagePreviewSummary extends ServicePackageSummary {
  derivedTotalMinor: number;
  compositionMode: 'PACKAGE_DEFAULT';
}
export interface ServicePackagePageSummary {
  items: ServicePackageSummary[];
  nextCursor: string | null;
}
export interface ApplyServicePackageSummary {
  orderId: string;
  orderVersion: number;
  sourcePackageVersionId: string;
  compositionMode: 'PACKAGE_DEFAULT';
  derivedTotalMinor: number;
  currency: 'CAT';
  requirements: OrderRequirementSummary[];
}

export interface OrderRequirementPageSummary {
  orderId: string;
  orderVersion: number;
  catalogSubtotalMinor?: number;
  packageAdjustmentMinor?: number;
  derivedTotalMinor: number;
  currency: 'CAT';
  items: OrderRequirementSummary[];
  nextCursor: string | null;
}

export interface OrderRequirementMutationSummary {
  orderId: string;
  orderVersion: number;
  derivedTotalMinor: number;
  currency: 'CAT';
  requirement: OrderRequirementSummary;
}

export interface CurrentUserSummary {
  user: {
    id: string;
    displayName: string;
    status: string;
    externalAccountDisplay: string | null;
    activeOrderId: string | null;
    riskFlags: string[];
    version: number;
  };
  activeOrderId: string | null;
  consumptionSummary: { totalMinor: number; currency: string };
  commissionSummary: {
    pendingMinor: number;
    confirmedMinor: number;
    paidMinor: number;
    currency: string;
  };
}

export interface BalanceSummary {
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'CAT';
  calculatedAt: string;
  version: number;
}

export interface ConsumptionPage {
  items: Array<{
    id: string;
    type: 'ORDER' | 'GIFT' | 'REVERSAL';
    sourceId: string;
    amountMinor: number;
    currency: string;
    status: 'SUCCEEDED' | 'REVERSED';
    targetDisplay: string;
    occurredAt: string;
    reversalOf: string | null;
  }>;
  nextCursor: string | null;
}

export interface CurrentUserProfileSummary {
  user: {
    userId: string;
    discordUserId: string;
    displayName: string;
    status: string;
  };
  balance: BalanceSummary;
  statistics: {
    orderCount: number;
    activeOrderCount: number;
    orderSpendMinor: number;
    giftSpendMinor: number;
    totalConsumptionMinor: number;
    currency: string;
  };
  activeReservationCount: number;
}

export interface CurrentUserOrderPage {
  items: Array<{
    id: string;
    publicId: string;
    status: string;
    gameKey: string | null;
    serviceKey: string | null;
    playerDisplayName: string | null;
    amountMinor: number;
    currency: string;
    createdAt: string;
    completedAt: string | null;
  }>;
  nextCursor: string | null;
}

export interface CurrentPlayerWeeklyReport {
  id: string;
  reportType: 'PLAYER';
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  currency: string;
  status: string;
  currentRevision: number;
  metrics: {
    completedOrderCount: number;
    cancelledOrderCount: number;
    serviceMinutes: number;
    orderEarningMinor: number;
    giftEarningMinor: number;
    adjustmentMinor: number;
    pendingMinor: number;
    settlementReadyMinor: number;
    batchedMinor: number;
  };
}
export interface CurrentPlayerWeeklyReportPage {
  items: CurrentPlayerWeeklyReport[];
  nextCursor: string | null;
}

export interface CurrentCommissionPage {
  summary: {
    pendingMinor: number;
    confirmedMinor: number;
    paidMinor: number;
    currency: string;
  };
  items: [];
  nextCursor: null;
}

export interface OrderEstimateSummary {
  serviceCatalogId: string;
  catalogVersion: number;
  unitCount: number;
  billingUnitMinutes: number;
  amountMinor: number;
  currency: string;
  validUntil: string;
}

export interface OrderReservationSummary {
  reservationId: string;
  amountMinor: number;
  capturedMinor: number;
  releasedMinor: number;
  currency: string;
  status: string;
  version: number;
  expiresAt: string;
}

export interface OrderReservationSummaryResult {
  orderId: string;
  status: string;
  version: number;
  reservation: OrderReservationSummary;
  balance: BalanceSummary;
}

export interface CancelOrderRequest {
  expectedVersion: number;
  previewId: string;
  reasonCode: string;
  note?: string | null;
}

export interface CancellationResultSummary {
  orderId: string;
  status: string;
  version: number;
  fundAction: string;
  releasedReservation?: OrderReservationSummary | null;
  refundTransaction?: unknown;
  staffTaskId?: string | null;
  balance?: BalanceSummary;
}

export interface CancellationPreviewSummary {
  previewId: string;
  orderId: string;
  orderVersion: number;
  automaticallyProcessable: boolean;
  fundAction: 'RELEASE_RESERVATION' | 'REFUND_CAPTURED_PAYMENT' | 'NONE';
  estimatedAmountMinor: number;
  releaseAmountMinor: number;
  refundAmountMinor: number;
  currency: string;
  handlingTimeCode: 'IMMEDIATE' | 'STAFF_REVIEW_REQUIRED';
  staffTaskRequired: boolean;
  validUntil: string;
}

export type DiscordPresenceSummary = 'ONLINE' | 'IDLE' | 'DND' | 'OFFLINE' | 'UNKNOWN';

export interface SyncDiscordPresenceRequest {
  guildId: string;
  discordUserId: string;
  presence: DiscordPresenceSummary;
  observedAt: string;
  sourceEventId: string;
}

export interface PresenceSyncResult {
  discordUserId: string;
  presence: DiscordPresenceSummary;
  observedAt: string;
  dispatchEligible: boolean;
}

export interface PlayerWorkbenchSummary {
  profile: {
    playerId: string;
    reviewStatus: string;
    availability: 'AVAILABLE' | 'BUSY' | 'OFFLINE';
    discordPresence: DiscordPresenceSummary;
    gameTags: string[];
    serviceTags: string[];
    activeOrderId: string | null;
    version: number;
  };
  eligibility: {
    eligible: boolean;
    evaluatedAt: string;
    checks: Array<{ code: string; passed: boolean; reason: string | null }>;
  };
  currentOrder: PlayerWorkbenchOrderSummary | null;
  matchingOrders: Array<{
    dispatchAttemptId: string;
    acceptBy: string;
    secondsRemaining: number;
    nextAction: 'ACCEPT_OR_DECLINE';
    order: PlayerWorkbenchOrderSummary;
  }>;
  earningsSummary: {
    pendingMinor: number;
    confirmedMinor: number;
    paidMinor: number;
    currency: string;
    calculatedAt: string;
  };
  nextActions: Array<
    | 'SET_AVAILABLE'
    | 'REVIEW_MATCH'
    | 'ACCEPT_ORDER'
    | 'SET_READINESS'
    | 'REQUEST_COMPLETION'
    | 'WAIT_FOR_CUSTOMER'
    | 'CONTACT_SUPPORT'
  >;
}

export interface PlayerWorkbenchOrderSummary {
  id: string;
  publicId: string;
  status: string;
  version: number;
  game: string | null;
  gameDisplayName?: string | null;
  service: string | null;
  serviceDisplayName?: string | null;
  region: string | null;
  regionDisplayName?: string | null;
  durationMinutes: number | null;
  playerEarningMinor: number;
  currency: string;
  requirements: string[];
  voiceChannelId: string | null;
}

export interface DispatchOfferSummary {
  dispatchAttemptId: string;
  orderId: string;
  orderPublicId: string;
  orderVersion: number;
  game: string;
  service: string;
  region: string;
  durationLabel: string;
  playerEarningMinor: number;
  currency: string;
  notes: string | null;
  expiresAt: string;
  voiceChannelId: string | null;
}

export interface OrderLifecyclePanelSummary {
  orderId: string;
  publicId: string;
  status: 'ACCEPTED' | 'IN_SERVICE' | 'PENDING_CONFIRMATION' | 'COMPLETED' | 'CANCELLED' | 'EXCEPTION';
  version: number;
  actorRole: 'CUSTOMER' | 'PLAYER';
  enabledFeatures?: Array<'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6'>;
  readiness: {
    customer: 'READY' | 'NOT_READY';
    player: 'READY' | 'NOT_READY';
    bothReady: boolean;
    readyDeadlineAt: string | null;
    startedAt: string | null;
    staffTaskId: string | null;
  };
}

export interface CompletionRequestSummary {
  orderId: string;
  publicId?: string;
  status: 'PENDING_CONFIRMATION';
  version: number;
  actorRole: 'PLAYER';
  confirmationDueAt: string;
}

export interface OrderCompletionSummary {
  orderId: string;
  publicId?: string;
  status: 'COMPLETED';
  version: number;
  capturedMinor: number;
  playerEarningMinor: number;
  currency: string;
}

export interface SelectionPoolSummary {
  id: string;
  orderId: string;
  round: number;
  status: 'COLLECTING' | 'SELECTION' | 'FINALIZED' | 'CANCELLED';
  version: number;
  waitMinutes: number | null;
  openedAt: string;
  closesAt: string | null;
  applicationCount: number;
  applicantDiscordUserIds?: string[];
}
export interface SelectionApplicationSummary {
  id: string;
  selectionPoolId: string;
  orderRequirementId: string;
  playerId: string;
  playerDiscordUserId?: string;
  playerDisplayName: string;
  publicGameTags: string[];
  publicServiceTags: string[];
  status: string;
  version: number;
  appliedAt: string;
  decidedAt: string | null;
}
export interface SelectionPoolResult {
  pool: SelectionPoolSummary;
}
export interface SelectionApplicationResult {
  pool: SelectionPoolSummary;
  application: SelectionApplicationSummary;
}
export interface SelectionApplicationPage {
  pool: SelectionPoolSummary;
  items: SelectionApplicationSummary[];
  nextCursor: string | null;
}
export interface SelectionFinalizeResult {
  orderId: string;
  orderStatus: string;
  orderVersion: number;
  pool: SelectionPoolSummary;
  selectedParticipantIds: string[];
  selectedDisplayNames: string[];
  remainingSlotCount: number;
}

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
  acceptOrder(
    orderId: string,
    input: { expectedVersion: number; dispatchAttemptId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary>;
  declineOrderOffer(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary>;
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

export class BotApiError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;
  public readonly details: unknown;

  public constructor(input: {
    code: string;
    message: string;
    requestId: string;
    statusCode: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'BotApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }
}

export class HttpBotApiClient implements BotApiClient {
  private readonly transport: BotApiTransport;

  public constructor(input: {
    apiBaseUrl: string;
    botServiceToken: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    transport?: BotApiTransport;
  }) {
    this.transport = input.transport ?? new BotApiTransport(input);
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
      body: input
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
      actor
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
      body: input
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
      actor
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

  public async listGifts(orderId: string, actor: BotActorContext): Promise<GiftPanelData> {
    return this.request<GiftPanelData>(`/api/v1/gifts?orderId=${encodeURIComponent(orderId)}`, {
      method: 'GET',
      actor
    });
  }

  public async checkGiftAffordability(
    orderId: string,
    giftCatalogVersionId: string,
    participantIds: string[],
    actor: BotActorContext
  ): Promise<GiftAffordabilityResult> {
    return this.request<GiftAffordabilityResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/gift-affordability`, {
      method: 'POST',
      actor,
      body: { giftCatalogVersionId, participantIds }
    });
  }

  public async createOrderGiftRequest(
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
  ): Promise<GiftRequestResult> {
    return this.request<GiftRequestResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/gift-requests`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

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

  public async acceptOrder(
    orderId: string,
    input: { expectedVersion: number; dispatchAttemptId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary> {
    return this.request<OrderSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/accept`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public async declineOrderOffer(
    orderId: string,
    input: { expectedVersion: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderSummary> {
    return this.request<OrderSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/decline`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
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
      { method: 'GET', actor }
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

  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      actor: BotActorContext;
      idempotencyKey?: string;
      body?: unknown;
      includeStatus?: false;
    }
  ): Promise<T>;
  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      actor: BotActorContext;
      idempotencyKey?: string;
      body?: unknown;
      includeStatus: true;
    }
  ): Promise<{ statusCode: number; data: T }>;
  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      actor: BotActorContext;
      idempotencyKey?: string;
      body?: unknown;
      includeStatus?: boolean;
    }
  ): Promise<T | { statusCode: number; data: T }> {
    try {
      if (input.includeStatus) {
        const response = await this.transport.request<T>(path, { ...input, includeStatus: true });
        return { statusCode: response.statusCode, data: response.data };
      }
      return await this.transport.request<T>(path, input);
    } catch (error) {
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

function pagePath(path: string, cursor: string | undefined, limit: number): string {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  query.set('limit', String(limit));
  return `${path}?${query.toString()}`;
}

export function buildDiscordIdempotencyKey(action: string, interactionId: string): string {
  return `discord:${action}:${interactionId}`.replaceAll(/[^A-Za-z0-9:_-]/gu, '_').slice(0, 200);
}
