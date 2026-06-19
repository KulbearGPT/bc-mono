import { createHash, randomUUID } from 'node:crypto';
import { BOT_COPY, botCopy } from './bot-copy.js';
import type { GiftAffordabilityResult, GiftPanelData, GiftRequestResult } from './gifts.js';
import {
  customerWalletLabel,
  formatCustomerWalletAmount,
  parseWalletDisplayConfig
} from './wallet-display.js';

export type ClientSource = 'DISCORD_BOT';

export interface BotActorContext {
  guildId: string;
  discordUserId: string;
  interactionId: string;
  clientSource: ClientSource;
}

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
  id: string; game: string; gameDisplayName?: string; service: string; serviceDisplayName?: string; region: string | null; regionDisplayName?: string | null; billingUnitMinutes: number;
  minimumUnits: number; customerUnitPriceMinor: number; currency: string; version: number;
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

export interface ServicePackageSlotSummary { id:string;position:number;serviceCatalogVersionId:string;gameDisplayName:string;serviceDisplayName:string;regionDisplayName:string|null;billingUnitMinutes:number;unitCount:number;customerNoteTemplate:string|null }
export interface ServicePackageSummary { id:string;code:string;version:number;displayName:string;description:string;defaultCustomerPriceMinor:number|null;currency:'CAT';slots:ServicePackageSlotSummary[] }
export interface ServicePackagePreviewSummary extends ServicePackageSummary { derivedTotalMinor:number;compositionMode:'PACKAGE_DEFAULT' }
export interface ServicePackagePageSummary { items:ServicePackageSummary[];nextCursor:string|null }
export interface ApplyServicePackageSummary {orderId:string;orderVersion:number;sourcePackageVersionId:string;compositionMode:'PACKAGE_DEFAULT';derivedTotalMinor:number;currency:'CAT';requirements:OrderRequirementSummary[]}

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
  commissionSummary: { pendingMinor: number; confirmedMinor: number; paidMinor: number; currency: string };
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
  items: Array<{ id: string; type: 'ORDER' | 'GIFT' | 'REVERSAL'; sourceId: string; amountMinor: number; currency: string;
    status: 'SUCCEEDED' | 'REVERSED'; targetDisplay: string; occurredAt: string; reversalOf: string | null }>;
  nextCursor: string | null;
}

export interface CurrentUserProfileSummary {
  user: { userId: string; discordUserId: string; displayName: string; status: string };
  balance: BalanceSummary;
  statistics: { orderCount: number; activeOrderCount: number; orderSpendMinor: number; giftSpendMinor: number; totalConsumptionMinor: number; currency: string };
  activeReservationCount: number;
}

export interface CurrentUserOrderPage {
  items: Array<{ id: string; publicId: string; status: string; gameKey: string | null; serviceKey: string | null;
    playerDisplayName: string | null; amountMinor: number; currency: string; createdAt: string; completedAt: string | null }>;
  nextCursor: string | null;
}

export interface CurrentPlayerWeeklyReport {
  id: string; reportType: 'PLAYER'; periodStart: string; periodEnd: string; timeZone: string; currency: string; status: string;
  currentRevision: number; metrics: { completedOrderCount: number; cancelledOrderCount: number; serviceMinutes: number;
    orderEarningMinor: number; giftEarningMinor: number; adjustmentMinor: number; pendingMinor: number; settlementReadyMinor: number; batchedMinor: number };
}
export interface CurrentPlayerWeeklyReportPage { items: CurrentPlayerWeeklyReport[]; nextCursor: string | null }

