import { randomUUID } from 'node:crypto';
import type { DiscordBotActorContext } from './actor-context.js';

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

export interface OrderAvailableActionSummary {
  key: string;
  role: 'CUSTOMER' | 'PLAYER' | 'STAFF';
  enabled: boolean;
  risk: 'PRIMARY' | 'SECONDARY' | 'DANGER';
  reasonCode: string | null;
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
  availableActions: OrderAvailableActionSummary[];
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
    selectionPoolId: string;
    applicationStatus: string | null;
    nextAction: 'APPLY' | 'WITHDRAW' | 'WAIT';
    order: PlayerWorkbenchOrderSummary;
  }>;
  earningsSummary: {
    pendingMinor: number;
    confirmedMinor: number;
    paidMinor: number;
    currency: string;
    calculatedAt: string;
  };
  availableActions: OrderAvailableActionSummary[];
  nextActions: Array<
    | 'REVIEW_SELECTION_POOL'
    | 'APPLY_SELECTION'
    | 'WITHDRAW_APPLICATION'
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

export interface OrderLifecyclePanelSummary {
  orderId: string;
  publicId: string;
  status: 'ACCEPTED' | 'IN_SERVICE' | 'PENDING_CONFIRMATION' | 'COMPLETED' | 'CANCELLED' | 'EXCEPTION';
  version: number;
  actorRole: 'CUSTOMER' | 'PLAYER';
  availableActions: OrderAvailableActionSummary[];
  enabledFeatures?: Array<'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6'>;
  readiness: {
    participants: Array<{
      participantId: string;
      playerId: string;
      displayName: string;
      readiness: 'READY' | 'NOT_READY';
    }>;
    allActivePlayersReady: boolean;
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

export type ExperienceReviewTargetType = 'ORDER' | 'PLAYER' | 'SUPPORT';

export interface OrderExperienceReviewComment {
  id: string;
  comment: string;
  createdAt: string;
}

export interface OrderExperienceReview {
  id: string;
  orderId: string;
  targetKey: string;
  targetType: ExperienceReviewTargetType;
  orderParticipantId: string | null;
  attributedStaffId: string | null;
  score: number;
  comment: OrderExperienceReviewComment | null;
  createdAt: string;
}

export interface OrderExperienceReviewTarget {
  targetKey: string;
  targetType: ExperienceReviewTargetType;
  displayName: string;
  review: OrderExperienceReview | null;
}

export interface OrderReviewPublication {
  id: string;
  orderId: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  snapshot: {
    orderPublicId: string;
    serviceDisplayName: string;
    completedAt: string;
    targets: Array<{ targetType: ExperienceReviewTargetType; displayName: string; score: 5 }>;
  };
  consentedAt: string;
  publishedAt: string | null;
}

export interface OrderExperienceReviewCenter {
  orderId: string;
  orderPublicId: string;
  expiresAt: string;
  targets: OrderExperienceReviewTarget[];
  hasPublishableFiveStar: boolean;
  publication: OrderReviewPublication | null;
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
export interface SelectionReactionObservationResult {
  changed: boolean;
  state: 'APPLIED' | 'WITHDRAWN';
  poolId: string;
  orderRequirementId: string;
  application: SelectionApplicationSummary | null;
}
export interface SelectionReactionCard {
  guildId: string;
  channelId: string;
  messageId: string;
  poolId: string;
  bindings: Array<{
    emoji: string;
    orderRequirementId: string;
    label: string;
    appliedDiscordUserIds: string[];
  }>;
}