export interface CurrentCommissionPage {
  summary: { pendingMinor: number; confirmedMinor: number; paidMinor: number; currency: string };
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
  nextActions: Array<'SET_AVAILABLE' | 'REVIEW_MATCH' | 'ACCEPT_ORDER' | 'SET_READINESS' | 'REQUEST_COMPLETION' | 'WAIT_FOR_CUSTOMER' | 'CONTACT_SUPPORT'>;
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

export interface BotApiClient {
  listServices(actor: BotActorContext): Promise<{ items: PublicServiceSummary[] }>;
  createOrder(
    input: { orderType: 'IMMEDIATE'; channelSpec: OrderChannelSpec },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ statusCode: number; order: OrderSummary }>;
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
  listOrderRequirements?(orderId: string, actor: BotActorContext, cursor?: string, limit?: number): Promise<OrderRequirementPageSummary>;
  addOrderRequirement?(
    orderId: string,
    input: { expectedOrderVersion: number; serviceCatalogVersionId: string; unitCount: number; requestedPlayerCount: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary>;
  updateOrderRequirement?(
    orderId: string,
    requirementId: string,
    input: { expectedOrderVersion: number; expectedRequirementVersion: number; action: 'CHANGE_PROJECT' | 'CHANGE_QUANTITY' | 'CHANGE_NOTE' | 'REMOVE'; serviceCatalogVersionId?: string | null; unitCount?: number | null; requestedPlayerCount?: number | null;customerNote?:string|null },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary>;
  listServicePackages?(actor:BotActorContext,cursor?:string,limit?:number):Promise<ServicePackagePageSummary>;
  previewServicePackage?(servicePackageVersionId:string,actor:BotActorContext):Promise<ServicePackagePreviewSummary>;
  applyServicePackage?(orderId:string,input:{expectedOrderVersion:number;servicePackageVersionId:string},actor:BotActorContext,idempotencyKey:string):Promise<ApplyServicePackageSummary>;
  getCurrentUser(actor: BotActorContext): Promise<CurrentUserSummary>;
  getCurrentBalance(actor: BotActorContext): Promise<BalanceSummary>;
  getCurrentUserProfileSummary(actor: BotActorContext): Promise<CurrentUserProfileSummary>;
  listCurrentUserOrders(actor: BotActorContext, cursor?: string, limit?: number): Promise<CurrentUserOrderPage>;
  listCurrentUserConsumptions(actor: BotActorContext, cursor?: string, limit?: number): Promise<ConsumptionPage>;
  listCurrentPlayerWeeklyReports(actor: BotActorContext, cursor?: string, limit?: number): Promise<CurrentPlayerWeeklyReportPage>;
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
  syncDiscordPresence(
    input: SyncDiscordPresenceRequest,
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<PresenceSyncResult>;
  getPlayerWorkbench(actor: BotActorContext): Promise<PlayerWorkbenchSummary>;
  setPlayerAvailability(
    input: { expectedVersion: number; availability: 'AVAILABLE' | 'BUSY' | 'OFFLINE' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown>;
  listGifts(orderId: string, actor: BotActorContext): Promise<GiftPanelData>;
  checkGiftAffordability(orderId: string, giftCatalogVersionId: string, participantIds: string[], actor: BotActorContext): Promise<GiftAffordabilityResult>;
  createOrderGiftRequest(
    orderId: string,
    input: { expectedOrderVersion: number; giftCatalogVersionId: string; participantIds: string[]; expectedCatalogVersion: number; expectedPriceMinor: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<GiftRequestResult>;
  createOrderAppeal(
    orderId: string,
    input: { type: 'ORDER_ASSIST'; reasonCode: 'CUSTOMER_DISPUTE'; note: string; voiceChannelId: null },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ id: string; publicId: string }>;
}

export class BotApiError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;

  public constructor(input: { code: string; message: string; requestId: string; statusCode: number }) {
    super(input.message);
    this.name = 'BotApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
  }
}

export class HttpBotApiClient implements BotApiClient {
  private readonly apiBaseUrl: string;
  private readonly botServiceToken: string;

  public constructor(input: { apiBaseUrl: string; botServiceToken: string }) {
    this.apiBaseUrl = input.apiBaseUrl.replace(/\/+$/u, '');
    this.botServiceToken = input.botServiceToken;
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

  public async listServices(actor: BotActorContext): Promise<{ items: PublicServiceSummary[] }> {
    return this.request('/api/v1/services', { method: 'GET', actor });
  }

  public async reportChannelCreationFailure(
    input: { requestId: string; failureCode: 'CHANNEL_CREATE_FAILED' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown> {
    return this.request('/api/v1/internal/discord/channel-failures', { method: 'POST', actor, idempotencyKey, body: input });
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

  public async listOrderRequirements(orderId: string, actor: BotActorContext, cursor?: string, limit = 10): Promise<OrderRequirementPageSummary> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return this.request<OrderRequirementPageSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/requirements?${query.toString()}`, { method: 'GET', actor });
  }

  public async addOrderRequirement(
    orderId: string,
    input: { expectedOrderVersion: number; serviceCatalogVersionId: string; unitCount: number; requestedPlayerCount: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary> {
    return this.request<OrderRequirementMutationSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/requirements`, { method: 'POST', actor, idempotencyKey, body: input });
  }

  public async updateOrderRequirement(
    orderId: string,
    requirementId: string,
    input: { expectedOrderVersion: number; expectedRequirementVersion: number; action: 'CHANGE_PROJECT' | 'CHANGE_QUANTITY' | 'CHANGE_NOTE' | 'REMOVE'; serviceCatalogVersionId?: string | null; unitCount?: number | null; requestedPlayerCount?: number | null;customerNote?:string|null },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<OrderRequirementMutationSummary> {
    return this.request<OrderRequirementMutationSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/requirements/${encodeURIComponent(requirementId)}`, { method: 'PATCH', actor, idempotencyKey, body: input });
  }

  public async listServicePackages(actor:BotActorContext,cursor?:string,limit=25):Promise<ServicePackagePageSummary>{const query=new URLSearchParams({limit:String(limit)});if(cursor)query.set('cursor',cursor);return this.request<ServicePackagePageSummary>(`/api/v1/service-packages?${query.toString()}`,{method:'GET',actor});}
  public async previewServicePackage(servicePackageVersionId:string,actor:BotActorContext):Promise<ServicePackagePreviewSummary>{return this.request<ServicePackagePreviewSummary>(`/api/v1/service-packages/${encodeURIComponent(servicePackageVersionId)}/preview`,{method:'POST',actor});}
  public async applyServicePackage(orderId:string,input:{expectedOrderVersion:number;servicePackageVersionId:string},actor:BotActorContext,idempotencyKey:string):Promise<ApplyServicePackageSummary>{return this.request<ApplyServicePackageSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/package`,{method:'POST',actor,idempotencyKey,body:input});}

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
    return this.request<CurrentUserProfileSummary>('/api/v1/me/profile', { method: 'GET', actor });
  }

  public async listCurrentUserOrders(actor: BotActorContext, cursor?: string, limit = 5): Promise<CurrentUserOrderPage> {
    return this.request<CurrentUserOrderPage>(pagePath('/api/v1/me/orders', cursor, limit), { method: 'GET', actor });
  }

  public async listGifts(orderId: string, actor: BotActorContext): Promise<GiftPanelData> {
    return this.request<GiftPanelData>(`/api/v1/gifts?orderId=${encodeURIComponent(orderId)}`, {
      method: 'GET', actor
    });
  }

  public async checkGiftAffordability(orderId: string, giftCatalogVersionId: string, participantIds: string[],
    actor: BotActorContext): Promise<GiftAffordabilityResult> {
    return this.request<GiftAffordabilityResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/gift-affordability`, {
      method: 'POST', actor, body: { giftCatalogVersionId, participantIds }
    });
  }

  public async createOrderGiftRequest(
    orderId: string,
    input: { expectedOrderVersion: number; giftCatalogVersionId: string; participantIds: string[]; expectedCatalogVersion: number; expectedPriceMinor: number },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<GiftRequestResult> {
    return this.request<GiftRequestResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/gift-requests`, {
      method: 'POST', actor, idempotencyKey, body: input
    });
  }

  public async createOrderAppeal(
    orderId: string,
    input: { type: 'ORDER_ASSIST'; reasonCode: 'CUSTOMER_DISPUTE'; note: string; voiceChannelId: null },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<{ id: string; publicId: string }> {
    return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/staff-tasks`, {
      method: 'POST', actor, idempotencyKey, body: input
    });
  }

  public async listCurrentUserConsumptions(actor: BotActorContext, cursor?: string, limit?: number): Promise<ConsumptionPage> {
    const path = cursor !== undefined || limit !== undefined ? pagePath('/api/v1/me/consumptions', cursor, limit ?? 5) : '/api/v1/me/consumptions';
    return this.request<ConsumptionPage>(path, {
      method: 'GET',
      actor
    });
  }

  public async listCurrentPlayerWeeklyReports(actor: BotActorContext, cursor?: string, limit = 5): Promise<CurrentPlayerWeeklyReportPage> {
    return this.request<CurrentPlayerWeeklyReportPage>(pagePath('/api/v1/players/me/weekly-reports', cursor, limit), { method: 'GET', actor });
  }

  public async getCurrentPlayerWeeklyReport(reportId: string, actor: BotActorContext): Promise<CurrentPlayerWeeklyReport> {
    return this.request<CurrentPlayerWeeklyReport>(`/api/v1/players/me/weekly-reports/${encodeURIComponent(reportId)}`, { method: 'GET', actor });
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
    return this.request<CancellationPreviewSummary>(`/api/v1/orders/${encodeURIComponent(orderId)}/cancellation-preview`, {
      method: 'POST', actor, idempotencyKey, body: input
    });
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

  public async setPlayerAvailability(
    input: { expectedVersion: number; availability: 'AVAILABLE' | 'BUSY' | 'OFFLINE' },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<unknown> {
    return this.request('/api/v1/players/me/availability', { method: 'PUT', actor, idempotencyKey, body: input });
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
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.botServiceToken}`,
      'x-client-source': input.actor.clientSource,
      'x-actor-discord-user-id': input.actor.discordUserId,
      'x-actor-guild-id': input.actor.guildId,
      'x-discord-interaction-id': input.actor.interactionId
    };
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (input.idempotencyKey) {
      headers['idempotency-key'] = input.idempotencyKey;
    }

    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
    const envelope = await response.json() as ApiEnvelope<T>;

    if (!response.ok) {
      throw new BotApiError({
        code: envelope.error?.code ?? 'SERVICE_UNAVAILABLE',
        message: envelope.error?.message ?? 'Unified API request failed.',
        requestId: envelope.requestId ?? 'unknown',
        statusCode: response.status
      });
    }

    if (input.includeStatus) {
      return { statusCode: response.status, data: envelope.data as T };
    }
    return envelope.data as T;
  }
}

interface ApiEnvelope<T> {
  requestId?: string;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

function pagePath(path: string, cursor: string | undefined, limit: number): string {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  query.set('limit', String(limit));
  return `${path}?${query.toString()}`;
}

function paginationCustomId(prefix: string, cursor: string): string {
  if (!/^c1_[A-Za-z0-9_-]{20,70}$/u.test(cursor)) throw new Error('API pagination cursor is invalid.');
  const customId = `${prefix}:${cursor}`;
  if (customId.length > 100) throw new Error('Discord pagination custom ID exceeds 100 characters.');
  return customId;
}

export interface ActionRowSpec {
  type: 'ACTION_ROW';
  components: ComponentSpec[];
}

export type ComponentSpec =
  | {
      type: 'BUTTON';
      style: 'PRIMARY' | 'SECONDARY' | 'DANGER';
      customId: string;
      label: string;
      disabled?: boolean;
    }
  | {
      type: 'LINK_BUTTON';
      style: 'LINK';
      url: string;
      label: string;
      disabled?: boolean;
    }
  | {
      type: 'STRING_SELECT';
      customId: string;
      placeholder: string;
      options: Array<{ label: string; value: string; description?: string; default?: boolean }>;
      minValues?: number;
      maxValues?: number;
      disabled?: boolean;
    }
  | {
      type: 'USER_SELECT';
      customId: string;
      placeholder: string;
      minValues: number;
      maxValues: number;
      disabled?: boolean;
    };

export interface MessageSpec {
  title: string;
  body: string;
  visibility: 'PUBLIC' | 'EPHEMERAL' | 'PRIVATE_CHANNEL';
  components: ActionRowSpec[];
}

export interface ModalSpec {
  title: string;
  customId: string;
  components: TextInputSpec[];
}

export interface TextInputSpec {
  type: 'TEXT_INPUT';
  customId: string;
  label: string;
  style: 'SHORT' | 'PARAGRAPH';
  required: boolean;
  maxLength: number;
}

export type PermissionName = 'VIEW_CHANNEL' | 'SEND_MESSAGES' | 'MANAGE_CHANNELS';

export interface PermissionOverwriteSpec {
  id: string;
  kind: 'ROLE' | 'MEMBER';
  allow: PermissionName[];
  deny: PermissionName[];
}

export interface PrivateOrderChannelPlan {
  name: string;
  pinPanel: boolean;
  permissionOverwrites: PermissionOverwriteSpec[];
}

export interface AcceptedPlayerChannelPermissionPlan {
  channelId: string;
  permissionOverwrites: PermissionOverwriteSpec[];
}

export type BotFlowResult =
  | { kind: 'SHOW_MODAL'; modal: ModalSpec }
  | { kind: 'SHOW_SERVICE_CENTER'; message: MessageSpec }
  | { kind: 'SHOW_PLAYER_WORKBENCH'; message: MessageSpec }
  | { kind: 'OPEN_EXISTING_CHANNEL'; channelId: string; orderId: string }
  | { kind: 'CREATE_PRIVATE_CHANNEL'; order: OrderSummary; message: MessageSpec }
  | { kind: 'CHANNEL_CREATION_FAILED'; message: string }
  | { kind: 'EDIT_ORIGINAL_MESSAGE'; message: MessageSpec; notice?: string }
  | { kind: 'EPHEMERAL_MESSAGE'; message: string };

export type ServiceCenterRoute =
  | { area: 'entry'; action: 'create-order' | 'service-center' | 'player-workbench' }
  | { area: 'player-action'; action: 'set-available'; expectedVersion: number }
  | { area: 'cancellation-action'; action: 'confirm'; orderId: string; previewId: string; expectedVersion: number }
  | { area: 'order-select'; orderId: string; field: 'catalog' | 'duration' | 'preferred-players'; expectedVersion: number }
  | { area: 'order-requirement-select'; orderId: string; action: 'add'; requirementId?: undefined; expectedVersion: number }
  | { area: 'order-requirement-select'; orderId: string; action: 'edit'; requirementId?: undefined; expectedVersion: number; cursor?: string }
  | { area: 'order-requirement-select'; orderId: string; action: 'project' | 'units' | 'players'; requirementId: string; expectedVersion: number; expectedRequirementVersion: number }
  | { area: 'order-requirement-action'; orderId: string; action: 'back'; expectedVersion: number }
  | { area: 'order-requirement-action'; orderId: string; action: 'page'; expectedVersion: number; cursor?: string }
  | { area: 'order-requirement-action'; orderId: string; action: 'remove'; requirementId: string; expectedVersion: number; expectedRequirementVersion: number }
  | {area:'service-package-select';orderId:string;expectedVersion:number}
  | {area:'service-package-action';orderId:string;action:'open'|'back';expectedVersion:number}
  | {area:'service-package-action';orderId:string;action:'apply';servicePackageVersionId:string;expectedVersion:number}
  | { area: 'order-action'; orderId: string; action: 'submit' | 'submit-final' | 'cancel'; expectedVersion: number }
  | { area: 'service-action'; orderId: string; action: 'ready' | 'request-completion' | 'confirm' | 'support'; expectedVersion: number }
  | { area: 'order-notes-modal'; orderId: string; expectedVersion: number }
  | { area: 'order-notes-open'; orderId: string; expectedVersion: number }
  | {area:'requirement-note-modal';orderId:string;requirementId:string;expectedVersion:number;expectedRequirementVersion:number}
  | {area:'requirement-note-open';orderId:string;requirementId:string;expectedVersion:number;expectedRequirementVersion:number}
  | { area: 'profile'; action: 'open' | 'refresh' | 'orders' | 'consumptions'; cursor?: string }
  | { area: 'reports'; action: 'list'; cursor?: string }
  | { area: 'gift'; action: 'open'; orderId: string; expectedVersion: number }
  | { area: 'gift'; action: 'select' | 'refresh' | 'confirm' | 'back'; token: string }
  | { area: 'gift-recipient-select'; orderId: string; expectedVersion: number; page: number; selection: string }
  | { area: 'gift-catalog-select'; selection: string }
  | { area: 'gift-recipient-page'; orderId: string; expectedVersion: number; page: number; selection: string }
  | { area: 'reports'; action: 'detail'; reportId: string }
  | { area: 'unknown' };

export function buildPublicServiceEntryMessage(): MessageSpec {
  return {
    title: '陪玩服务中心',
    body: BOT_COPY.orders.publicEntryIntroduction,
    visibility: 'PUBLIC',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'PRIMARY', customId: 'bc:entry:create-order', label: '创建订单' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:service-center', label: '我的服务中心' }
        ]
      }
    ]
  };
}

export function buildOrderNotesModal(input: { orderId: string; expectedVersion: number }): ModalSpec {
  return {
    title: '补充订单备注',
    customId: `bc:modal:order-notes:${input.orderId}:v${input.expectedVersion}`,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'notes',
        label: '补充备注（可选）',
        style: 'PARAGRAPH',
        required: false,
        maxLength: 500
      }
    ]
  };
}

export function buildRequirementNoteModal(input:{orderId:string;requirementId:string;expectedVersion:number;expectedRequirementVersion:number}):ModalSpec{return{title:'这个席位希望怎样陪你',customId:`bc:rnm:${input.orderId}:${input.requirementId}:v${input.expectedVersion}:r${input.expectedRequirementVersion}`,components:[{type:'TEXT_INPUT',customId:'requirement-note',label:'例如：技术要求不高，会聊天就行',style:'PARAGRAPH',required:false,maxLength:500}]};}

export function buildPrivateOrderChannelPlan(input: {
  guildId: string;
  orderPublicId: string;
  customerDiscordUserId: string;
  botUserId: string;
  staffRoleIds: string[];
  playerRoleId?: string | null;
}): PrivateOrderChannelPlan {
  const overwrites: PermissionOverwriteSpec[] = [
    { id: input.guildId, kind: 'ROLE', allow: [], deny: ['VIEW_CHANNEL'] },
    {
      id: input.customerDiscordUserId,
      kind: 'MEMBER',
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
      deny: []
    },
    {
      id: input.botUserId,
      kind: 'MEMBER',
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'],
      deny: []
    },
    ...input.staffRoleIds.map((roleId) => ({
      id: roleId,
      kind: 'ROLE' as const,
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] as PermissionName[],
      deny: []
    }))
  ];

  if (input.playerRoleId) {
    overwrites.push({ id: input.playerRoleId, kind: 'ROLE', allow: [], deny: ['VIEW_CHANNEL'] });
  }

  return {
    name: `订单-${input.orderPublicId.toLowerCase()}`,
    pinPanel: true,
    permissionOverwrites: overwrites
  };
}

export function buildAcceptedPlayerChannelPermissionPlan(input: {
  channelId: string;
  acceptedPlayerDiscordUserId: string;
  rejectedCandidateDiscordUserIds: string[];
}): AcceptedPlayerChannelPermissionPlan {
  return {
    channelId: input.channelId,
    permissionOverwrites: [
      {
        id: input.acceptedPlayerDiscordUserId,
        kind: 'MEMBER',
        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
        deny: []
      }
    ]
  };
}

export function buildOrderPanelMessage(order: OrderSummary, services: PublicServiceSummary[] = []): MessageSpec {
  if (order.automation?.state === 'PAUSED') {
    return buildPausedAutomationMessage(order);
  }
  if ((order.status === 'PENDING_DISPATCH' || order.status === 'ACCEPTED') && order.matching) {
    return buildMatchingProgressMessage(order);
  }
  const title = `订单 #${order.publicId}`;
  const selectedService = services.find((service) => service.id === order.serviceCatalogId);
  const body = [
    `${selectedService?.gameDisplayName ?? order.gameDisplayName ?? formatGame(order.game)} · ${selectedService?.serviceDisplayName ?? order.serviceDisplayName ?? formatService(order.service)}`,
    `${selectedService?.regionDisplayName ?? order.regionDisplayName ?? formatRegion(order.region)} · ${formatDuration(order)}`,
    `预计价格：${formatCustomerMoney(order.amountMinor, order.currency)}`,
    `优先陪玩：${order.preferredPlayerDiscordUserIds?.length ?? 0}/3（可选）`,
    order.notes ? `备注：${order.notes}` : '备注：未填写'
  ].join('\n');

  return {
    title,
    body,
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          select(`bc:select:order:${order.id}:catalog:v${order.version}`, '选择陪玩项目', serviceOptions(order, services))
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          select(`bc:select:order:${order.id}:duration:v${order.version}`, '选择时长', [
            { label: '1 小时', value: '1' },
            { label: '2 小时', value: '2' },
            { label: '3 小时', value: '3' }
          ])
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [{
          type: 'USER_SELECT',
          customId: `bc:select:order:${order.id}:preferred-players:v${order.version}`,
          placeholder: `优先陪玩（已选 ${order.preferredPlayerDiscordUserIds?.length ?? 0}/3）`,
          minValues: 0,
          maxValues: 3
        }]
      },
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:modal-open:order-notes:${order.id}:v${order.version}`, label: '补充备注' },
          { type: 'BUTTON', style: 'PRIMARY', customId: `bc:order:${order.id}:submit:v${order.version}`, label: '确认订单' },
          { type: 'BUTTON', style: 'DANGER', customId: `bc:order:${order.id}:cancel:v${order.version}`, label: '取消订单' },
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:service:support:${order.id}:v${order.version}`, label: '我要申诉' }
        ]
      }
    ]
  };
}

export function buildMultiProjectOrderPanelMessage(
  order: OrderSummary,
  page: OrderRequirementPageSummary,
  services: PublicServiceSummary[],
  selectedRequirementId?: string,
  cursor?: string
): MessageSpec {
  const requirements = page.items.filter((item) => item.status === 'ACTIVE');
  const selected = requirements.find((item) => item.id === selectedRequirementId);
  const lines = requirements.length
    ? requirements.map((item, index) => [
        `**${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName}${item.regionDisplayName ? ` · ${item.regionDisplayName}` : ''}**`,
        `${formatRequirementDuration(item)} × ${item.requestedPlayerCount} 位 · ${formatCustomerMoney(item.estimatedLinePriceMinor, page.currency)}`,
        item.customerNote?`偏好：${item.customerNote}`:''
      ].join('\n')).join('\n\n')
    : '清单还是空的。请先从下方选择一个陪玩项目，我们会把它放进本次订单。';
  const components: ActionRowSpec[] = selected ? [
    { type: 'ACTION_ROW', components: [select(`bc:req:${order.id}:edit:${cursor ?? 'first'}:v${page.orderVersion}`, '选择要修改的项目', requirementOptions(requirements), requirements.length === 0)] }
  ] : [
    { type: 'ACTION_ROW', components: [select(`bc:req:${order.id}:add:v${page.orderVersion}`, '添加一个陪玩项目', serviceOptions(order, services))] },
    { type: 'ACTION_ROW', components: [select(`bc:req:${order.id}:edit:${cursor ?? 'first'}:v${page.orderVersion}`, '选择要修改的项目', requirementOptions(requirements), requirements.length === 0)] }
  ];
  if (selected) {
    components.push(
      { type: 'ACTION_ROW', components: [select(`bc:req:${order.id}:${selected.id}:project:v${page.orderVersion}:r${selected.version}`, `项目：${selected.gameDisplayName} · ${selected.serviceDisplayName}`, serviceOptions(order, services))] },
      { type: 'ACTION_ROW', components: [select(`bc:req:${order.id}:${selected.id}:units:v${page.orderVersion}:r${selected.version}`, `时长：${formatRequirementDuration(selected)}`, integerOptions(1, 12, selected.unitCount, (value) => `${value * selected.billingUnitMinutes / 60} 小时`))] },
      { type: 'ACTION_ROW', components: [select(`bc:req:${order.id}:${selected.id}:players:v${page.orderVersion}:r${selected.version}`, `需要 ${selected.requestedPlayerCount} 位陪玩`, integerOptions(1, 10, selected.requestedPlayerCount, (value) => `${value} 位陪玩`))] }
    );
  } else {
    components.push({ type: 'ACTION_ROW', components: [{
      type: 'USER_SELECT', customId: `bc:select:order:${order.id}:preferred-players:v${page.orderVersion}`,
      placeholder: `优先陪玩（已选 ${order.preferredPlayerDiscordUserIds?.length ?? 0}/3）`, minValues: 0, maxValues: 3
    }] });
    components.push({ type: 'ACTION_ROW', components: [
      { type: 'BUTTON', style: 'SECONDARY', customId: `bc:modal-open:order-notes:${order.id}:v${page.orderVersion}`, label: '补充备注' },
      ...(cursor ? [{ type: 'BUTTON' as const, style: 'SECONDARY' as const, customId: `bc:req:${order.id}:page:first:v${page.orderVersion}`, label: '返回首页' }] : []),
      ...(page.nextCursor ? [{ type: 'BUTTON' as const, style: 'SECONDARY' as const, customId: `bc:req:${order.id}:page:${page.nextCursor}:v${page.orderVersion}`, label: '下一页' }] : [])
    ] });
  }
  components.push({ type: 'ACTION_ROW', components: selected ? [
    { type: 'BUTTON', style: 'SECONDARY', customId: `bc:rno:${order.id}:${selected.id}:v${page.orderVersion}:r${selected.version}`, label: '席位偏好' },
    { type: 'BUTTON', style: 'DANGER', customId: `bc:req:${order.id}:${selected.id}:remove:v${page.orderVersion}:r${selected.version}`, label: '删除此项目' },
    { type: 'BUTTON', style: 'SECONDARY', customId: `bc:req:${order.id}:back:v${page.orderVersion}`, label: '返回清单' },
    { type: 'BUTTON', style: 'PRIMARY', customId: `bc:order:${order.id}:submit:v${page.orderVersion}`, label: '确认订单' },
    { type: 'BUTTON', style: 'DANGER', customId: `bc:order:${order.id}:cancel:v${page.orderVersion}`, label: '取消订单' }
  ] : [
    { type: 'BUTTON', style: 'SECONDARY', customId: `bc:package:${order.id}:open:v${page.orderVersion}`, label: '选择套餐' },
    { type: 'BUTTON', style: 'PRIMARY', customId: `bc:order:${order.id}:submit:v${page.orderVersion}`, label: '确认订单', disabled: requirements.length === 0 },
    { type: 'BUTTON', style: 'DANGER', customId: `bc:order:${order.id}:cancel:v${page.orderVersion}`, label: '取消订单' },
    { type: 'BUTTON', style: 'SECONDARY', customId: `bc:service:support:${order.id}:v${page.orderVersion}`, label: '我要申诉' }
  ] });

  return {
    title: `订单 #${order.publicId} · 陪玩清单`,
    body: [order.compositionMode==='PACKAGE_DEFAULT'?'当前构成：套餐默认阵容':order.compositionMode==='CUSTOMIZED'?'当前构成：已自定义阵容':null,lines,order.compositionMode==='PACKAGE_DEFAULT'&&(page.packageAdjustmentMinor??0)!==0?`项目原价：${formatCustomerMoney(page.catalogSubtotalMinor??page.derivedTotalMinor,page.currency)}\n套餐调整：${formatCustomerMoney(page.packageAdjustmentMinor??0,page.currency)}`:null, `合计：${formatCustomerMoney(page.derivedTotalMinor, page.currency)}`, `共需 ${requirements.reduce((sum, item) => sum + item.requestedPlayerCount, 0)} 位陪玩`, order.notes ? `备注：${order.notes}` : '备注：未填写'].filter(Boolean).join('\n\n'),
    visibility: 'PRIVATE_CHANNEL',
    components
  };
}

export function buildServicePackagePickerMessage(order:OrderSummary,page:ServicePackagePageSummary):MessageSpec{return{title:`订单 #${order.publicId} · 选择套餐`,body:['套餐会先展开成独立陪玩席位，应用后每个席位都能单独修改。',page.items.length?'请选择一个套餐查看默认阵容和服务端报价。':'目前没有可用套餐，你仍可返回自由搭配。'].join('\n\n'),visibility:'PRIVATE_CHANNEL',components:[...(page.items.length?[{type:'ACTION_ROW' as const,components:[select(`bc:package:${order.id}:select:v${order.version}`,'选择一个套餐',page.items.slice(0,25).map(item=>({label:item.displayName,value:item.id,description:`${item.slots.length} 个席位 · ${item.description}`.slice(0,100)})))]}]:[]),{type:'ACTION_ROW',components:[{type:'BUTTON',style:'SECONDARY',customId:`bc:package:${order.id}:back:v${order.version}`,label:'返回自由搭配'}]}]};}

export function buildServicePackagePreviewMessage(order:OrderSummary,pkg:ServicePackagePreviewSummary):MessageSpec{const slots=pkg.slots.map(slot=>`${slot.position}号位 · ${slot.gameDisplayName} · ${slot.serviceDisplayName}${slot.regionDisplayName?` · ${slot.regionDisplayName}`:''}\n${slot.unitCount*slot.billingUnitMinutes/60} 小时${slot.customerNoteTemplate?` · ${slot.customerNoteTemplate}`:''}`).join('\n\n');return{title:`${pkg.displayName} · 默认阵容`,body:[pkg.description,slots,`套餐报价：${formatCustomerMoney(pkg.derivedTotalMinor,pkg.currency)}`,'应用后可以把某个技术席位单独改成娱乐陪玩，其他席位不会变化；一旦修改，API 会按最终阵容重新报价。'].join('\n\n'),visibility:'PRIVATE_CHANNEL',components:[{type:'ACTION_ROW',components:[{type:'BUTTON',style:'PRIMARY',customId:`bc:package:${order.id}:${pkg.id}:apply:v${order.version}`,label:'使用这个套餐'},{type:'BUTTON',style:'SECONDARY',customId:`bc:package:${order.id}:open:v${order.version}`,label:'换一个套餐'},{type:'BUTTON',style:'SECONDARY',customId:`bc:package:${order.id}:back:v${order.version}`,label:'返回自由搭配'}]}]};}

export async function handleServicePackageSelect(input:{api:BotApiClient;actor:BotActorContext;orderId:string;expectedVersion:number;servicePackageVersionId:string}):Promise<BotFlowResult>{const api=requirePackageApi(input.api);const [order,pkg]=await Promise.all([input.api.getOrder(input.orderId,input.actor),api.preview(input.servicePackageVersionId,input.actor)]);if(order.status!=='DRAFT')return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildOrderPanelMessage(order)};return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildServicePackagePreviewMessage(order,pkg)};}

export async function handleServicePackageAction(input:{api:BotApiClient;actor:BotActorContext;orderId:string;expectedVersion:number;action:'open'|'back'|'apply';servicePackageVersionId?:string;idempotencyKey:string}):Promise<BotFlowResult>{const api=requirePackageApi(input.api);if(input.action==='open'){const [order,page]=await Promise.all([input.api.getOrder(input.orderId,input.actor),api.list(input.actor,undefined,25)]);return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildServicePackagePickerMessage(order,page)};}if(input.action==='apply'){if(!input.servicePackageVersionId)throw new Error('Package version is required.');await api.apply(input.orderId,{expectedOrderVersion:input.expectedVersion,servicePackageVersionId:input.servicePackageVersionId},input.actor,input.idempotencyKey);}if(!input.api.listOrderRequirements)throw new Error('Order requirement API is unavailable.');const [order,requirements,services]=await Promise.all([input.api.getOrder(input.orderId,input.actor),input.api.listOrderRequirements(input.orderId,input.actor,undefined,10),input.api.listServices(input.actor)]);return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildMultiProjectOrderPanelMessage(order,requirements,services.items)};}

function buildPausedAutomationMessage(order: OrderSummary): MessageSpec {
  return {
    title: `订单 #${order.publicId} · 客服处理中`,
    body: [
      BOT_COPY.orders.reviewPaused,
      BOT_COPY.orders.reviewInProgress,
      order.automation?.expiresAt ? botCopy.orders.reviewExpectedAt(order.automation.expiresAt) : null
    ].filter(Boolean).join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [{
      type: 'ACTION_ROW',
      components: [
        { type: 'BUTTON', style: 'SECONDARY', customId: `bc:service:support:${order.id}:v${order.version}`, label: '我要申诉' },
        { type: 'BUTTON', style: 'SECONDARY', customId: `bc:order:${order.id}:cancel:v${order.version}`, label: '查看取消影响' }
      ]
    }]
  };
}

export function buildMatchingProgressMessage(order: OrderSummary): MessageSpec {
  const matching = order.matching;
  if (!matching) {
    return {
      title: `订单 #${order.publicId}`,
      body: BOT_COPY.orders.matchingUnavailable,
      visibility: 'PRIVATE_CHANNEL',
      components: []
    };
  }
  if (matching.stage === 'ACCEPTED') {
    return {
      title: `订单 #${order.publicId} · 已匹配`,
      body: [
        `接单陪玩：${matching.playerSummary?.displayName ?? '已接单陪玩'}`,
        '下一步：请确认已准备好开始服务'
      ].join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: []
    };
  }
  const nextStep = matching.nextStep === 'CHOOSE_CONTINUE_OR_CANCEL'
    ? '下一步：继续等待、取消订单或联系客服'
    : '下一步：请等待陪玩接单';
  return {
    title: `订单 #${order.publicId} · ${matching.stage === 'TIMED_OUT' ? '本轮匹配结束' : '正在匹配陪玩'}`,
    body: [
      `已通知符合条件的陪玩：${matching.notifiedCandidateCount} 人`,
      matching.timeoutAt ? `本轮截止：${matching.timeoutAt}` : null,
      nextStep
    ].filter(Boolean).join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [{ type: 'ACTION_ROW', components: orderMenuControls(order.id, order.version) }]
  };
}

export function buildServiceCenterMessage(input: {
  currentUser: CurrentUserSummary;
  balance: BalanceSummary;
  activeOrder: OrderSummary | null;
  consumptions: ConsumptionPage;
  commissions: CurrentCommissionPage;
}): MessageSpec {
  const activeOrderLine = input.activeOrder
    ? `当前订单：#${input.activeOrder.publicId} · ${input.activeOrder.automation?.state === 'PAUSED' ? '客服处理中' : input.activeOrder.status}`
    : '当前订单：暂无进行中订单';
  const consumptionLine = input.consumptions.items.length === 0 ? '消费记录：暂无记录' : '消费记录：已有记录';
  const hasCommissionActivity = input.commissions.summary.pendingMinor !== 0
    || input.commissions.summary.confirmedMinor !== 0
    || input.commissions.summary.paidMinor !== 0;
  const commissionLine = hasCommissionActivity
    ? '我的收益：有待处理记录，请打开“我的收益”查看。'
    : '我的收益：暂无可领取记录';

  return {
    title: '我的服务中心',
    body: [
      `账户：${input.currentUser.user.displayName}`,
      `账本余额：${formatCustomerMoney(input.balance.ledgerBalanceMinor, input.balance.currency)}`,
      `预留中：${formatCustomerMoney(input.balance.reservedMinor, input.balance.currency)}`,
      `可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      activeOrderLine,
      consumptionLine,
      commissionLine,
      `计算时间：${input.balance.calculatedAt}`
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:service-center', label: '刷新' },
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: input.activeOrder ? `bc:order:${input.activeOrder.id}:open` : 'bc:service-center:no-active-order',
            label: '当前订单',
            disabled: !input.activeOrder
          },
          { type: 'BUTTON', style: 'PRIMARY', customId: 'bc:profile:open', label: '个人中心' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:consumptions:first', label: '消费记录' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:service-center:commissions', label: '我的收益' }
        ]
      }
    ]
  };
}

export function buildCurrentWalletMessage(balance: BalanceSummary): MessageSpec {
  return {
    title: `我的${customerWalletLabel(parseWalletDisplayConfig(process.env))}`,
    body: [
      `账本余额：${formatCustomerMoney(balance.ledgerBalanceMinor, balance.currency)}`,
      `已预留：${formatCustomerMoney(balance.reservedMinor, balance.currency)}`,
      `可用余额：${formatCustomerMoney(balance.availableMinor, balance.currency)}`,
      `计算时间：${balance.calculatedAt}`
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [{ type: 'ACTION_ROW', components: [
      { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:service-center', label: '刷新' }
    ] }]
  };
}

export function buildCurrentUserProfileMessage(input: CurrentUserProfileSummary): MessageSpec {
  const balance = input.balance;
  return {
    title: '个人中心',
    body: [
      `账户：${input.user.displayName}`,
      `账本余额：${formatCustomerMoney(balance.ledgerBalanceMinor, balance.currency)}`,
      `预留：${formatCustomerMoney(balance.reservedMinor, balance.currency)}`,
      `可用：${formatCustomerMoney(balance.availableMinor, balance.currency)}`,
      `进行中订单：${input.statistics.activeOrderCount}`,
      `累计订单消费：${formatCustomerMoney(input.statistics.orderSpendMinor, input.statistics.currency)}`,
      `累计礼物消费：${formatCustomerMoney(input.statistics.giftSpendMinor, input.statistics.currency)}`,
      `余额计算时间：${balance.calculatedAt}`
    ].filter(Boolean).join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      { type: 'ACTION_ROW', components: [
        { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:refresh', label: '刷新余额' }
      ] },
      { type: 'ACTION_ROW', components: [
        { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:orders:first', label: '我的订单' },
        { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:consumptions:first', label: '消费记录' }
      ] }
    ]
  };
}

export function buildCurrentUserOrdersMessage(page: CurrentUserOrderPage): MessageSpec {
  return { title: '我的订单', body: page.items.length ? page.items.map((item) =>
    `#${item.publicId} · ${item.status} · ${item.gameKey ?? '-'} / ${item.serviceKey ?? '-'} · ${formatCustomerMoney(item.amountMinor, item.currency)}\n${item.createdAt}`).join('\n\n') : '暂无订单。',
    visibility: 'EPHEMERAL', components: [{ type: 'ACTION_ROW', components: [
      { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:open', label: '返回个人中心' },
      { type: 'BUTTON', style: 'PRIMARY', customId: page.nextCursor ? paginationCustomId('bc:profile:orders', page.nextCursor) : 'bc:profile:orders:end', label: '下一页', disabled: !page.nextCursor }
    ] }] };
}

export function buildCurrentUserConsumptionsMessage(page: ConsumptionPage): MessageSpec {
  return { title: '消费记录', body: page.items.length ? page.items.map((item) =>
    `${item.type} · ${item.targetDisplay} · ${formatCustomerMoney(item.amountMinor, item.currency)}\n${item.occurredAt}`).join('\n\n') : '暂无消费记录。',
    visibility: 'EPHEMERAL', components: [{ type: 'ACTION_ROW', components: [
      { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:open', label: '返回个人中心' },
      { type: 'BUTTON', style: 'PRIMARY', customId: page.nextCursor ? paginationCustomId('bc:profile:consumptions', page.nextCursor) : 'bc:profile:consumptions:end', label: '下一页', disabled: !page.nextCursor }
    ] }] };
}

export function buildCurrentPlayerWeeklyReportListMessage(page: CurrentPlayerWeeklyReportPage): MessageSpec {
  return { title: '我的周报', body: page.items.length ? page.items.map((item) =>
    `${item.periodStart} 至 ${item.periodEnd} · ${item.status}`).join('\n') : '暂无周报。', visibility: 'EPHEMERAL',
    components: [
      ...page.items.slice(0, 4).map((item): ActionRowSpec => ({ type: 'ACTION_ROW', components: [
        { type: 'BUTTON', style: 'SECONDARY', customId: `bc:reports:detail:${item.id}`, label: `${item.periodStart.slice(0, 10)} 周报` }
      ] })),
      { type: 'ACTION_ROW', components: [
        { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:player-workbench', label: '返回工作台' },
        { type: 'BUTTON', style: 'PRIMARY', customId: page.nextCursor ? paginationCustomId('bc:reports:list', page.nextCursor) : 'bc:reports:list:end', label: '下一页', disabled: !page.nextCursor }
      ] }
    ] };
}

export function buildCurrentPlayerWeeklyReportDetailMessage(report: CurrentPlayerWeeklyReport): MessageSpec {
  const metrics = report.metrics;
  return { title: '我的周报详情', body: [
    `${report.periodStart} 至 ${report.periodEnd} · ${report.status}`,
    `完成订单：${metrics.completedOrderCount} · 取消：${metrics.cancelledOrderCount} · 服务：${metrics.serviceMinutes} 分钟`,
    `订单收益：${formatPlatformMoney(metrics.orderEarningMinor, report.currency)} · 礼物收益：${formatPlatformMoney(metrics.giftEarningMinor, report.currency)}`,
    `调整：${formatPlatformMoney(metrics.adjustmentMinor, report.currency)}`,
    `待确认：${formatPlatformMoney(metrics.pendingMinor, report.currency)} · 可结算：${formatPlatformMoney(metrics.settlementReadyMinor, report.currency)}`,
    `已入批次：${formatPlatformMoney(metrics.batchedMinor, report.currency)} · 修订 ${report.currentRevision}`
  ].join('\n'), visibility: 'EPHEMERAL', components: [{ type: 'ACTION_ROW', components: [
    { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:reports:list:first', label: '返回周报' }
  ] }] };
}

export function buildCancellationPreviewMessage(preview: CancellationPreviewSummary): MessageSpec {
  const handling = preview.staffTaskRequired
    ? '处理方式：提交客服核对，不会自动退款或扣款'
    : '处理方式：确认后立即处理';
  return {
    title: '取消影响确认',
    body: [
      `释放预留：${formatCustomerMoney(preview.releaseAmountMinor, preview.currency)}`,
      `退款：${formatCustomerMoney(preview.refundAmountMinor, preview.currency)}`,
      handling,
      `预览有效期：${preview.validUntil}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [{
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON', style: preview.staffTaskRequired ? 'SECONDARY' : 'DANGER',
          customId: `bc:cancel:${preview.orderId}:${preview.previewId}:confirm:v${preview.orderVersion}`,
          label: preview.staffTaskRequired ? '提交客服处理' : '确认取消'
        },
        { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:service-center', label: '返回服务中心' }
      ]
    }]
  };
}

export function buildPlayerWorkbenchMessage(workbench: PlayerWorkbenchSummary): MessageSpec {
  const currentOrder = workbench.currentOrder
    ? `当前订单：#${workbench.currentOrder.publicId} · ${workbench.currentOrder.status}`
    : '当前订单：暂无';
  const matchingLines = workbench.matchingOrders.length > 0
    ? workbench.matchingOrders.map((match) => [
      `待接订单：#${match.order.publicId} · ${match.order.gameDisplayName ?? formatGame(match.order.game)} / ${match.order.serviceDisplayName ?? formatService(match.order.service)}`,
      `需求：${match.order.requirements.join('、') || '无额外要求'} · 剩余 ${match.secondsRemaining} 秒`,
      `预计收益：${formatPlatformMoney(match.order.playerEarningMinor, match.order.currency)}`
    ].join('\n')).join('\n')
    : '待接订单：暂无';
  const failedChecks = workbench.eligibility.checks.filter((check) => !check.passed);
  const components: MessageSpec['components'] = [{
    type: 'ACTION_ROW',
    components: [
      { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:player-workbench', label: '刷新' },
      { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:reports:list:first', label: '我的周报' }
    ]
  }];
  const firstMatch = workbench.matchingOrders[0];
  if (firstMatch && workbench.nextActions.includes('ACCEPT_ORDER')) {
    components[0]!.components.push(
      {
        type: 'BUTTON', style: 'PRIMARY',
        customId: `bc:dispatch:${firstMatch.dispatchAttemptId}:accept:${firstMatch.order.id}:v${firstMatch.order.version}`,
        label: '接单'
      },
      {
        type: 'BUTTON', style: 'SECONDARY',
        customId: `bc:dispatch:${firstMatch.dispatchAttemptId}:decline:${firstMatch.order.id}:v${firstMatch.order.version}`,
        label: '暂不接单'
      }
    );
  } else if (workbench.nextActions.includes('SET_AVAILABLE')) {
    components[0]!.components.push({
      type: 'BUTTON', style: 'PRIMARY', customId: `bc:player:availability:AVAILABLE:v${workbench.profile.version}`, label: '设为可接单'
    });
  }
  return {
    title: '陪玩工作台',
    body: [
      `准入状态：${workbench.eligibility.eligible ? '可接单' : '暂不可接单'}`,
      `Discord 在线状态：${workbench.profile.discordPresence}`,
      `业务可接单开关：${workbench.profile.availability}`,
      failedChecks.length > 0 ? `未满足条件：${failedChecks.map((check) => check.reason ?? check.code).join('；')}` : null,
      currentOrder,
      matchingLines,
      `待确认收益：${formatPlatformMoney(workbench.earningsSummary.pendingMinor, workbench.earningsSummary.currency)}`,
      `已确认收益：${formatPlatformMoney(workbench.earningsSummary.confirmedMinor, workbench.earningsSummary.currency)}`,
      `已支付收益：${formatPlatformMoney(workbench.earningsSummary.paidMinor, workbench.earningsSummary.currency)}`,
      `更新时间：${workbench.earningsSummary.calculatedAt}`
    ].filter(Boolean).join('\n'),
    visibility: 'EPHEMERAL',
    components
  };
}

export function buildDispatchOfferMessage(input: DispatchOfferSummary): MessageSpec {
  return {
    title: `新订单 #${input.orderPublicId}`,
    body: [
      `${input.game} · ${input.service}`,
      `区服：${input.region}`,
      `时长：${input.durationLabel}`,
      `预计收益：${formatPlatformMoney(input.playerEarningMinor, input.currency)}`,
      input.voiceChannelId ? `语音频道：${input.voiceChannelId}` : '语音频道：待创建',
      input.notes ? `备注：${input.notes}` : '备注：未填写',
      `接单截止：${input.expiresAt}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:dispatch:${input.dispatchAttemptId}:accept:${input.orderId}:v${input.orderVersion}`,
            label: '确认接单'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:dispatch:${input.dispatchAttemptId}:decline:${input.orderId}:v${input.orderVersion}`,
            label: '暂不接单'
          }
        ]
      }
    ]
  };
}

export function buildAcceptedDispatchMessage(input: {
  offer: DispatchOfferSummary;
  acceptedPlayerDisplayName: string;
}): MessageSpec {
  return {
    title: `订单 #${input.offer.orderPublicId} 已被接取`,
    body: [
      `接单陪玩：${input.acceptedPlayerDisplayName}`,
      `${input.offer.game} · ${input.offer.service}`,
      `区服：${input.offer.region}`,
      `时长：${input.offer.durationLabel}`,
      '本轮派单已结束，其他候选按钮已失效。'
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:dispatch:${input.offer.dispatchAttemptId}:accepted:${input.offer.orderId}:v${input.offer.orderVersion}`,
            label: '已接单',
            disabled: true
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:dispatch:${input.offer.dispatchAttemptId}:closed:${input.offer.orderId}:v${input.offer.orderVersion}`,
            label: '本轮已结束',
            disabled: true
          }
        ]
      }
    ]
  };
}

export function buildServiceLifecyclePanelMessage(order: OrderLifecyclePanelSummary): MessageSpec {
  const giftsEnabled = Array.isArray(order.enabledFeatures) && order.enabledFeatures.includes('GIFTS');
  if (order.status === 'ACCEPTED') {
    return {
      title: `订单 #${order.publicId} · 等待双方就绪`,
      body: [
        `用户：${readinessLabel(order.readiness.customer)}`,
        `陪玩：${readinessLabel(order.readiness.player)}`,
        order.readiness.readyDeadlineAt ? `就绪截止：${order.readiness.readyDeadlineAt}` : null
      ].filter(Boolean).join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'PRIMARY',
              customId: `bc:service:ready:${order.orderId}:v${order.version}`,
              label: '我已就绪'
            },
            {
              type: 'BUTTON', style: 'DANGER',
              customId: `bc:order:${order.orderId}:cancel:v${order.version}`,
              label: '取消订单'
            },
            {
              type: 'BUTTON', style: 'SECONDARY',
              customId: `bc:service:support:${order.orderId}:v${order.version}`,
              label: '我要申诉'
            },
            ...(order.actorRole === 'CUSTOMER' && giftsEnabled ? [{ type: 'BUTTON' as const, style: 'SECONDARY' as const,
              customId: `bc:gift:open:${order.orderId}:v${order.version}`, label: '赠送礼物' }] : [])
          ]
        }
      ]
    };
  }
  if (order.status === 'IN_SERVICE') {
    const components: ComponentSpec[] = orderMenuControls(order.orderId, order.version);
    if (order.actorRole === 'PLAYER') {
      components.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:request-completion:${order.orderId}:v${order.version}`,
        label: '申请完成'
      });
    }
    if (order.actorRole === 'CUSTOMER' && giftsEnabled) components.unshift({ type: 'BUTTON', style: 'SECONDARY',
      customId: `bc:gift:open:${order.orderId}:v${order.version}`, label: '赠送礼物' });
    return {
      title: `订单 #${order.publicId} · 服务中`,
      body: order.readiness.startedAt ? `开始时间：${order.readiness.startedAt}` : '服务已开始。',
      visibility: 'PRIVATE_CHANNEL',
      components: [{ type: 'ACTION_ROW', components }]
    };
  }
  if (order.status === 'PENDING_CONFIRMATION') {
    const components: ComponentSpec[] = orderMenuControls(order.orderId, order.version);
    if (order.actorRole === 'CUSTOMER') {
      components.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:confirm:${order.orderId}:v${order.version}`,
        label: '确认完成'
      });
      if (giftsEnabled) components.push({ type: 'BUTTON', style: 'SECONDARY',
        customId: `bc:gift:open:${order.orderId}:v${order.version}`, label: '赠送礼物' });
    }
    return {
      title: `订单 #${order.publicId} · 等待用户确认`,
      body: BOT_COPY.orders.completionPending,
      visibility: 'PRIVATE_CHANNEL',
      components: [{ type: 'ACTION_ROW', components }]
    };
  }
  if (order.status === 'EXCEPTION' || order.readiness.staffTaskId) {
    return {
      title: `订单 #${order.publicId} · 客服处理中`,
      body: [
        order.readiness.staffTaskId
          ? `客服任务已创建：${order.readiness.staffTaskId}`
          : '客服任务已创建，等待客服核对。',
        BOT_COPY.orders.staffReviewScope
      ].join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${order.orderId}:v${order.version}`,
              label: '联系客服'
            }
          ]
        }
      ]
    };
  }
  return {
    title: `订单 #${order.publicId}`,
    body: `当前状态：${order.status}`,
    visibility: 'PRIVATE_CHANNEL',
    components: []
  };
}

export function buildOrderConfirmationMessage(input: {
  order: OrderSummary;
  estimate: OrderEstimateSummary;
  balance: BalanceSummary;
}): MessageSpec {
  const missing = missingConfirmationFields(input.order);
  const currencyMismatch = input.estimate.currency !== input.balance.currency;
  const deficitMinor = Math.max(0, input.estimate.amountMinor - input.balance.availableMinor);
  const canSubmit = missing.length === 0 && deficitMinor === 0 && !currencyMismatch;
  const statusLine = canSubmit
    ? '状态：可以提交。提交时 API 会再次复核价格、余额、版本和服务目录。'
    : confirmationBlockedReason({ missing, deficitMinor, estimateCurrency: input.estimate.currency, currencyMismatch });

  return {
    title: `订单 #${input.order.publicId} · 最后确认`,
    body: [
      `游戏：${formatGame(input.order.game)}`,
      `服务：${formatService(input.order.service)}`,
      `区服：${formatRegion(input.order.region)}`,
      `时长：${formatEstimateDuration(input.estimate)}`,
      '标签：P0 默认匹配',
      input.order.notes ? `备注：${input.order.notes}` : '备注：未填写',
      `预计价格：${formatCustomerMoney(input.estimate.amountMinor, input.estimate.currency)}`,
      `可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      '取消规则：提交前取消不预留；提交后、服务开始前取消将释放预留，异常由客服处理。',
      statusLine,
      `价格有效期：${input.estimate.validUntil}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${input.order.id}:submit-final:v${input.order.version}`,
            label: '确认提交并预留',
            disabled: !canSubmit
          },
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:order:${input.order.id}:refresh:v${input.order.version}`, label: '刷新确认' },
          { type: 'BUTTON', style: 'DANGER', customId: `bc:order:${input.order.id}:cancel:v${input.order.version}`, label: '取消订单' },
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:service:support:${input.order.id}:v${input.order.version}`, label: '我要申诉' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:service-center:recharge', label: '联系客服充值', disabled: deficitMinor === 0 }
        ]
      }
    ]
  };
}

export function buildMultiProjectOrderConfirmationMessage(input: {
  order: OrderSummary;
  requirements: OrderRequirementPageSummary;
  balance: BalanceSummary;
}): MessageSpec {
  const active = input.requirements.items.filter((item)=>item.status==='ACTIVE');
  const currencyMismatch=input.requirements.currency!==input.balance.currency;
  const deficitMinor=Math.max(0,input.requirements.derivedTotalMinor-input.balance.availableMinor);
  const canSubmit=active.length>0&&!currencyMismatch&&deficitMinor===0;
  const lines=active.map((item,index)=>`${index+1}. ${item.gameDisplayName} · ${item.serviceDisplayName}${item.regionDisplayName?` · ${item.regionDisplayName}`:''}\n   ${formatRequirementDuration(item)} × ${item.requestedPlayerCount} 位 · ${formatCustomerMoney(item.estimatedLinePriceMinor,input.requirements.currency)}${item.customerNote?`\n   偏好：${item.customerNote}`:''}`).join('\n');
  return {title:`订单 #${input.order.publicId} · 最后确认`,body:[lines||'还没有添加陪玩项目。',input.order.notes?`备注：${input.order.notes}`:'备注：未填写',`订单合计：${formatCustomerMoney(input.requirements.derivedTotalMinor,input.requirements.currency)}`,`可用余额：${formatCustomerMoney(input.balance.availableMinor,input.balance.currency)}`,canSubmit?'状态：可以提交。提交时 API 会再次复核项目、价格、余额和订单版本。':currencyMismatch?'订单币种与钱包币种不一致。':active.length===0?'请先添加至少一个陪玩项目。':`可用余额还差 ${formatCustomerMoney(deficitMinor,input.requirements.currency)}。`].join('\n\n'),visibility:'PRIVATE_CHANNEL',components:[{type:'ACTION_ROW',components:[
    {type:'BUTTON',style:'PRIMARY',customId:`bc:order:${input.order.id}:submit-final:v${input.requirements.orderVersion}`,label:'确认提交并预留',disabled:!canSubmit},
    {type:'BUTTON',style:'SECONDARY',customId:`bc:req:${input.order.id}:back:v${input.requirements.orderVersion}`,label:'返回修改'},
    {type:'BUTTON',style:'DANGER',customId:`bc:order:${input.order.id}:cancel:v${input.requirements.orderVersion}`,label:'取消订单'}
  ]}]};
}

function readinessLabel(value: 'READY' | 'NOT_READY'): string {
  return value === 'READY' ? '已就绪' : '未就绪';
}

export function buildSubmittedOrderMessage(input: OrderReservationSummaryResult): MessageSpec {
  return {
    title: '订单已提交 · 正在匹配陪玩',
    body: [
      `订单状态：${input.status}`,
      `本单预留：${formatCustomerMoney(input.reservation.amountMinor, input.reservation.currency)}`,
      `预留状态：${input.reservation.status}`,
      `提交后可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      `当前预留总额：${formatCustomerMoney(input.balance.reservedMinor, input.balance.currency)}`,
      BOT_COPY.orders.reservationOnly,
      BOT_COPY.orders.dispatchStarted
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:order:${input.orderId}:submit:v${input.version}`, label: '刷新订单' },
          { type: 'BUTTON', style: 'DANGER', customId: `bc:order:${input.orderId}:cancel:v${input.version}`, label: '取消订单' },
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:service:support:${input.orderId}:v${input.version}`, label: '我要申诉' }
        ]
      }
    ]
  };
}

export function buildCancellationResultMessage(input: CancellationResultSummary): MessageSpec {
  if (input.staffTaskId && input.status !== 'CANCELLED') {
    return {
      title: '取消申请已转客服',
      body: [
        `客服任务已创建：${input.staffTaskId}`,
        `订单仍保持：${input.status}`,
        '客服会核对订单、语音频道、服务进度和资金状态；不会自动退款或释放预留。'
      ].join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${input.orderId}:v${input.version}`,
              label: '联系客服'
            }
          ]
        }
      ]
    };
  }
  return {
    title: '订单已取消',
    body: [
      `订单状态：${input.status}`,
      `资金处理：${input.fundAction}`,
      input.releasedReservation ? `释放金额：${formatCustomerMoney(input.releasedReservation.releasedMinor, input.releasedReservation.currency)}` : null
    ].filter(Boolean).join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: []
  };
}

export async function handleOpenOrderConfirmation(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const order = await input.api.getOrder(input.orderId, input.actor);
  if (order.status !== 'DRAFT') {
    return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildOrderPanelMessage(order) };
  }
  try {
    if (input.api.listOrderRequirements) {
      const [requirements,balance]=await Promise.all([
        input.api.listOrderRequirements(input.orderId,input.actor,undefined,25),
        input.api.getCurrentBalance(input.actor)
      ]);
      return {kind:'EDIT_ORIGINAL_MESSAGE',message:buildMultiProjectOrderConfirmationMessage({order,requirements,balance})};
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
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '打开确认面板失败') };
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
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '提交订单失败') };
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
      let result;
      try {
        result = await input.api.setOrderReadiness(
          input.orderId,
          { expectedVersion: input.expectedVersion, readiness: 'READY' },
          input.actor,
          input.idempotencyKey
        );
      } catch (error) {
        if (!isApiError(error, 'CONFLICT')) throw error;
        const refreshed = await input.api.getOrder(input.orderId, input.actor);
        if (refreshed.status !== 'ACCEPTED') {
          return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildOrderPanelMessage(refreshed), notice: BOT_COPY.orders.stateRefreshed };
        }
        result = await input.api.setOrderReadiness(
          input.orderId,
          { expectedVersion: refreshed.version, readiness: 'READY' },
          input.actor,
          `${input.idempotencyKey}:retry-v${refreshed.version}`
        );
      }
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
      return { kind: 'EPHEMERAL_MESSAGE', message: BOT_COPY.orders.completionRequested };
    }
    if (input.action === 'confirm') {
      const result = await input.api.confirmOrder(
        input.orderId,
        { expectedVersion: input.expectedVersion, confirmation: 'CONFIRM_COMPLETED' },
        input.actor,
        input.idempotencyKey
      );
      return {
        kind: 'EPHEMERAL_MESSAGE',
        message: botCopy.lifecycle.completionConfirmed(formatCustomerMoney(result.capturedMinor, result.currency))
      };
    }
    const task = await input.api.createOrderAppeal(input.orderId, {
      type: 'ORDER_ASSIST', reasonCode: 'CUSTOMER_DISPUTE', note: '用户从订单常驻菜单发起申诉。', voiceChannelId: null
    }, input.actor, input.idempotencyKey);
    return { kind: 'EPHEMERAL_MESSAGE', message: botCopy.lifecycle.appealSubmitted(task.publicId) };
  } catch (error) {
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '订单状态操作失败') };
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
    if (isApiError(error, 'ACCOUNT_NOT_BOUND') || isApiError(error, 'AUTH_REQUIRED')) {
      return { kind: 'EPHEMERAL_MESSAGE', message: BOT_COPY.orders.accountUnavailable };
    }
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '打开服务中心失败') };
  }
}

export async function handleOpenPlayerWorkbench(input: {
  api: BotApiClient;
  actor: BotActorContext;
}): Promise<BotFlowResult> {
  try {
    const workbench = await input.api.getPlayerWorkbench(input.actor);
    return { kind: 'SHOW_PLAYER_WORKBENCH', message: buildPlayerWorkbenchMessage(workbench) };
  } catch (error) {
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '打开陪玩工作台失败') };
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
      { expectedVersion: input.expectedVersion, reasonCode: 'CUSTOMER_REQUEST' },
      input.actor,
      input.idempotencyKey
    );
    return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildCancellationPreviewMessage(preview) };
  } catch (error) {
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '打开取消预览失败') };
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
      { expectedVersion: input.expectedVersion, previewId: input.previewId, reasonCode: 'CUSTOMER_REQUEST' },
      input.actor,
      input.idempotencyKey
    );
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: result.staffTaskId ? BOT_COPY.orders.cancellationEscalated : BOT_COPY.orders.cancellationCompleted
    };
  } catch (error) {
    if (error instanceof BotApiError && error.code === 'CANCELLATION_PREVIEW_STALE') {
      return { kind: 'EPHEMERAL_MESSAGE', message: botCopy.orders.cancellationChanged(error.requestId) };
    }
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '取消订单失败') };
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
    if (isApiError(error, 'ACCOUNT_NOT_BOUND') || isApiError(error, 'AUTH_REQUIRED')) {
      return { kind: 'EPHEMERAL_MESSAGE', message: BOT_COPY.orders.accountUnavailable };
    }
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '创建订单失败') };
  }
}

export async function handleOrderSelectSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  field: 'catalog' | 'duration' | 'preferred-players';
  value: string | string[];
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  const [order, catalog] = await Promise.all([input.api.getOrder(input.orderId, input.actor), input.api.listServices(input.actor)]);
  if(input.field==='preferred-players'){
    const updated=await input.api.updateOrder(input.orderId,{expectedVersion:input.expectedVersion,preferredPlayerDiscordUserIds:Array.isArray(input.value)?input.value:[input.value]},input.actor,input.idempotencyKey);
    if(input.api.listOrderRequirements){const page=await input.api.listOrderRequirements(input.orderId,input.actor,undefined,10);return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildMultiProjectOrderPanelMessage(updated,page,catalog.items)};}
    return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildOrderPanelMessage(updated,catalog.items)};
  }
  const selected = input.field === 'catalog'
    ? catalog.items.find((item) => item.id === input.value)
    : catalog.items.find((item) => item.id === order.serviceCatalogId);
  if (!selected) throw new Error('The selected service catalog is unavailable.');
  const payload: Record<string, unknown> = {
    expectedVersion: input.expectedVersion,
    serviceCatalogId: selected.id,
    unitCount: input.field === 'duration' ? Number.parseInt(String(input.value), 10) : Math.max(order.unitCount ?? 0, selected.minimumUnits)
  };
  if (order.preferredPlayerDiscordUserIds?.length) {
    payload.preferredPlayerDiscordUserIds = order.preferredPlayerDiscordUserIds;
  }
  const updated = await input.api.updateOrder(input.orderId, payload, input.actor, input.idempotencyKey);
  return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildOrderPanelMessage(updated, catalog.items) };
}

export async function handleOrderRequirementSelectSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  action: 'add' | 'edit' | 'project' | 'units' | 'players';
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
  let selectedRequirementId = input.action === 'edit' ? input.value : input.requirementId;
  let changedRequirement: OrderRequirementMutationSummary | null = null;
  if (input.action === 'add') {
    const service = catalog.items.find((item) => item.id === input.value);
    if (!service) throw new Error('The selected service catalog is unavailable.');
    const created = await requirementApi.add(input.orderId, {
      expectedOrderVersion: input.expectedVersion,
      serviceCatalogVersionId: service.id,
      unitCount: service.minimumUnits,
      requestedPlayerCount: 1
    }, input.actor, input.idempotencyKey);
    selectedRequirementId = created.requirement.id;
  } else if (input.action === 'project' || input.action === 'units' || input.action === 'players') {
    const requirement = page.items.find((item) => item.id === input.requirementId && item.status === 'ACTIVE');
    const requirementVersion=requirement?.version??input.expectedRequirementVersion;
    if (!input.requirementId||!requirementVersion) throw new Error('The selected order requirement is unavailable.');
    const quantity = input.action==='project'?null:Number.parseInt(input.value, 10);
    if (input.action!=='project'&&(!Number.isSafeInteger(quantity) || Number(quantity) < 1)) throw new Error('The selected quantity is invalid.');
    const changed=await requirementApi.update(input.orderId, input.requirementId, {
      expectedOrderVersion: input.expectedVersion,
      expectedRequirementVersion: requirementVersion,
      action: input.action==='project'?'CHANGE_PROJECT':'CHANGE_QUANTITY',
      serviceCatalogVersionId:input.action==='project'?input.value:null,
      unitCount: input.action === 'units' ? Number(quantity) : null,
      requestedPlayerCount: input.action === 'players' ? Number(quantity) : null
    }, input.actor, input.idempotencyKey);
    changedRequirement=changed;
  }
  const [refreshedOrder, refreshedPage] = await Promise.all([
    input.api.getOrder(input.orderId, input.actor),
    requirementApi.list(input.orderId, input.actor, input.cursor, 10)
  ]);
  if(changedRequirement&&selectedRequirementId&&!refreshedPage.items.some((item)=>item.id===selectedRequirementId)){
    refreshedPage.items=[changedRequirement.requirement];refreshedPage.orderVersion=changedRequirement.orderVersion;refreshedPage.derivedTotalMinor=changedRequirement.derivedTotalMinor;refreshedPage.nextCursor=null;
  }
  return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildMultiProjectOrderPanelMessage(refreshedOrder, refreshedPage, catalog.items, selectedRequirementId, input.cursor) };
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
  const requirementApi=requireOrderRequirementApi(input.api);
  if(input.action==='remove'){
    if(!input.requirementId||!input.expectedRequirementVersion)throw new Error('Requirement identity and version are required.');
    await requirementApi.update(input.orderId,input.requirementId,{expectedOrderVersion:input.expectedVersion,expectedRequirementVersion:input.expectedRequirementVersion,action:'REMOVE'},input.actor,input.idempotencyKey);
  }
  const cursor=input.action==='page'?input.cursor:undefined;
  const [order,page,services]=await Promise.all([input.api.getOrder(input.orderId,input.actor),requirementApi.list(input.orderId,input.actor,cursor,10),input.api.listServices(input.actor)]);
  return {kind:'EDIT_ORIGINAL_MESSAGE',message:buildMultiProjectOrderPanelMessage(order,page,services.items,undefined,cursor)};
}

export async function handleOrderNotesSubmit(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  expectedVersion: number;
  notes: string;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  try {
    const updated = await input.api.updateOrder(
      input.orderId,
      { expectedVersion: input.expectedVersion, notes: input.notes },
      input.actor,
      input.idempotencyKey
    );
    if(input.api.listOrderRequirements){const [page,services]=await Promise.all([input.api.listOrderRequirements(input.orderId,input.actor,undefined,10),input.api.listServices(input.actor)]);return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildMultiProjectOrderPanelMessage(updated,page,services.items)};}
    return { kind: 'EDIT_ORIGINAL_MESSAGE', message: buildOrderPanelMessage(updated) };
  } catch (error) {
    if (isApiError(error, 'CONFLICT')) {
      const refreshed = await input.api.getOrder(input.orderId, input.actor);
      return {
        kind: 'EDIT_ORIGINAL_MESSAGE',
        message: buildOrderPanelMessage(refreshed),
        notice: botCopy.orders.conflictRefreshed(requestId(error))
      };
    }
    return { kind: 'EPHEMERAL_MESSAGE', message: formatApiError(error, '保存备注失败') };
  }
}

export async function handleRequirementNoteSubmit(input:{api:BotApiClient;actor:BotActorContext;orderId:string;requirementId:string;expectedVersion:number;expectedRequirementVersion:number;customerNote:string;idempotencyKey:string}):Promise<BotFlowResult>{const requirementApi=requireOrderRequirementApi(input.api);await requirementApi.update(input.orderId,input.requirementId,{expectedOrderVersion:input.expectedVersion,expectedRequirementVersion:input.expectedRequirementVersion,action:'CHANGE_NOTE',customerNote:input.customerNote||null},input.actor,input.idempotencyKey);const [order,page,services]=await Promise.all([input.api.getOrder(input.orderId,input.actor),requirementApi.list(input.orderId,input.actor,undefined,10),input.api.listServices(input.actor)]);return{kind:'EDIT_ORIGINAL_MESSAGE',message:buildMultiProjectOrderPanelMessage(order,page,services.items,input.requirementId)};}

export function parseServiceCenterCustomId(customId: string): ServiceCenterRoute {
  const giftOpen = /^bc:gift:open:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (giftOpen) return { area: 'gift', action: 'open', orderId: giftOpen[1]!, expectedVersion: Number(giftOpen[2]) };
  const giftAction = /^bc:gift:(select|refresh|confirm|back):(g1_[A-Za-z0-9_-]{80})$/u.exec(customId);
  if (giftAction) return { area: 'gift', action: giftAction[1] as 'select'|'refresh'|'confirm'|'back', token: giftAction[2]! };
  const giftRecipients = /^bc:grs:([0-9a-f-]{36}):([0-9]+):v([1-9][0-9]*):([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftRecipients) return { area: 'gift-recipient-select', orderId: giftRecipients[1]!, page: Number(giftRecipients[2]), expectedVersion: Number(giftRecipients[3]), selection: giftRecipients[4]! };
  const giftCatalog = /^bc:gc:([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftCatalog) return { area: 'gift-catalog-select', selection: giftCatalog[1]! };
  const giftRecipientPage = /^bc:grp:([0-9a-f-]{36}):([0-9]+):v([1-9][0-9]*):([A-Za-z0-9_-]{1,40})$/u.exec(customId);
  if (giftRecipientPage) return { area: 'gift-recipient-page', orderId: giftRecipientPage[1]!, page: Number(giftRecipientPage[2]), expectedVersion: Number(giftRecipientPage[3]), selection: giftRecipientPage[4]! };
  if (customId === 'bc:profile:open' || customId === 'bc:profile:refresh') {
    return { area: 'profile', action: customId.endsWith('refresh') ? 'refresh' : 'open' };
  }
  const profilePage = /^bc:profile:(orders|consumptions):(first|end|c1_[A-Za-z0-9_-]{20,70})$/u.exec(customId);
  if (profilePage) {
    return { area: 'profile', action: profilePage[1] as 'orders' | 'consumptions',
      cursor: profilePage[2] === 'first' || profilePage[2] === 'end' ? undefined : profilePage[2] };
  }
  const reportList = /^bc:reports:list:(first|end|c1_[A-Za-z0-9_-]{20,70})$/u.exec(customId);
  if (reportList) {
    return { area: 'reports', action: 'list', cursor: reportList[1] === 'first' || reportList[1] === 'end' ? undefined : reportList[1] };
  }
  const reportDetail = /^bc:reports:detail:([0-9a-f-]{36})$/u.exec(customId);
  if (reportDetail) return { area: 'reports', action: 'detail', reportId: reportDetail[1] };
  if (customId === 'bc:entry:create-order') {
    return { area: 'entry', action: 'create-order' };
  }
  if (customId === 'bc:entry:service-center') {
    return { area: 'entry', action: 'service-center' };
  }
  if (customId === 'bc:entry:player-workbench') {
    return { area: 'entry', action: 'player-workbench' };
  }

  const availabilityAction = /^bc:player:availability:AVAILABLE:v([1-9][0-9]*)$/u.exec(customId);
  if (availabilityAction) {
    return { area: 'player-action', action: 'set-available', expectedVersion: Number.parseInt(availabilityAction[1], 10) };
  }

  const cancellationAction = /^bc:cancel:([0-9a-f-]{36}):([0-9a-f-]{36}):confirm:v([1-9][0-9]*)$/u.exec(customId);
  if (cancellationAction) {
    return {
      area: 'cancellation-action',
      action: 'confirm',
      orderId: cancellationAction[1],
      previewId: cancellationAction[2],
      expectedVersion: Number.parseInt(cancellationAction[3], 10)
    };
  }

  const orderSelect = /^bc:select:order:([0-9a-f-]{36}):(catalog|duration|preferred-players):v([1-9][0-9]*)$/u.exec(customId);
  if (orderSelect) {
    return {
      area: 'order-select',
      orderId: orderSelect[1],
      field: orderSelect[2] as 'catalog' | 'duration' | 'preferred-players',
      expectedVersion: Number.parseInt(orderSelect[3], 10)
    };
  }

  const requirementAdd = /^bc:req:([0-9a-f-]{36}):add:v([1-9][0-9]*)$/u.exec(customId);
  if (requirementAdd) return {area:'order-requirement-select',orderId:requirementAdd[1]!,action:'add',expectedVersion:Number(requirementAdd[2])};
  const requirementEdit = /^bc:req:([0-9a-f-]{36}):edit:(first|[A-Za-z0-9_-]{1,40}):v([1-9][0-9]*)$/u.exec(customId);
  if (requirementEdit) return {area:'order-requirement-select',orderId:requirementEdit[1]!,action:'edit',cursor:requirementEdit[2]==='first'?undefined:requirementEdit[2],expectedVersion:Number(requirementEdit[3])};
  const requirementQuantity = /^bc:req:([0-9a-f-]{36}):([0-9a-f-]{36}):(project|units|players):v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);
  if (requirementQuantity) {
    return { area: 'order-requirement-select', orderId: requirementQuantity[1]!, requirementId: requirementQuantity[2]!, action: requirementQuantity[3] as 'project'|'units'|'players', expectedVersion: Number(requirementQuantity[4]),expectedRequirementVersion:Number(requirementQuantity[5]) };
  }
  const requirementRemove=/^bc:req:([0-9a-f-]{36}):([0-9a-f-]{36}):remove:v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);
  if(requirementRemove)return{area:'order-requirement-action',orderId:requirementRemove[1]!,requirementId:requirementRemove[2]!,action:'remove',expectedVersion:Number(requirementRemove[3]),expectedRequirementVersion:Number(requirementRemove[4])};
  const requirementBack=/^bc:req:([0-9a-f-]{36}):back:v([1-9][0-9]*)$/u.exec(customId);
  if(requirementBack)return{area:'order-requirement-action',orderId:requirementBack[1]!,action:'back',expectedVersion:Number(requirementBack[2])};
  const requirementPage=/^bc:req:([0-9a-f-]{36}):page:(first|[A-Za-z0-9_-]{1,40}):v([1-9][0-9]*)$/u.exec(customId);
  if(requirementPage)return{area:'order-requirement-action',orderId:requirementPage[1]!,action:'page',cursor:requirementPage[2]==='first'?undefined:requirementPage[2],expectedVersion:Number(requirementPage[3])};

  const packageSelect=/^bc:package:([0-9a-f-]{36}):select:v([1-9][0-9]*)$/u.exec(customId);if(packageSelect)return{area:'service-package-select',orderId:packageSelect[1]!,expectedVersion:Number(packageSelect[2])};
  const packageApply=/^bc:package:([0-9a-f-]{36}):([0-9a-f-]{36}):apply:v([1-9][0-9]*)$/u.exec(customId);if(packageApply)return{area:'service-package-action',orderId:packageApply[1]!,servicePackageVersionId:packageApply[2]!,action:'apply',expectedVersion:Number(packageApply[3])};
  const packageAction=/^bc:package:([0-9a-f-]{36}):(open|back):v([1-9][0-9]*)$/u.exec(customId);if(packageAction)return{area:'service-package-action',orderId:packageAction[1]!,action:packageAction[2] as 'open'|'back',expectedVersion:Number(packageAction[3])};

  const notesModal = /^bc:modal:order-notes:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (notesModal) {
    return {
      area: 'order-notes-modal',
      orderId: notesModal[1],
      expectedVersion: Number.parseInt(notesModal[2], 10)
    };
  }
  const notesOpen=/^bc:modal-open:order-notes:([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if(notesOpen)return{area:'order-notes-open',orderId:notesOpen[1]!,expectedVersion:Number(notesOpen[2])};
  const requirementNoteModal=/^bc:rnm:([0-9a-f-]{36}):([0-9a-f-]{36}):v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);if(requirementNoteModal)return{area:'requirement-note-modal',orderId:requirementNoteModal[1]!,requirementId:requirementNoteModal[2]!,expectedVersion:Number(requirementNoteModal[3]),expectedRequirementVersion:Number(requirementNoteModal[4])};
  const requirementNoteOpen=/^bc:rno:([0-9a-f-]{36}):([0-9a-f-]{36}):v([1-9][0-9]*):r([1-9][0-9]*)$/u.exec(customId);if(requirementNoteOpen)return{area:'requirement-note-open',orderId:requirementNoteOpen[1]!,requirementId:requirementNoteOpen[2]!,expectedVersion:Number(requirementNoteOpen[3]),expectedRequirementVersion:Number(requirementNoteOpen[4])};

  const orderAction = /^bc:order:([0-9a-f-]{36}):(submit|submit-final|cancel):v([1-9][0-9]*)$/u.exec(customId);
  if (orderAction) {
    return {
      area: 'order-action',
      orderId: orderAction[1],
      action: orderAction[2] as 'submit' | 'submit-final' | 'cancel',
      expectedVersion: Number.parseInt(orderAction[3], 10)
    };
  }

  const serviceAction = /^bc:service:(ready|request-completion|confirm|support):([0-9a-f-]{36}):v([1-9][0-9]*)$/u.exec(customId);
  if (serviceAction) {
    return {
      area: 'service-action',
      orderId: serviceAction[2],
      action: serviceAction[1] as 'ready' | 'request-completion' | 'confirm' | 'support',
      expectedVersion: Number.parseInt(serviceAction[3], 10)
    };
  }

  return { area: 'unknown' };
}

export function buildDiscordIdempotencyKey(action: string, interactionId: string): string {
  return `discord:${action}:${interactionId}`.replaceAll(/[^A-Za-z0-9:_-]/gu, '_').slice(0, 200);
}

function select(
  customId: string,
  placeholder: string,
  options: Array<{ label: string; value: string }>,
  disabled = false
): ComponentSpec {
  return { type: 'STRING_SELECT', customId, placeholder, options, disabled };
}

function requirementOptions(requirements: OrderRequirementSummary[]): Array<{label:string;value:string}> {
  if (!requirements.length) return [{ label: '还没有项目', value: 'unavailable' }];
  return requirements.slice(0, 25).map((item, index) => ({ label: `${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName} · ${item.unitCount} 单位 × ${item.requestedPlayerCount} 位`.slice(0, 100), value: item.id }));
}

function integerOptions(min: number, max: number, current: number, label: (value:number)=>string): Array<{label:string;value:string}> {
  const values = new Set<number>();
  for (let value=min; value<=max; value+=1) values.add(value);
  values.add(current);
  return [...values].sort((a,b)=>a-b).slice(0,25).map((value)=>({label: `${label(value)}${value===current?' · 当前':''}`.slice(0,100),value:String(value)}));
}

function formatRequirementDuration(requirement: Pick<OrderRequirementSummary, 'unitCount'|'billingUnitMinutes'>): string {
  const minutes = requirement.unitCount * requirement.billingUnitMinutes;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function requireOrderRequirementApi(api: BotApiClient) {
  if (!api.listOrderRequirements || !api.addOrderRequirement || !api.updateOrderRequirement) throw new Error('Order requirement API is unavailable.');
  return { list: api.listOrderRequirements.bind(api), add: api.addOrderRequirement.bind(api), update: api.updateOrderRequirement.bind(api) };
}
function requirePackageApi(api:BotApiClient){if(!api.listServicePackages||!api.previewServicePackage||!api.applyServicePackage)throw new Error('Service package API is unavailable.');return{list:api.listServicePackages.bind(api),preview:api.previewServicePackage.bind(api),apply:api.applyServicePackage.bind(api)};}

function orderMenuControls(orderId: string, version: number): ComponentSpec[] {
  return [
    { type: 'BUTTON', style: 'DANGER', customId: `bc:order:${orderId}:cancel:v${version}`, label: '取消订单' },
    { type: 'BUTTON', style: 'SECONDARY', customId: `bc:service:support:${orderId}:v${version}`, label: '我要申诉' }
  ];
}

function serviceOptions(order: OrderSummary, services: PublicServiceSummary[]): Array<{ label: string; value: string }> {
  const options = services.slice(0, 25).map((item) => ({
    label: `${item.gameDisplayName ?? item.game} · ${item.serviceDisplayName ?? item.service}${item.region ? ` · ${item.regionDisplayName ?? item.region}` : ''}`.slice(0, 100), value: item.id
  }));
  if (options.length) return options;
  if (order.serviceCatalogId) return [{ label: `${order.game ?? '陪玩'} · ${order.service ?? '服务'}`.slice(0, 100), value: order.serviceCatalogId }];
  return [{ label: '暂无可用陪玩项目', value: 'unavailable' }];
}

function isApiError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function requestId(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'requestId' in error) {
    const value = (error as { requestId?: unknown }).requestId;
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return 'unknown';
}

function formatApiError(error: unknown, fallback: string): string {
  const id = requestId(error);
  return `${fallback}。request_id: ${id}`;
}

function formatGame(value: string | null): string {
  const labels: Record<string, string> = {
    VALORANT: '无畏契约',
    LEAGUE_OF_LEGENDS: '英雄联盟'
  };
  return value ? labels[value] ?? value : '未选择游戏';
}

function formatService(value: string | null): string {
  const labels: Record<string, string> = {
    ENTERTAINMENT: '娱乐陪玩',
    RANKED: '上分陪玩'
  };
  return value ? labels[value] ?? value : '未选择服务';
}

function formatRegion(value: string | null): string {
  const labels: Record<string, string> = {
    NA: '北美',
    CN: '国服'
  };
  return value ? labels[value] ?? value : '无指定区服';
}

function formatDuration(order: OrderSummary): string {
  if (!order.billingUnitMinutes || !order.unitCount) {
    return '未选择时长';
  }
  const totalMinutes = order.billingUnitMinutes * order.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

function formatEstimateDuration(estimate: OrderEstimateSummary): string {
  const totalMinutes = estimate.billingUnitMinutes * estimate.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

function formatPlatformMoney(amountMinor: number, currency: string): string {
  if (currency === 'CAT') return formatCustomerWalletAmount(amountMinor, parseWalletDisplayConfig(process.env));
  const prefix = `${currency}\u00a0`;
  return `${prefix}${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)}`;
}

function formatCustomerMoney(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Customer wallet display requires canonical CAT subunits.');
  return formatCustomerWalletAmount(amountMinor, parseWalletDisplayConfig(process.env));
}

function missingConfirmationFields(order: OrderSummary): string[] {
  const missing: string[] = [];
  if (!order.game) {
    missing.push('游戏');
  }
  if (!order.service) {
    missing.push('服务');
  }
  if (!order.billingUnitMinutes || !order.unitCount) {
    missing.push('时长');
  }
  return missing;
}

function confirmationBlockedReason(input: {
  missing: string[];
  deficitMinor: number;
  estimateCurrency: string;
  currencyMismatch: boolean;
}): string {
  if (input.missing.length > 0) {
    return `信息不完整：请补齐${input.missing.join('、')}后再确认。`;
  }
  if (input.currencyMismatch) {
    return '币种不一致：请联系客服处理后再确认。';
  }
  return `余额不足：还差 ${formatCustomerMoney(input.deficitMinor, input.estimateCurrency)}，请联系客服并提交付款 receipt，到账后刷新确认。`;
}

function buildIncompleteConfirmationMessage(order: OrderSummary): MessageSpec {
  const missing = missingConfirmationFields(order);
  return {
    title: `订单 #${order.publicId} · 最后确认`,
    body: [
      `游戏：${formatGame(order.game)}`,
      `服务：${formatService(order.service)}`,
      `区服：${formatRegion(order.region)}`,
      `时长：${formatDuration(order)}`,
      order.notes ? `备注：${order.notes}` : '备注：未填写',
      `信息不完整：请补齐${missing.join('、')}后再确认。`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${order.id}:submit-final:v${order.version}`,
            label: '确认提交并预留',
            disabled: true
          },
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:order:${order.id}:refresh:v${order.version}`, label: '返回修改' }
        ]
      }
    ]
  };
}
