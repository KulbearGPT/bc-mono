import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AccountStore } from './accounts.js';
import { buildFundReservationDraft, type FundReservationDraft, type FundReservationMode } from './funding.js';
import type { OrderRecord, OrderStore } from './orders.js';
import type { OutboxJob } from './outbox.js';
import {
  registerSecureReadRoute,
  registerSecureWriteRoute,
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  type ActorContext,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';
import type { WalletFundingService, WalletBalance } from './wallet.js';
import { createEligibleReferralCommission } from './referrals.js';
import type { PolicyReader } from './operations.js';
import { resolveBotConfigBoolean, resolveBotConfigString, type BotConfigStore } from './bot-config.js';
import { requiredLevelForAmount } from './authorization-policy.js';
import { decryptSecret, verifyTotp } from './mfa.js';
import {
  activeReservationStatuses,
  reservationRemainingMinorSql,
  reservationSettlementLateralSql,
  sumActiveReservationRemainders
} from './reservation-balance.js';

type GiftApprovalThresholds = { l2LimitMinor: number; l4FromMinor: number };

export type GiftCatalogStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface GiftCatalogRecord {
  id: string;
  itemId: string;
  code: string;
  version: number;
  status: GiftCatalogStatus;
  name: string;
  priceMinor: number;
  currency: string;
  broadcastTemplate: string;
}

export interface GiftRequestRecord {
  id: string;
  publicId: string;
  guildId?: string;
  origin?: 'ORDER' | 'STANDALONE';
  senderVisibility?: 'PUBLIC' | 'ANONYMOUS';
  initiatorMode?: 'CUSTOMER_SELF' | 'STAFF_ASSISTED';
  assistedByStaffId?: string | null;
  giftAssistChallengeId?: string | null;
  orderId: string | null;
  participantId?: string | null;
  giftCatalogVersionId: string;
  senderId: string;
  receiverId: string;
  status: 'PENDING_REVIEW' | 'PENDING_APPROVAL' | 'APPROVED' | 'CAPTURED' | 'ANNOUNCED' | 'REJECTED' | 'EXPIRED' | 'WITHDRAWN' | 'FAILED' | 'REVERSED';
  version: number;
  giftCodeSnapshot: string;
  giftNameSnapshot: string;
  priceMinor: number;
  currency: string;
  broadcastTemplateSnapshot: string;
  verifiedByStaffId?: string | null;
  verifiedAt?: string | null;
  verificationNote?: string | null;
  verificationPayloadHash?: string | null;
  executionCredentialExpiresAt?: string | null;
  approvedByStaffId?: string | null;
  approvedAt?: string | null;
  capturedAt?: string | null;
  announcedAt?: string | null;
  broadcastChannelId?: string | null;
  broadcastMessageId?: string | null;
  rejectedReason?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GiftStaffTaskRecord {
  id: string;
  publicId: string;
  type: 'GIFT_REVIEW';
  reasonCode: 'GIFT_REQUESTED';
  status: 'OPEN' | 'CLAIMED' | 'VERIFIED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RESOLVED' | 'CANCELLED';
  version: number;
  orderId: string | null;
  giftRequestId: string;
  claimedBy?: string | null;
  voiceChannelId: string | null;
  contextSnapshot: {
    source?: 'ORDER' | 'STANDALONE';
    initiatorMode?: 'CUSTOMER_SELF' | 'STAFF_ASSISTED';
    assistedByStaffId?: string | null;
    giftAssistChallengeId?: string | null;
    authorizationChannelId?: string | null;
    authorizationMessageId?: string | null;
    authorizationReason?: string | null;
    orderId: string | null;
    orderPublicId: string | null;
    channelId: string | null;
    voiceChannelId: string | null;
    senderId: string;
    receiverId: string;
    giftCode: string;
    giftName: string;
    priceMinor: number;
    currency: string;
    reservationId: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface GiftReservationRecord extends FundReservationDraft {
  sourceType: 'GIFT';
  orderId: null;
  giftRequestId: string;
}

export interface GiftStore {
  listActiveCatalog(): Promise<GiftCatalogRecord[]> | GiftCatalogRecord[];
  findCatalogVersion(id: string): Promise<GiftCatalogRecord | null> | GiftCatalogRecord | null;
  listStandaloneRecipients(input: { guildId: string }): Promise<StandaloneGiftRecipientRecord[]> | StandaloneGiftRecipientRecord[];
  findStandaloneRecipient(input: { guildId: string; playerProfileId: string }): Promise<StandaloneGiftRecipientRecord | null> | StandaloneGiftRecipientRecord | null;
  findStaffGiftAssistChallenge(input: { id: string; actorStaffId: string; guildId: string; permissionsVersion: number; now: Date }): Promise<StaffGiftAssistChallengeRecord | null> | StaffGiftAssistChallengeRecord | null;
  commitCreateStaffGiftAssistChallenge(input: { challenge: StaffGiftAssistChallengeRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> | void;
  findActiveOrderParticipants(input: { orderId: string; participantIds: string[] }): Promise<GiftRecipientRecord[]> | GiftRecipientRecord[];
  commitCreate(input: {
    request: GiftRequestRecord;
    reservation: GiftReservationRecord;
    staffTask: GiftStaffTaskRecord;
    ledgerBalanceMinor: number;
    expectedOrderVersion?: number;
    expectedGuildId?: string;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    staffAssist?: StaffGiftAssistFinalization;
  }): Promise<void> | void;
  commitCreateBatch(input: {
    items: Array<{ request: GiftRequestRecord; reservation: GiftReservationRecord; staffTask: GiftStaffTaskRecord }>;
    ledgerBalanceMinor: number;
    expectedOrderVersion?: number;
    standalonePlayerProfileId?: string;
    expectedGuildId?: string;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    staffAssist?: StaffGiftAssistFinalization;
  }): Promise<void> | void;
  verifyTask(input: { taskId: string; expectedVersion: number; actorStaffId: string; verificationMethod: string; notes: string; now: Date; auditRecord?: AuditRecord; auditSink?: AuditSink }): Promise<GiftReviewResult> | GiftReviewResult;
  authorizeGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel; reason: string; now: Date; approvalThresholds?: GiftApprovalThresholds;approvalDecision?:GiftApprovalDecisionExecution }): Promise<GiftAuthorizationResult> | GiftAuthorizationResult;
  commitApprovalDecision(input: GiftApprovalCommit): Promise<GiftApprovalCommitResult> | GiftApprovalCommitResult;
  getCaptureContext(giftRequestId: string): Promise<GiftCaptureContext> | GiftCaptureContext;
  findCapture(giftRequestId: string): Promise<GiftCaptureResult | null> | GiftCaptureResult | null;
  commitCapture(input: GiftCaptureCommit): Promise<GiftCaptureResult> | GiftCaptureResult;
  markAnnounced(input: { giftRequestId: string; channelId: string; messageId: string; now: Date }): Promise<void> | void;
  rejectGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; reason: string; now: Date }): Promise<{ status: 'REJECTED'; reason: string }> | { status: 'REJECTED'; reason: string };
  getTerminationContext(giftRequestId: string): Promise<{ request: GiftRequestRecord; reservation: GiftReservationRecord }> | { request: GiftRequestRecord; reservation: GiftReservationRecord };
  commitTermination(input: GiftTerminationCommit): Promise<GiftTerminationResult> | GiftTerminationResult;
}

export interface GiftRecipientRecord {
  participantId: string;
  playerId: string;
  displayName: string;
}

export interface StandaloneGiftRecipientRecord {
  playerProfileId: string;
  userId: string;
  displayName: string;
  guildId: string;
  discordUserId: string;
  reviewStatus: 'ACTIVE' | 'PENDING_REVIEW' | 'REJECTED' | 'PAUSED' | 'SUSPENDED';
  userStatus: 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'DISABLED';
}

export interface StaffGiftAssistChallengeRecord {
  id: string;
  guildId: string;
  staffAccountId: string;
  staffDiscordUserId: string;
  permissionsVersion: number;
  customerUserId: string;
  customerDiscordUserId: string;
  customerDisplayName: string;
  authorizationChannelId: string;
  authorizationMessageId: string;
  authorizationReason: string | null;
  failedAttempts: number;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StaffGiftAssistFinalization {
  challengeId: string;
  actorStaffId: string;
  actorDiscordUserId: string;
  permissionsVersion: number;
  authorizationReason: string;
  totpCode: string;
}

export interface GiftTerminationCommit {
  giftRequestId: string; expectedGiftVersion: number; expectedReservationVersion: number;
  terminalStatus: 'REJECTED' | 'WITHDRAWN' | 'EXPIRED'; reason: string;
  actorUserId?: string; actorStaffId?: string; now: Date;
  auditRecord?: AuditRecord; auditSink?: AuditSink;
  approvalDecision?: GiftApprovalDecisionExecution;
}

export interface GiftApprovalDecisionExecution {
  approvalRequestId:string;expectedApprovalVersion:number;payloadHash:string;targetVersion:number;
  guildId:string;actorStaffId:string;actorLevel:StaffLevel;reason:string;now:Date;
}

export interface GiftTerminationResult {
  giftRequestId: string; status: 'REJECTED' | 'WITHDRAWN' | 'EXPIRED'; reason: string;
  reservation: { reservationId: string; status: 'RELEASED' | 'EXPIRED'; amountMinor: number; releasedMinor: number; currency: string; version: number };
}

export interface GiftCaptureContext {
  request: GiftRequestRecord;
  reservation: GiftReservationRecord;
  senderDisplayName: string;
  receiverDisplayName: string;
  guildId:string|null;
}

export interface GiftCaptureResult {
  status: 'CAPTURED';
  giftRequestId: string;
  reservation: {
    reservationId: string;
    amountMinor: number;
    capturedMinor: number;
    releasedMinor: number;
    currency: string;
    status: 'CAPTURED';
    version: number;
    expiresAt: string;
  };
  chargeOutcome: {
    kind: 'DEBIT';
    status: 'SUCCEEDED';
    amountMinor: number;
    currency: string;
    providerReferenceDisplay: string;
    observedAt: string;
  };
  consumptionId: string;
  announcementJobId: string;
}

export interface GiftCaptureCommit {
  giftRequestId: string;
  expectedGiftVersion: number;
  expectedReservationVersion: number;
  provider: string;
  providerTransactionRef: string;
  providerIdempotencyKey: string;
  actorStaffId: string;
  broadcastChannelId: string;
  senderDisplayName: string;
  receiverDisplayName: string;
  now: Date;
}

export interface GiftApprovalCommit {
  giftRequestId: string;
  expectedVersion: number;
  actorStaffId: string;
  actorLevel: StaffLevel;
  reason: string;
  approvalThresholds?: GiftApprovalThresholds;
  broadcastChannelId: string;
  now: Date;
  auditRecord: AuditRecord;
  auditSink: AuditSink;
  approvalDecision?: GiftApprovalDecisionExecution;
}

export interface GiftApprovalCommitResult {
  data: GiftAuthorizationResult | GiftCaptureResult;
  statusCode: 200 | 202;
}

export interface GiftReviewResult {
  status: 'VERIFIED';
  giftRequestId: string;
  taskId: string;
  executionCredential: { payloadHash: string; expiresAt: string };
}

export interface GiftApprovalRecord {
  id: string;
  publicId: string;
  action: 'GIFT_APPROVE';
  targetId: string;
  targetVersion: number;
  payloadSnapshot: Record<string, unknown>;
  payloadHash: string;
  amountMinor: number;
  currency: string;
  requestedByStaffId: string;
  requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
  reason: string;
  expiresAt: string;
  createdAt: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
}

export type GiftAuthorizationResult =
  | { status: 'APPROVED'; action: 'READY_FOR_CAPTURE'; requiredLevel: StaffLevel; approvalRequestId: string | null; executionCredential: { payloadHash: string; expiresAt: string } }
  | { code: 'APPROVAL_PENDING'; actionExecuted: false; requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER'; approvalRequestId: string; expiresAt: string };

export class GiftError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'VALIDATION_ERROR'
    | 'CONFLICT'
    | 'GIFT_WINDOW_CLOSED'
    | 'GIFT_NOT_AVAILABLE'
    | 'GIFT_CATALOG_CHANGED'
    | 'EXECUTION_CREDENTIAL_STALE'
    | 'MFA_REQUIRED'
    | 'MFA_INVALID'
    | 'INSUFFICIENT_AVAILABLE_BALANCE';

  constructor(code: GiftError['code'], message: string, readonly details: Array<{ field: string; reason: string }> = []) {
    super(message);
    this.name = 'GiftError';
    this.code = code;
  }
}

export class InMemoryGiftStore implements GiftStore {
  readonly catalog: GiftCatalogRecord[];
  readonly requests: GiftRequestRecord[];
  readonly reservations: GiftReservationRecord[];
  readonly staffTasks: GiftStaffTaskRecord[];
  readonly captures: GiftCaptureResult[] = [];
  readonly consumptions: Array<{ id: string; giftRequestId: string; amountMinor: number; currency: string }> = [];
  readonly broadcasts: OutboxJob[] = [];
  readonly expiryJobs: OutboxJob[] = [];
  readonly approvals: GiftApprovalRecord[] = [];
  readonly staffGiftAssistChallenges: StaffGiftAssistChallengeRecord[];
  private readonly displayNames: Record<string, string>;
  private readonly guildIdsByOrder:Record<string,string>;
  private readonly orderParticipants: GiftRecipientRecord[];
  private readonly standaloneRecipients: StandaloneGiftRecipientRecord[];
  private readonly staffTotpCodes: Record<string, string>;

  constructor(input: {
    catalog?: GiftCatalogRecord[];
    requests?: GiftRequestRecord[];
    reservations?: GiftReservationRecord[];
    staffTasks?: GiftStaffTaskRecord[];
    displayNames?: Record<string, string>;
    guildIdsByOrder?:Record<string,string>;
    orderParticipants?: GiftRecipientRecord[];
    standaloneRecipients?: StandaloneGiftRecipientRecord[];
    staffGiftAssistChallenges?: StaffGiftAssistChallengeRecord[];
    staffTotpCodes?: Record<string, string>;
  } = {}) {
    this.catalog = clone(input.catalog ?? []);
    this.requests = clone(input.requests ?? []);
    this.reservations = clone(input.reservations ?? []);
    this.staffTasks = clone(input.staffTasks ?? []);
    this.displayNames = clone(input.displayNames ?? {});
    this.guildIdsByOrder=clone(input.guildIdsByOrder??{});
    this.orderParticipants=clone(input.orderParticipants??[]);
    this.standaloneRecipients=clone(input.standaloneRecipients??[]);
    this.staffGiftAssistChallenges=clone(input.staffGiftAssistChallenges??[]);
    this.staffTotpCodes=clone(input.staffTotpCodes??{});
  }

  listActiveCatalog(): GiftCatalogRecord[] {
    return clone(this.catalog.filter((item) => item.status === 'ACTIVE'));
  }

  findCatalogVersion(id: string): GiftCatalogRecord | null {
    const item = this.catalog.find((candidate) => candidate.id === id);
    return item ? clone(item) : null;
  }

  listStandaloneRecipients(input: { guildId: string }): StandaloneGiftRecipientRecord[] {
    return clone(this.standaloneRecipients.filter((recipient) => recipient.guildId === input.guildId
      && recipient.reviewStatus === 'ACTIVE' && recipient.userStatus === 'ACTIVE' && recipient.discordUserId.length > 0));
  }

  findStandaloneRecipient(input: { guildId: string; playerProfileId: string }): StandaloneGiftRecipientRecord | null {
    return this.listStandaloneRecipients({ guildId: input.guildId })
      .find((recipient) => recipient.playerProfileId === input.playerProfileId) ?? null;
  }

  findStaffGiftAssistChallenge(input: { id: string; actorStaffId: string; guildId: string; permissionsVersion: number; now: Date }): StaffGiftAssistChallengeRecord | null {
    const challenge = this.staffGiftAssistChallenges.find((candidate) => candidate.id === input.id);
    if (!challenge) return null;
    if (challenge.staffAccountId !== input.actorStaffId || challenge.guildId !== input.guildId
      || challenge.permissionsVersion !== input.permissionsVersion || challenge.consumedAt
      || Date.parse(challenge.expiresAt) <= input.now.getTime() || challenge.failedAttempts >= 5) {
      throw new GiftError('CONFLICT', 'Gift assist challenge changed, expired, or was already consumed.');
    }
    return clone(challenge);
  }

  async commitCreateStaffGiftAssistChallenge(input: { challenge: StaffGiftAssistChallengeRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    if (this.staffGiftAssistChallenges.some((candidate) => candidate.id === input.challenge.id)) return;
    this.staffGiftAssistChallenges.push(clone(input.challenge));
    try { await input.auditSink.append(input.auditRecord); }
    catch (error) { this.staffGiftAssistChallenges.pop(); throw error; }
  }

  findActiveOrderParticipants(input: { orderId: string; participantIds: string[] }): GiftRecipientRecord[] {
    const selected = new Set(input.participantIds);
    return clone(this.orderParticipants.filter((participant) => selected.size === 0 || selected.has(participant.participantId)));
  }

  async commitCreate(input: {
    request: GiftRequestRecord;
    reservation: GiftReservationRecord;
    staffTask: GiftStaffTaskRecord;
    ledgerBalanceMinor: number;
    expectedOrderVersion?: number;
    expectedGuildId?: string;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    staffAssist?: StaffGiftAssistFinalization;
  }): Promise<void> {
    return this.commitCreateBatch({ ...input, items: [{ request: input.request, reservation: input.reservation, staffTask: input.staffTask }] });
  }

  async commitCreateBatch(input: {
    items: Array<{ request: GiftRequestRecord; reservation: GiftReservationRecord; staffTask: GiftStaffTaskRecord }>;
    ledgerBalanceMinor: number;
    expectedOrderVersion?: number;
    standalonePlayerProfileId?: string;
    expectedGuildId?: string;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    staffAssist?: StaffGiftAssistFinalization;
  }): Promise<void> {
    const first = input.items[0];
    if (!first) throw new GiftError('VALIDATION_ERROR', 'At least one gift recipient is required.');
    if (input.items.every((item) => this.requests.some((request) => request.id === item.request.id))) return;
    const assistChallenge = input.staffAssist
      ? this.staffGiftAssistChallenges.find((candidate) => candidate.id === input.staffAssist!.challengeId)
      : undefined;
    if (input.staffAssist) {
      if (!assistChallenge || assistChallenge.staffAccountId !== input.staffAssist.actorStaffId
        || assistChallenge.staffDiscordUserId !== input.staffAssist.actorDiscordUserId
        || assistChallenge.permissionsVersion !== input.staffAssist.permissionsVersion
        || assistChallenge.guildId !== input.expectedGuildId || assistChallenge.customerUserId !== first.request.senderId
        || assistChallenge.consumedAt || Date.parse(assistChallenge.expiresAt) <= input.now.getTime()
        || assistChallenge.failedAttempts >= 5 || first.request.initiatorMode !== 'STAFF_ASSISTED'
        || first.request.assistedByStaffId !== input.staffAssist.actorStaffId
        || first.request.giftAssistChallengeId !== input.staffAssist.challengeId) {
        throw new GiftError('CONFLICT', 'Gift assist challenge changed, expired, or was already consumed.');
      }
      if (!this.staffTotpCodes[input.staffAssist.actorStaffId]) {
        throw new GiftError('MFA_REQUIRED', 'The current staff account must enroll TOTP before assisting a gift.');
      }
      if (this.staffTotpCodes[input.staffAssist.actorStaffId] !== input.staffAssist.totpCode) {
        assistChallenge.failedAttempts += 1;
        assistChallenge.updatedAt = input.now.toISOString();
        throw new GiftError('MFA_INVALID', 'The TOTP code is invalid.');
      }
    }
    const catalog = this.catalog.find((item) => item.id === first.request.giftCatalogVersionId);
    if (!catalog || catalog.status !== 'ACTIVE' || catalog.priceMinor !== first.request.priceMinor || catalog.currency !== first.request.currency) {
      throw new GiftError('GIFT_CATALOG_CHANGED', 'Gift catalog changed; check affordability and confirm again.');
    }
    const activeReservedMinor = sumActiveReservationRemainders(this.reservations, [], {
      userId: first.request.senderId,
      currency: first.request.currency
    });
    const total = first.request.priceMinor * input.items.length;
    if (input.ledgerBalanceMinor - activeReservedMinor < total) {
      throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
    }
    if ((first.request.origin ?? 'ORDER') === 'STANDALONE') {
      const recipient = input.standalonePlayerProfileId
        ? this.findStandaloneRecipient({ guildId: input.expectedGuildId ?? '', playerProfileId: input.standalonePlayerProfileId })
        : null;
      if (input.items.length !== 1 || !recipient || recipient.userId !== first.request.receiverId) {
        throw new GiftError('NOT_FOUND', 'Eligible gift recipient was not found.');
      }
    }
    const lengths={requests:this.requests.length,reservations:this.reservations.length,staffTasks:this.staffTasks.length,expiryJobs:this.expiryJobs.length};
    const challengeSnapshot=assistChallenge ? clone(assistChallenge) : null;
    try {
      this.requests.push(...input.items.map((item) => clone(item.request)));
      this.reservations.push(...input.items.map((item) => clone(item.reservation)));
      this.staffTasks.push(...input.items.map((item) => clone(item.staffTask)));
      this.expiryJobs.push(...input.items.map((item) => buildGiftExpiryJob(item.request)));
      if (assistChallenge && input.staffAssist) {
        assistChallenge.authorizationReason = input.staffAssist.authorizationReason;
        assistChallenge.consumedAt = input.now.toISOString();
        assistChallenge.updatedAt = input.now.toISOString();
      }
      await input.auditSink.append(input.auditRecord);
    } catch(error) {
      this.requests.splice(lengths.requests);this.reservations.splice(lengths.reservations);
      this.staffTasks.splice(lengths.staffTasks);this.expiryJobs.splice(lengths.expiryJobs);
      if (assistChallenge && challengeSnapshot) Object.assign(assistChallenge, challengeSnapshot);
      throw error;
    }
  }

  refreshVerificationHash(giftRequestId: string, now: Date): void {
    const request = this.requireRequest(giftRequestId);
    request.verificationPayloadHash = giftPayloadHash({ ...request, version: request.verifiedAt ? request.version - 1 : request.version }, this.requireReservation(giftRequestId));
    request.executionCredentialExpiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  }

  async verifyTask(input: { taskId: string; expectedVersion: number; actorStaffId: string; verificationMethod: string; notes: string; now: Date; auditRecord?: AuditRecord; auditSink?: AuditSink }): Promise<GiftReviewResult> {
    const task = this.staffTasks.find((candidate) => candidate.id === input.taskId);
    if (!task || task.status !== 'CLAIMED' || task.version !== input.expectedVersion || task.claimedBy !== input.actorStaffId) {
      throw new GiftError('CONFLICT', 'Gift task is not claimed by the current staff member.');
    }
    const request = this.requireRequest(task.giftRequestId);
    const reservation = this.requireReservation(request.id);
    if (request.status !== 'PENDING_REVIEW' || reservation.status !== 'ACTIVE') throw new GiftError('CONFLICT', 'Gift request cannot be verified.');
    const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
    const updated: GiftRequestRecord = { ...request, version: request.version + 1, verifiedByStaffId: input.actorStaffId,
      verifiedAt: input.now.toISOString(), verificationNote: `${input.verificationMethod}: ${input.notes}`,
      verificationPayloadHash: giftPayloadHash(request, reservation), executionCredentialExpiresAt: expiresAt,
      updatedAt: input.now.toISOString() };
    const requestIndex=this.requests.indexOf(request);const taskIndex=this.staffTasks.indexOf(task);
    const requestSnapshot=clone(request);const taskSnapshot=clone(task);
    try {
      this.requests[requestIndex] = updated;
      this.staffTasks[taskIndex] = { ...task, status: 'VERIFIED', version: task.version + 1, updatedAt: input.now.toISOString() };
      if(input.auditRecord&&input.auditSink)await input.auditSink.append(input.auditRecord);
      return { status: 'VERIFIED', giftRequestId: request.id, taskId: task.id,
        executionCredential: { payloadHash: updated.verificationPayloadHash!, expiresAt } };
    } catch(error) {
      this.requests[requestIndex]=requestSnapshot;this.staffTasks[taskIndex]=taskSnapshot;throw error;
    }
  }

  authorizeGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel; reason: string; now: Date; approvalThresholds?: GiftApprovalThresholds;approvalDecision?:GiftApprovalDecisionExecution }): GiftAuthorizationResult {
    const request = this.requireRequest(input.giftRequestId);
    const reservation = this.requireReservation(request.id);
    const task = this.staffTasks.find((candidate) => candidate.giftRequestId === request.id);
    if (request.status === 'PENDING_APPROVAL') {
      const approval = this.approvals.find((candidate) => candidate.targetId === request.id && (candidate.status ?? 'PENDING') === 'PENDING'
        && (!input.approvalDecision || candidate.id===input.approvalDecision.approvalRequestId));
      if (!approval || request.version !== input.expectedVersion || levelRank(input.actorLevel) < levelRank(approval.requiredLevel)
        || Date.parse(approval.expiresAt) <= input.now.getTime()
        || approval.payloadSnapshot.verificationPayloadHash !== request.verificationPayloadHash
        || approval.payloadHash !== hashStableJson(approval.payloadSnapshot)
        || input.approvalDecision && (approval.payloadHash!==input.approvalDecision.payloadHash||approval.targetVersion!==input.approvalDecision.targetVersion)) {
        throw new GiftError('EXECUTION_CREDENTIAL_STALE', 'Approval request changed or expired.');
      }
      approval.status = 'APPROVED';
      this.requests[this.requests.indexOf(request)] = { ...request, status: 'APPROVED', version: request.version + 1,
        approvedByStaffId: input.actorStaffId, approvedAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
      if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'APPROVED', version: task.version + 1, updatedAt: input.now.toISOString() };
      return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel: approval.requiredLevel,
        approvalRequestId: approval.id, executionCredential: { payloadHash: request.verificationPayloadHash!, expiresAt: request.executionCredentialExpiresAt! } };
    }
    assertExecutionCredential(request, reservation, task, input.expectedVersion, input.now);
    const requiredLevel = requiredGiftLevel(request.priceMinor, input.approvalThresholds);
    if (levelRank(input.actorLevel) < levelRank(requiredLevel)) {
      if (requiredLevel === 'L2_SUPERVISOR') throw new GiftError('PERMISSION_DENIED', 'L1 cannot authorize gifts.');
      const approval = buildGiftApproval(request, input.actorStaffId, requiredLevel, input.reason, input.now);
      this.approvals.push(approval);
      this.requests[this.requests.indexOf(request)] = { ...request, status: 'PENDING_APPROVAL', version: request.version + 1, updatedAt: input.now.toISOString() };
      if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'PENDING_APPROVAL', version: task.version + 1, updatedAt: input.now.toISOString() };
      return { code: 'APPROVAL_PENDING', actionExecuted: false, requiredLevel, approvalRequestId: approval.id, expiresAt: approval.expiresAt };
    }
    this.requests[this.requests.indexOf(request)] = { ...request, status: 'APPROVED', version: request.version + 1,
      approvedByStaffId: input.actorStaffId, approvedAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
    if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'APPROVED', version: task.version + 1, updatedAt: input.now.toISOString() };
    return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel, approvalRequestId: null,
      executionCredential: { payloadHash: request.verificationPayloadHash!, expiresAt: request.executionCredentialExpiresAt! } };
  }

  async commitApprovalDecision(input: GiftApprovalCommit): Promise<GiftApprovalCommitResult> {
    const snapshots = {
      requests: clone(this.requests),
      reservations: clone(this.reservations),
      staffTasks: clone(this.staffTasks),
      captures: clone(this.captures),
      consumptions: clone(this.consumptions),
      broadcasts: clone(this.broadcasts),
      approvals: clone(this.approvals)
    };
    try {
      const existing = this.findCapture(input.giftRequestId);
      if (existing) {
        await input.auditSink.append({...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
        return { data: existing, statusCode: 200 };
      }
      let context = this.getCaptureContext(input.giftRequestId);
      if (context.request.status !== 'APPROVED') {
        const authorization = this.authorizeGift(input);
        if ('code' in authorization) {
          await input.auditSink.append({...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
          return { data: authorization, statusCode: 202 };
        }
        context = this.getCaptureContext(input.giftRequestId);
      } else if (![context.request.version, context.request.version - 1].includes(input.expectedVersion)) {
        throw new GiftError('CONFLICT', 'Gift approval version is stale.');
      }
      const captured = this.commitCapture({
        giftRequestId: context.request.id,
        expectedGiftVersion: context.request.version,
        expectedReservationVersion: context.reservation.version,
        provider: 'INTERNAL_WALLET',
        providerTransactionRef: deterministicUuid(`wallet:gift:${context.request.id}:capture:v1`),
        providerIdempotencyKey: `wallet:gift:${context.request.id}:capture:v1`,
        actorStaffId: input.actorStaffId,
        broadcastChannelId: input.broadcastChannelId,
        senderDisplayName: context.senderDisplayName,
        receiverDisplayName: context.receiverDisplayName,
        now: input.now
      });
      await input.auditSink.append({...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
      return { data: captured, statusCode: 200 };
    } catch (error) {
      restoreArray(this.requests, snapshots.requests);
      restoreArray(this.reservations, snapshots.reservations);
      restoreArray(this.staffTasks, snapshots.staffTasks);
      restoreArray(this.captures, snapshots.captures);
      restoreArray(this.consumptions, snapshots.consumptions);
      restoreArray(this.broadcasts, snapshots.broadcasts);
      restoreArray(this.approvals, snapshots.approvals);
      throw error;
    }
  }

  getCaptureContext(giftRequestId: string): GiftCaptureContext {
    const request = this.requireRequest(giftRequestId);
    const reservation = this.requireReservation(giftRequestId);
    return clone({ request, reservation, guildId:request.guildId ?? (request.orderId ? this.guildIdsByOrder[request.orderId] : null) ?? null,
      senderDisplayName: this.displayNames[request.senderId] ?? request.senderId,
      receiverDisplayName: this.displayNames[request.receiverId] ?? request.receiverId });
  }

  findCapture(giftRequestId: string): GiftCaptureResult | null {
    const capture = this.captures.find((candidate) => candidate.giftRequestId === giftRequestId);
    return capture ? clone(capture) : null;
  }

  getTerminationContext(giftRequestId: string) {
    return clone({ request: this.requireRequest(giftRequestId), reservation: this.requireReservation(giftRequestId) });
  }

  async commitTermination(input: GiftTerminationCommit): Promise<GiftTerminationResult> {
    const request = this.requireRequest(input.giftRequestId); const reservation = this.requireReservation(input.giftRequestId);
    if (request.status === input.terminalStatus && ['RELEASED','EXPIRED'].includes(reservation.status)) return terminationResult(request,reservation,input.reason);
    if (request.version !== input.expectedGiftVersion || reservation.version !== input.expectedReservationVersion
      || !['PENDING_REVIEW','PENDING_APPROVAL','APPROVED'].includes(request.status) || reservation.status !== 'ACTIVE')
      throw new GiftError('CONFLICT','Gift request or reservation cannot be released.');
    if (input.actorUserId && request.senderId !== input.actorUserId) throw new GiftError('PERMISSION_DENIED','Only the sender can withdraw this gift request.');
    const reservationStatus = input.terminalStatus === 'EXPIRED' ? 'EXPIRED' : 'RELEASED';
    const task=this.staffTasks.find((candidate)=>candidate.giftRequestId===request.id);
    const snapshots={request:clone(request),reservation:clone(reservation),task:task?clone(task):null,approvals:clone(this.approvals)};
    try {
      Object.assign(request,{status:input.terminalStatus,version:request.version+1,rejectedReason:input.reason,updatedAt:input.now.toISOString()});
      Object.assign(reservation,{status:reservationStatus,version:reservation.version+1,settledAt:input.now.toISOString(),updatedAt:input.now.toISOString()});
      if(task)Object.assign(task,{status:input.terminalStatus==='REJECTED'?'REJECTED':'CANCELLED',version:task.version+1,updatedAt:input.now.toISOString()});
      if(!input.approvalDecision)for(const approval of this.approvals){if(approval.targetId===request.id&&(approval.status??'PENDING')==='PENDING')approval.status=input.terminalStatus==='EXPIRED'?'EXPIRED':'CANCELLED';}
      if(input.auditRecord&&input.auditSink)await input.auditSink.append({...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
      return terminationResult(request,reservation,input.reason);
    } catch(error) {
      Object.assign(request,snapshots.request);Object.assign(reservation,snapshots.reservation);
      if(task&&snapshots.task)Object.assign(task,snapshots.task);
      restoreArray(this.approvals,snapshots.approvals);
      throw error;
    }
  }

  commitCapture(input: GiftCaptureCommit): GiftCaptureResult {
    const existing = this.findCapture(input.giftRequestId);
    if (existing) return existing;
    const request = this.requireRequest(input.giftRequestId);
    const reservation = this.requireReservation(input.giftRequestId);
    if (request.status !== 'APPROVED' || request.version !== input.expectedGiftVersion
      || reservation.status !== 'ACTIVE' || reservation.version !== input.expectedReservationVersion
      || reservation.amountMinor !== request.priceMinor) {
      throw new GiftError('CONFLICT', 'Gift or reservation changed before capture.');
    }
    const consumptionId = deterministicUuid(`gift-consumption:${request.id}`);
    const announcement = buildGiftAnnouncementJob(request, input.broadcastChannelId,
      input.senderDisplayName, input.receiverDisplayName, input.now);
    const result = buildCaptureResult({ request, reservation, consumptionId, announcementJobId: announcement.id,
      providerTransactionRef: input.providerTransactionRef, now: input.now });
    this.requests[this.requests.indexOf(request)] = { ...request, status: 'CAPTURED', version: request.version + 1,
      capturedAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
    this.reservations[this.reservations.indexOf(reservation)] = { ...reservation, status: 'CAPTURED', version: reservation.version + 1,
      settledAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
    this.captures.push(clone(result));
    this.consumptions.push({ id: consumptionId, giftRequestId: request.id,
      amountMinor: request.priceMinor, currency: request.currency });
    this.broadcasts.push(announcement);
    return clone(result);
  }

  markAnnounced(input: { giftRequestId: string; channelId: string; messageId: string; now: Date }): void {
    const request = this.requireRequest(input.giftRequestId);
    if (request.status === 'ANNOUNCED' && request.broadcastMessageId === input.messageId) return;
    if (request.status !== 'CAPTURED') throw new GiftError('CONFLICT', 'Only captured gifts can be announced.');
    this.requests[this.requests.indexOf(request)] = { ...request, status: 'ANNOUNCED', version: request.version + 1,
      announcedAt: input.now.toISOString(), broadcastChannelId: input.channelId, broadcastMessageId: input.messageId,
      updatedAt: input.now.toISOString() };
  }

  async rejectGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; reason: string; now: Date }) {
    const request = this.requireRequest(input.giftRequestId);
    if (request.version !== input.expectedVersion || !request.verifiedAt || !request.verificationPayloadHash) throw new GiftError('CONFLICT', 'Gift request is not ready for rejection.');
    await this.commitTermination({giftRequestId:input.giftRequestId,expectedGiftVersion:input.expectedVersion,
      expectedReservationVersion:this.requireReservation(input.giftRequestId).version,terminalStatus:'REJECTED',reason:input.reason,actorStaffId:input.actorStaffId,now:input.now});
    return { status: 'REJECTED' as const, reason: input.reason };
  }

  private requireRequest(id: string): GiftRequestRecord {
    const request = this.requests.find((candidate) => candidate.id === id);
    if (!request) throw new GiftError('NOT_FOUND', 'Gift request was not found.');
    return request;
  }

  private requireReservation(giftRequestId: string): GiftReservationRecord {
    const reservation = this.reservations.find((candidate) => candidate.giftRequestId === giftRequestId);
    if (!reservation) throw new GiftError('CONFLICT', 'Gift reservation was not found.');
    return reservation;
  }
}

export class PostgresGiftStore implements GiftStore {
  constructor(private readonly pool: Pool, private readonly mfaEncryptionKey = process.env.DASHBOARD_MFA_ENCRYPTION_KEY?.trim() ?? '') {}

  async listActiveCatalog(): Promise<GiftCatalogRecord[]> {
    const result = await this.pool.query<GiftCatalogRow>(`
SELECT versions.id, versions.gift_catalog_item_id, items.code, versions.version, versions.status,
       versions.name, versions.price_minor, versions.currency, versions.broadcast_template
FROM gift_catalog_versions versions
JOIN gift_catalog_items items ON items.id = versions.gift_catalog_item_id
WHERE versions.status = 'ACTIVE' AND items.archived_at IS NULL
ORDER BY versions.price_minor, items.code`);
    return result.rows.map(mapGiftCatalogRow);
  }

  async findCatalogVersion(id: string): Promise<GiftCatalogRecord | null> {
    const result = await this.pool.query<GiftCatalogRow>(`
SELECT versions.id, versions.gift_catalog_item_id, items.code, versions.version, versions.status,
       versions.name, versions.price_minor, versions.currency, versions.broadcast_template
FROM gift_catalog_versions versions
JOIN gift_catalog_items items ON items.id = versions.gift_catalog_item_id
WHERE versions.id = $1`, [id]);
    return result.rows[0] ? mapGiftCatalogRow(result.rows[0]) : null;
  }

  async listStandaloneRecipients(input: { guildId: string }): Promise<StandaloneGiftRecipientRecord[]> {
    const result = await this.pool.query<StandaloneGiftRecipientRow>(standaloneGiftRecipientSelect + `
WHERE da.guild_id=$1 AND pp.review_status='ACTIVE' AND u.status='ACTIVE'
ORDER BY lower(u.display_name),pp.id`, [input.guildId]);
    return result.rows.map(mapStandaloneGiftRecipientRow);
  }

  async findStandaloneRecipient(input: { guildId: string; playerProfileId: string }): Promise<StandaloneGiftRecipientRecord | null> {
    const result = await this.pool.query<StandaloneGiftRecipientRow>(standaloneGiftRecipientSelect + `
WHERE da.guild_id=$1 AND pp.id=$2 AND pp.review_status='ACTIVE' AND u.status='ACTIVE'`, [input.guildId, input.playerProfileId]);
    return result.rows[0] ? mapStandaloneGiftRecipientRow(result.rows[0]) : null;
  }

  async findStaffGiftAssistChallenge(input: { id: string; actorStaffId: string; guildId: string; permissionsVersion: number; now: Date }): Promise<StaffGiftAssistChallengeRecord | null> {
    const result = await this.pool.query<StaffGiftAssistChallengeRow>(staffGiftAssistChallengeSelect + `
WHERE challenge.id=$1 AND challenge.staff_account_id=$2 AND challenge.guild_id=$3`, [input.id, input.actorStaffId, input.guildId]);
    const challenge = result.rows[0] ? mapStaffGiftAssistChallengeRow(result.rows[0]) : null;
    if (!challenge) return null;
    if (challenge.permissionsVersion !== input.permissionsVersion || challenge.consumedAt
      || Date.parse(challenge.expiresAt) <= input.now.getTime() || challenge.failedAttempts >= 5) {
      throw new GiftError('CONFLICT', 'Gift assist challenge changed, expired, or was already consumed.');
    }
    return challenge;
  }

  async commitCreateStaffGiftAssistChallenge(input: { challenge: StaffGiftAssistChallengeRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const trusted = await client.query<{ staff_ok: boolean; customer_ok: boolean }>(`
SELECT EXISTS (
  SELECT 1 FROM staff_accounts staff JOIN discord_accounts discord ON discord.user_id=staff.user_id
  WHERE staff.id=$1 AND staff.status='ACTIVE' AND staff.permissions_version=$2
    AND discord.guild_id=$3 AND discord.discord_user_id=$4
) AS staff_ok,
EXISTS (
  SELECT 1 FROM users customer JOIN discord_accounts discord ON discord.user_id=customer.id
  WHERE customer.id=$5 AND customer.status='ACTIVE' AND discord.guild_id=$3 AND discord.discord_user_id=$6
) AS customer_ok`, [input.challenge.staffAccountId, input.challenge.permissionsVersion, input.challenge.guildId,
        input.challenge.staffDiscordUserId, input.challenge.customerUserId, input.challenge.customerDiscordUserId]);
      if (!trusted.rows[0]?.staff_ok || !trusted.rows[0]?.customer_ok) {
        throw new GiftError('CONFLICT', 'Staff or customer binding changed before challenge creation.');
      }
      await client.query(`INSERT INTO staff_gift_assist_challenges (
        id,guild_id,staff_account_id,staff_discord_user_id,permissions_version,customer_user_id,customer_discord_user_id,
        authorization_channel_id,authorization_message_id,authorization_reason,failed_attempts,expires_at,consumed_at,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,0,$10,NULL,$11,$11)
      ON CONFLICT (id) DO NOTHING`, [input.challenge.id,input.challenge.guildId,input.challenge.staffAccountId,
        input.challenge.staffDiscordUserId,input.challenge.permissionsVersion,input.challenge.customerUserId,
        input.challenge.customerDiscordUserId,input.challenge.authorizationChannelId,input.challenge.authorizationMessageId,
        new Date(input.challenge.expiresAt),new Date(input.challenge.createdAt)]);
      await insertPostgresAuditRecord(client, input.auditRecord);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async findActiveOrderParticipants(input: { orderId: string; participantIds: string[] }): Promise<GiftRecipientRecord[]> {
    const result = await this.pool.query<{ id: string; player_id: string; player_display_name_snapshot: string }>(
      `SELECT id,player_id,player_display_name_snapshot FROM order_participants
       WHERE order_id=$1 AND status='ACTIVE' AND (cardinality($2::uuid[])=0 OR id=ANY($2::uuid[])) ORDER BY created_at,id`,
      [input.orderId, input.participantIds]
    );
    return result.rows.map((row) => ({ participantId: row.id, playerId: row.player_id, displayName: row.player_display_name_snapshot }));
  }

  async commitCreate(input: {
    request: GiftRequestRecord;
    reservation: GiftReservationRecord;
    staffTask: GiftStaffTaskRecord;
    ledgerBalanceMinor: number;
    expectedOrderVersion?: number;
    expectedGuildId?: string;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    staffAssist?: StaffGiftAssistFinalization;
  }): Promise<void> {
    return this.commitCreateBatch({ ...input, items: [{ request: input.request, reservation: input.reservation, staffTask: input.staffTask }] });
  }

  async commitCreateBatch(input: {
    items: Array<{ request: GiftRequestRecord; reservation: GiftReservationRecord; staffTask: GiftStaffTaskRecord }>;
    ledgerBalanceMinor: number;
    expectedOrderVersion?: number;
    standalonePlayerProfileId?: string;
    expectedGuildId?: string;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    staffAssist?: StaffGiftAssistFinalization;
  }): Promise<void> {
    const first = input.items[0];
    if (!first) throw new GiftError('VALIDATION_ERROR', 'At least one gift recipient is required.');
    const client = await this.pool.connect();
    let transactionCommitted = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${first.request.senderId}:${first.request.currency}`]);
      if (input.staffAssist) {
        const assist = input.staffAssist;
        const result = await client.query<{
          staff_account_id: string; staff_discord_user_id: string; permissions_version: number;
          customer_user_id: string; customer_discord_user_id: string; guild_id: string;
          failed_attempts: number; expires_at: Date; consumed_at: Date | null; secret_ciphertext: string | null;
          staff_status: string; current_permissions_version: number; customer_status: string;
          staff_binding_ok: boolean; customer_binding_ok: boolean;
        }>(`SELECT challenge.staff_account_id,challenge.staff_discord_user_id,challenge.permissions_version,
          challenge.customer_user_id,challenge.customer_discord_user_id,challenge.guild_id,challenge.failed_attempts,
          challenge.expires_at,challenge.consumed_at,credential.secret_ciphertext,staff.status::text AS staff_status,
          staff.permissions_version AS current_permissions_version,customer.status::text AS customer_status,
          EXISTS (SELECT 1 FROM discord_accounts d WHERE d.user_id=staff.user_id AND d.guild_id=challenge.guild_id
            AND d.discord_user_id=challenge.staff_discord_user_id) AS staff_binding_ok,
          EXISTS (SELECT 1 FROM discord_accounts d WHERE d.user_id=customer.id AND d.guild_id=challenge.guild_id
            AND d.discord_user_id=challenge.customer_discord_user_id) AS customer_binding_ok
        FROM staff_gift_assist_challenges challenge
        JOIN staff_accounts staff ON staff.id=challenge.staff_account_id
        JOIN users customer ON customer.id=challenge.customer_user_id
        LEFT JOIN staff_mfa_credentials credential ON credential.staff_account_id=staff.id AND credential.method='TOTP'
        WHERE challenge.id=$1 FOR UPDATE OF challenge`, [assist.challengeId]);
        const challenge = result.rows[0];
        if (!challenge || challenge.staff_account_id !== assist.actorStaffId
          || challenge.staff_discord_user_id !== assist.actorDiscordUserId
          || challenge.permissions_version !== assist.permissionsVersion
          || challenge.current_permissions_version !== assist.permissionsVersion
          || challenge.guild_id !== input.expectedGuildId || challenge.customer_user_id !== first.request.senderId
          || challenge.staff_status !== 'ACTIVE' || challenge.customer_status !== 'ACTIVE'
          || !challenge.staff_binding_ok || !challenge.customer_binding_ok || challenge.consumed_at
          || challenge.expires_at.getTime() <= input.now.getTime() || challenge.failed_attempts >= 5
          || first.request.initiatorMode !== 'STAFF_ASSISTED'
          || first.request.assistedByStaffId !== assist.actorStaffId
          || first.request.giftAssistChallengeId !== assist.challengeId) {
          throw new GiftError('CONFLICT', 'Gift assist challenge changed, expired, or was already consumed.');
        }
        if (!challenge.secret_ciphertext || !this.mfaEncryptionKey) {
          throw new GiftError('MFA_REQUIRED', 'The current staff account must enroll TOTP before assisting a gift.');
        }
        let validProof = false;
        try { validProof = verifyTotp(assist.totpCode, decryptSecret(challenge.secret_ciphertext, this.mfaEncryptionKey), input.now); }
        catch { throw new GiftError('MFA_REQUIRED', 'The staff TOTP credential could not be verified.'); }
        if (!validProof) {
          await client.query(`UPDATE staff_gift_assist_challenges SET failed_attempts=failed_attempts+1,updated_at=$2
            WHERE id=$1`, [assist.challengeId,input.now]);
          await client.query('COMMIT');
          transactionCommitted = true;
          throw new GiftError('MFA_INVALID', 'The TOTP code is invalid.');
        }
      }
      if ((first.request.origin ?? 'ORDER') === 'STANDALONE') {
        const recipient = input.standalonePlayerProfileId ? await client.query<{ user_id: string }>(`
          SELECT pp.user_id FROM player_profiles pp JOIN users u ON u.id=pp.user_id
          JOIN discord_accounts da ON da.user_id=pp.user_id AND da.guild_id=$1
          WHERE pp.id=$2 AND pp.review_status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF pp,u`,
        [input.expectedGuildId, input.standalonePlayerProfileId]) : { rows: [] };
        if (input.items.length !== 1 || !input.expectedGuildId || first.request.guildId !== input.expectedGuildId
          || first.request.orderId !== null || first.request.participantId != null
          || recipient.rows[0]?.user_id !== first.request.receiverId) {
          throw new GiftError('NOT_FOUND', 'Eligible gift recipient was not found.');
        }
      } else {
        const order = await client.query<{ customer_id: string; guild_id: string; status: string; completed_at: Date | null; row_version: number }>(
          `SELECT customer_id,guild_id,status,completed_at,row_version FROM orders WHERE id=$1 FOR UPDATE`, [first.request.orderId]);
        const currentOrder = order.rows[0];
        const completedWithinWindow = currentOrder?.status === 'COMPLETED' && currentOrder.completed_at
          && input.now.getTime() - currentOrder.completed_at.getTime() <= 24 * 60 * 60_000;
        if (!currentOrder || currentOrder.customer_id !== first.request.senderId
          || (input.expectedGuildId !== undefined && currentOrder.guild_id !== input.expectedGuildId)
          || currentOrder.row_version !== input.expectedOrderVersion
          || (!['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(currentOrder.status) && !completedWithinWindow)) {
          throw new GiftError('CONFLICT', 'Order changed; refresh before retrying.');
        }
        const participantIds = input.items.map((item) => item.request.participantId).filter((id): id is string => Boolean(id));
        if (participantIds.length !== input.items.length || new Set(participantIds).size !== input.items.length) {
          throw new GiftError('VALIDATION_ERROR', 'Gift recipients must be distinct active order participants.');
        }
        const recipients = await client.query<{ id: string; player_id: string }>(
          `SELECT id,player_id FROM order_participants WHERE order_id=$1 AND status='ACTIVE' AND id=ANY($2::uuid[]) FOR SHARE`,
          [first.request.orderId, participantIds]);
        const receiverByParticipant = new Map(recipients.rows.map((row) => [row.id, row.player_id]));
        if (recipients.rows.length !== input.items.length || input.items.some((item) => receiverByParticipant.get(item.request.participantId!) !== item.request.receiverId)) {
          throw new GiftError('CONFLICT', 'One or more gift recipients changed; refresh before retrying.');
        }
      }
      const catalog = await client.query<{ status: string; version: number; price_minor: string; currency: string }>(
        `SELECT status,version,price_minor,currency FROM gift_catalog_versions WHERE id = $1 FOR SHARE`, [first.request.giftCatalogVersionId]);
      const currentCatalog = catalog.rows[0];
      if (!currentCatalog || currentCatalog.status !== 'ACTIVE'
        || Number(currentCatalog.price_minor) !== first.request.priceMinor || currentCatalog.currency !== first.request.currency
        || input.items.some((item) => item.request.giftCatalogVersionId !== first.request.giftCatalogVersionId || item.request.priceMinor !== first.request.priceMinor)) {
        throw new GiftError('GIFT_CATALOG_CHANGED', 'Gift catalog changed; check affordability and confirm again.');
      }
      const reserved = await client.query<{ amount: string }>(`
SELECT COALESCE(SUM(${reservationRemainingMinorSql('reservation','settlement')}), 0)::text AS amount
FROM fund_reservations reservation
${reservationSettlementLateralSql('reservation','settlement')}
WHERE reservation.user_id = $1 AND reservation.currency = $2
AND reservation.status = ANY($3::"FundReservationStatus"[])`,
      [first.request.senderId, first.request.currency, [...activeReservationStatuses]]);
      const wallet=await client.query<{id:string}>('SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE',[first.request.senderId]);
      const ledger=wallet.rows[0]?await client.query<{amount:string}>(`SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END),0)::text amount FROM wallet_entries WHERE wallet_account_id=$1`,[wallet.rows[0].id]):{rows:[{amount:'0'}]};
      const totalAmountMinor = first.request.priceMinor * input.items.length;
      if (!Number.isSafeInteger(totalAmountMinor) || Number(ledger.rows[0]?.amount ?? 0) - Number(reserved.rows[0]?.amount ?? 0) < totalAmountMinor) {
        throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
      }
      for (const item of input.items) {
        await client.query(`INSERT INTO gift_requests (
          id,public_id,guild_id,origin,sender_visibility,initiator_mode,assisted_by_staff_id,gift_assist_challenge_id,
          order_id,order_participant_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,
          gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,expires_at,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING_REVIEW',1,$14,$15,$16,$17,$18,$19,$20,$20)`, [
          item.request.id,item.request.publicId,item.request.guildId ?? input.expectedGuildId,item.request.origin ?? 'ORDER',
          item.request.senderVisibility ?? 'PUBLIC',item.request.initiatorMode ?? 'CUSTOMER_SELF',item.request.assistedByStaffId ?? null,
          item.request.giftAssistChallengeId ?? null,item.request.orderId,item.request.participantId,item.request.giftCatalogVersionId,
          item.request.senderId,item.request.receiverId,item.request.giftCodeSnapshot,item.request.giftNameSnapshot,
          item.request.priceMinor,item.request.currency,item.request.broadcastTemplateSnapshot,new Date(item.request.expiresAt),new Date(item.request.createdAt)
        ]);
        await client.query(`INSERT INTO fund_reservations (
        id,user_id,source_type,order_id,gift_request_id,mode,provider,provider_hold_ref,amount_minor,currency,
        status,row_version,idempotency_key,expires_at,activated_at,created_at,updated_at
      ) VALUES ($1,$2,'GIFT',NULL,$3,$4,$5,$6,$7,$8,'PENDING',1,$9,$10,NULL,$11,$11)`, [
          item.reservation.id,item.reservation.userId,item.request.id,item.reservation.mode,item.reservation.provider,
          item.reservation.providerHoldRef,item.reservation.amountMinor,item.reservation.currency,item.reservation.idempotencyKey,
          new Date(item.reservation.expiresAt),new Date(item.reservation.activatedAt ?? item.reservation.createdAt)
        ]);
        await client.query(`INSERT INTO fund_reservation_events (
        id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
        idempotency_key,actor_user_id,actor_staff_id,actor_source,created_at
      ) VALUES ($1,$2,1,'CREATED',NULL,'PENDING',$3,1,$4,$5,$6,'DISCORD_BOT',$7)`, [
          crypto.randomUUID(),item.reservation.id,item.reservation.amountMinor,`${item.reservation.idempotencyKey}:created`,
          input.staffAssist ? null : item.request.senderId,input.staffAssist?.actorStaffId ?? null,new Date(item.request.createdAt)
        ]);
        await client.query(`INSERT INTO fund_reservation_events (
        id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
        idempotency_key,actor_user_id,actor_staff_id,actor_source,created_at
      ) VALUES ($1,$2,2,'ACTIVATED','PENDING','ACTIVE',0,2,$3,$4,$5,'DISCORD_BOT',$6)`, [
          crypto.randomUUID(),item.reservation.id,`${item.reservation.idempotencyKey}:activated`,
          input.staffAssist ? null : item.request.senderId,input.staffAssist?.actorStaffId ?? null,new Date(item.request.createdAt)
        ]);
        await client.query(`INSERT INTO staff_tasks (
        id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,created_by_staff_id,voice_channel_id,
        context_snapshot,created_at,updated_at
      ) VALUES ($1,$2,'GIFT_REVIEW','GIFT_REQUESTED','OPEN',1,$3,$4,$5,$6,$7::jsonb,$8,$8)`, [
          item.staffTask.id,item.staffTask.publicId,item.staffTask.orderId,item.staffTask.giftRequestId,
          input.staffAssist?.actorStaffId ?? null,item.staffTask.voiceChannelId,
          JSON.stringify(item.staffTask.contextSnapshot),new Date(item.staffTask.createdAt)
        ]);
        const expiryJob=buildGiftExpiryJob(item.request);
        await client.query(`INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,gift_request_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
        VALUES ($1,'GIFT_EXPIRY','GIFT_REQUEST',$2,$2,$3,$4::jsonb,'PENDING',1,0,$5,$6,$7,$7)`,[expiryJob.id,item.request.id,expiryJob.dedupeKey,
          JSON.stringify(expiryJob.payload),expiryJob.maxAttempts,new Date(expiryJob.runAfter),new Date(expiryJob.createdAt)]);
      }
      if (input.staffAssist) {
        const consumed = await client.query(`UPDATE staff_gift_assist_challenges
          SET authorization_reason=$2,consumed_at=$3,updated_at=$3
          WHERE id=$1 AND consumed_at IS NULL`, [input.staffAssist.challengeId,input.staffAssist.authorizationReason,input.now]);
        if (consumed.rowCount !== 1) throw new GiftError('CONFLICT', 'Gift assist challenge was already consumed.');
      }
      await insertPostgresAuditRecord(client, input.auditRecord);
      await client.query('COMMIT');
      transactionCommitted = true;
    } catch (error) {
      if (!transactionCommitted) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyTask(input: { taskId: string; expectedVersion: number; actorStaffId: string; verificationMethod: string; notes: string; now: Date; auditRecord?: AuditRecord; auditSink?: AuditSink }): Promise<GiftReviewResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshot = await loadGiftReviewSnapshot(client, { taskId: input.taskId });
      if (snapshot.task.status !== 'CLAIMED' || snapshot.task.version !== input.expectedVersion || snapshot.task.claimedBy !== input.actorStaffId
        || snapshot.request.status !== 'PENDING_REVIEW' || snapshot.reservation.status !== 'ACTIVE') {
        throw new GiftError('CONFLICT', 'Gift task is not claimed by the current staff member.');
      }
      const payloadHash = giftPayloadHash(snapshot.request, snapshot.reservation);
      const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
      await client.query(`UPDATE gift_requests SET row_version = row_version + 1, verified_by_staff_id = $2,
        verified_at = $3, verification_note = $4, verification_payload_hash = $5,
        execution_credential_expires_at = $6, updated_at = $3 WHERE id = $1`, [
        snapshot.request.id, input.actorStaffId, input.now, `${input.verificationMethod}: ${input.notes}`, payloadHash, new Date(expiresAt)
      ]);
      await client.query(`UPDATE staff_tasks SET status = 'VERIFIED', row_version = row_version + 1,
        verified_at = $2, updated_at = $2 WHERE id = $1`, [input.taskId, input.now]);
      if(input.auditRecord)await insertPostgresAuditRecord(client,input.auditRecord);
      await client.query('COMMIT');
      return { status: 'VERIFIED', giftRequestId: snapshot.request.id, taskId: input.taskId,
        executionCredential: { payloadHash, expiresAt } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async authorizeGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel; reason: string; now: Date; approvalThresholds?: GiftApprovalThresholds;approvalDecision?:GiftApprovalDecisionExecution }): Promise<GiftAuthorizationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.authorizeGiftWithClient(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async authorizeGiftWithClient(client: PoolClient, input: {
    giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel;
    reason: string; now: Date; approvalThresholds?: GiftApprovalThresholds;
    approvalDecision?:GiftApprovalDecisionExecution;
  }): Promise<GiftAuthorizationResult> {
    const snapshot = await loadGiftReviewSnapshot(client, { giftRequestId: input.giftRequestId });
    if (snapshot.request.status === 'PENDING_APPROVAL') {
      const approvalResult = await client.query<{ id: string; required_level: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER'; target_version:number;row_version:number;payload_snapshot: Record<string, unknown>; payload_hash: string; expires_at: Date }>(
        `SELECT id, required_level, target_version,row_version,payload_snapshot, payload_hash, expires_at FROM approval_requests
         WHERE target_id = $1 AND action = 'GIFT_APPROVE' AND status = 'PENDING' AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.giftRequestId,input.approvalDecision?.approvalRequestId??null]
      );
      const approval = approvalResult.rows[0];
      if (!approval || snapshot.request.version !== input.expectedVersion || levelRank(input.actorLevel) < levelRank(approval.required_level)
        || approval.expires_at.getTime() <= input.now.getTime()
        || approval.payload_snapshot.verificationPayloadHash !== snapshot.request.verificationPayloadHash
        || approval.payload_hash !== hashStableJson(approval.payload_snapshot)
        || input.approvalDecision&&(approval.row_version!==input.approvalDecision.expectedApprovalVersion
          ||approval.target_version!==input.approvalDecision.targetVersion||approval.payload_hash!==input.approvalDecision.payloadHash
          ||snapshot.guildId!==input.approvalDecision.guildId)) {
        throw new GiftError('EXECUTION_CREDENTIAL_STALE', 'Approval request changed or expired.');
      }
      await client.query(`UPDATE approval_requests SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [approval.id, input.now]);
      await client.query(`INSERT INTO approval_decisions (id,approval_request_id,decision,decided_by_staff_id,reason,target_version_checked,payload_hash_checked,decided_at)
        VALUES ($1,$2,'APPROVE',$3,$4,$5,$6,$7)`, [crypto.randomUUID(), approval.id, input.actorStaffId, input.reason,
        snapshot.request.version, approval.payload_hash, input.now]);
      await client.query(`UPDATE gift_requests SET status = 'APPROVED', row_version = row_version + 1,
        approved_by_staff_id = $2, approved_at = $3, updated_at = $3 WHERE id = $1`, [input.giftRequestId, input.actorStaffId, input.now]);
      await client.query(`UPDATE staff_tasks SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [snapshot.task.id, input.now]);
      return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel: approval.required_level,
        approvalRequestId: approval.id, executionCredential: { payloadHash: snapshot.request.verificationPayloadHash!, expiresAt: snapshot.request.executionCredentialExpiresAt! } };
    }
    assertExecutionCredential(snapshot.request, snapshot.reservation, snapshot.task, input.expectedVersion, input.now);
    const requiredLevel = requiredGiftLevel(snapshot.request.priceMinor, input.approvalThresholds);
    if (levelRank(input.actorLevel) < levelRank(requiredLevel)) {
      if (requiredLevel === 'L2_SUPERVISOR') throw new GiftError('PERMISSION_DENIED', 'L1 cannot authorize gifts.');
      const approval = buildGiftApproval(snapshot.request, input.actorStaffId, requiredLevel, input.reason, input.now);
      await insertGiftApproval(client, approval, snapshot.task.id);
      await client.query(`UPDATE gift_requests SET status = 'PENDING_APPROVAL', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [input.giftRequestId, input.now]);
      await client.query(`UPDATE staff_tasks SET status = 'PENDING_APPROVAL', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [snapshot.task.id, input.now]);
      return { code: 'APPROVAL_PENDING', actionExecuted: false, requiredLevel, approvalRequestId: approval.id, expiresAt: approval.expiresAt };
    }
    await client.query(`UPDATE gift_requests SET status = 'APPROVED', row_version = row_version + 1,
      approved_by_staff_id = $2, approved_at = $3, updated_at = $3 WHERE id = $1`, [input.giftRequestId, input.actorStaffId, input.now]);
    await client.query(`UPDATE staff_tasks SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [snapshot.task.id, input.now]);
    return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel, approvalRequestId: null,
      executionCredential: { payloadHash: snapshot.request.verificationPayloadHash!, expiresAt: snapshot.request.executionCredentialExpiresAt! } };
  }

  async commitApprovalDecision(input: GiftApprovalCommit): Promise<GiftApprovalCommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<GiftCaptureRow>(`${giftCaptureSelect}
WHERE tx.gift_request_id = $1 AND tx.type = 'GIFT_CHARGE' AND tx.status = 'SUCCEEDED' FOR UPDATE OF tx`, [input.giftRequestId]);
      if (existing.rows[0]) {
        await insertPostgresAuditRecord(client, {...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
        await client.query('COMMIT');
        return { data: mapGiftCaptureRow(existing.rows[0]), statusCode: 200 };
      }

      let snapshot = await loadGiftReviewSnapshot(client, { giftRequestId: input.giftRequestId });
      if (snapshot.request.status === 'APPROVED') {
        if (![snapshot.request.version, snapshot.request.version - 1].includes(input.expectedVersion)) {
          throw new GiftError('CONFLICT', 'Gift approval version is stale.');
        }
      } else {
        const authorization = await this.authorizeGiftWithClient(client, input);
        if ('code' in authorization) {
          await insertPostgresAuditRecord(client, input.auditRecord);
          await client.query('COMMIT');
          return { data: authorization, statusCode: 202 };
        }
        snapshot = await loadGiftReviewSnapshot(client, { giftRequestId: input.giftRequestId });
      }

      const names = await client.query<{ sender_display_name: string; receiver_display_name: string }>(`
SELECT sender.display_name AS sender_display_name, receiver.display_name AS receiver_display_name
FROM users sender
JOIN users receiver ON receiver.id = $2
WHERE sender.id = $1`, [snapshot.request.senderId, snapshot.request.receiverId]);
      if (!names.rows[0]) throw new GiftError('CONFLICT', 'Gift participants were not found.');
      const providerIdempotencyKey = `wallet:gift:${snapshot.request.id}:capture:v1`;
      const captured = await this.captureGiftWithClient(client, {
        giftRequestId: snapshot.request.id,
        expectedGiftVersion: snapshot.request.version,
        expectedReservationVersion: snapshot.reservation.version,
        provider: 'INTERNAL_WALLET',
        providerTransactionRef: deterministicUuid(providerIdempotencyKey),
        providerIdempotencyKey,
        actorStaffId: input.actorStaffId,
        broadcastChannelId: input.broadcastChannelId,
        senderDisplayName: names.rows[0].sender_display_name,
        receiverDisplayName: names.rows[0].receiver_display_name,
        now: input.now
      });
      await insertPostgresAuditRecord(client, {...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
      await client.query('COMMIT');
      return { data: captured, statusCode: 200 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCaptureContext(giftRequestId: string): Promise<GiftCaptureContext> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshot = await loadGiftReviewSnapshot(client, { giftRequestId });
      const account = await client.query<{ sender_display_name: string; receiver_display_name: string }>(`
SELECT sender.display_name AS sender_display_name, receiver.display_name AS receiver_display_name
FROM users sender
JOIN users receiver ON receiver.id = $2
WHERE sender.id = $1`, [snapshot.request.senderId, snapshot.request.receiverId]);
      if (!account.rows[0]) throw new GiftError('CONFLICT', 'Gift participants were not found.');
      await client.query('COMMIT');
      return { request: snapshot.request, reservation: snapshot.reservation,
        guildId:snapshot.guildId,
        senderDisplayName: account.rows[0].sender_display_name, receiverDisplayName: account.rows[0].receiver_display_name };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async findCapture(giftRequestId: string): Promise<GiftCaptureResult | null> {
    const result = await this.pool.query<GiftCaptureRow>(`${giftCaptureSelect}
WHERE tx.gift_request_id = $1 AND tx.type = 'GIFT_CHARGE' AND tx.status = 'SUCCEEDED'`, [giftRequestId]);
    const row = result.rows[0];
    return row ? mapGiftCaptureRow(row) : null;
  }

  async getTerminationContext(giftRequestId: string) {
    const client=await this.pool.connect();
    try{await client.query('BEGIN');const snapshot=await loadGiftReviewSnapshot(client,{giftRequestId});await client.query('COMMIT');
      return {request:snapshot.request,reservation:snapshot.reservation};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async commitTermination(input: GiftTerminationCommit): Promise<GiftTerminationResult> {
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');const snapshot=await loadGiftReviewSnapshot(client,{giftRequestId:input.giftRequestId});
      if(snapshot.request.status===input.terminalStatus&&['RELEASED','EXPIRED'].includes(snapshot.reservation.status)){
        await client.query('COMMIT');return terminationResult(snapshot.request,snapshot.reservation,input.reason);
      }
      if(snapshot.request.version!==input.expectedGiftVersion||snapshot.reservation.version!==input.expectedReservationVersion
        ||!['PENDING_REVIEW','PENDING_APPROVAL','APPROVED'].includes(snapshot.request.status)||snapshot.reservation.status!=='ACTIVE')
        throw new GiftError('CONFLICT','Gift request or reservation cannot be released.');
      if(input.actorUserId&&snapshot.request.senderId!==input.actorUserId)throw new GiftError('PERMISSION_DENIED','Only the sender can withdraw this gift request.');
      if(input.approvalDecision)await rejectStoredGiftApproval(client,input.approvalDecision,snapshot);
      else await client.query(`UPDATE approval_requests SET status=$2::"ApprovalStatus",row_version=row_version+1,updated_at=$3
        WHERE action='GIFT_APPROVE' AND target_type='GIFT_REQUEST' AND target_id=$1 AND status='PENDING'`,
      [snapshot.request.id,input.terminalStatus==='EXPIRED'?'EXPIRED':'CANCELLED',input.now]);
      const reservationStatus=input.terminalStatus==='EXPIRED'?'EXPIRED':'RELEASED';const eventType=input.terminalStatus==='EXPIRED'?'EXPIRED':'RELEASED';
      await client.query(`INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_staff_id,actor_source,reason_code,created_at)
        VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$3,$7,$8,$9,$10,$11,$12)`,[deterministicUuid(`gift-reservation:${input.terminalStatus}:${snapshot.request.id}`),snapshot.reservation.id,
        snapshot.reservation.version+1,eventType,reservationStatus,snapshot.reservation.amountMinor,`gift:reservation:${input.terminalStatus.toLowerCase()}:${snapshot.request.id}:v1`,input.actorUserId??null,input.actorStaffId??null,
        input.actorStaffId?'DASHBOARD':input.actorUserId?'DISCORD_BOT':'SYSTEM_JOB',input.terminalStatus==='EXPIRED'?'ADMIN_CORRECTION':'USER_REQUEST',input.now]);
      await client.query('UPDATE gift_requests SET status=$2,row_version=row_version+1,rejected_reason=$3,updated_at=$4 WHERE id=$1',[snapshot.request.id,input.terminalStatus,input.reason,input.now]);
      await client.query(`UPDATE staff_tasks SET status=$2,row_version=row_version+1,resolved_by_staff_id=$3,resolved_at=$4,updated_at=$4 WHERE id=$1`,[snapshot.task.id,input.terminalStatus==='REJECTED'?'REJECTED':'CANCELLED',input.actorStaffId??null,input.now]);
      if(input.auditRecord)await insertPostgresAuditRecord(client,{...input.auditRecord,approvalRequestId:input.approvalDecision?.approvalRequestId??input.auditRecord.approvalRequestId});
      await client.query('COMMIT');
      return {giftRequestId:snapshot.request.id,status:input.terminalStatus,reason:input.reason,reservation:{reservationId:snapshot.reservation.id,status:reservationStatus,amountMinor:snapshot.reservation.amountMinor,releasedMinor:snapshot.reservation.amountMinor,currency:snapshot.reservation.currency,version:snapshot.reservation.version+1}};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async commitCapture(input: GiftCaptureCommit): Promise<GiftCaptureResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.captureGiftWithClient(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async captureGiftWithClient(client: PoolClient, input: GiftCaptureCommit): Promise<GiftCaptureResult> {
    const existing = await client.query<GiftCaptureRow>(`${giftCaptureSelect}
WHERE tx.gift_request_id = $1 AND tx.type = 'GIFT_CHARGE' AND tx.status = 'SUCCEEDED' FOR UPDATE OF tx`, [input.giftRequestId]);
    if (existing.rows[0]) return mapGiftCaptureRow(existing.rows[0]);
    const snapshot = await loadGiftReviewSnapshot(client, { giftRequestId: input.giftRequestId });
    if (snapshot.request.status !== 'APPROVED' || snapshot.request.version !== input.expectedGiftVersion
      || snapshot.reservation.status !== 'ACTIVE' || snapshot.reservation.version !== input.expectedReservationVersion
      || snapshot.reservation.amountMinor !== snapshot.request.priceMinor) {
      throw new GiftError('CONFLICT', 'Gift or reservation changed before capture.');
    }
    const wallet=await client.query<{id:string;row_version:number}>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1 FOR UPDATE',[snapshot.request.senderId]);
    if(!wallet.rows[0])throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE','Wallet was not found.');
    const walletEntryId=deterministicUuid(`wallet:gift:${snapshot.request.id}:capture:v1`);
    await client.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ($1,$2,'GIFT_CAPTURE_DEBIT','DEBIT',$3,'CAT','FUND_RESERVATION',$4,$5,$6,$6)`,
      [walletEntryId,wallet.rows[0].id,snapshot.request.priceMinor,snapshot.reservation.id,`wallet:gift:${snapshot.request.id}:capture:v1`,input.now]);
    await client.query('UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$2 WHERE id=$1',[wallet.rows[0].id,input.now]);
    const transactionId = deterministicUuid(`gift-transaction:${snapshot.request.id}`);
    const consumptionId = deterministicUuid(`gift-consumption:${snapshot.request.id}`);
    await client.query(`INSERT INTO fund_reservation_events (
      id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
      idempotency_key,actor_staff_id,actor_source,reason_code,created_at
    ) VALUES ($1,$2,$3,'CAPTURED','ACTIVE','CAPTURED',$4,$5,$6,$7,'DASHBOARD','GIFT_APPROVED',$8)`, [
      deterministicUuid(`gift-reservation-captured:${snapshot.request.id}`), snapshot.reservation.id,
      snapshot.reservation.version + 1, snapshot.request.priceMinor, snapshot.reservation.version + 1,
      `gift:reservation:capture:${snapshot.request.id}:v1`, input.actorStaffId, input.now
    ]);
    await client.query(`INSERT INTO external_transactions (
      id,provider,type,user_id,gift_request_id,fund_reservation_id,external_ref,idempotency_key,
      amount_minor,currency,status,request_metadata,response_metadata,initiated_at,settled_at,created_at,updated_at
    ) VALUES ($1,$2,'GIFT_CHARGE',$3,$4,$5,$6,$7,$8,$9,'SUCCEEDED',$10::jsonb,$11::jsonb,$12,$12,$12,$12)`, [
      transactionId, input.provider, snapshot.request.senderId, snapshot.request.id, snapshot.reservation.id,
      input.providerTransactionRef, input.providerIdempotencyKey, snapshot.request.priceMinor, snapshot.request.currency,
      JSON.stringify({ fundReservationId: snapshot.reservation.id, reservationVersion: snapshot.reservation.version }),
      JSON.stringify({ providerTransactionRef: input.providerTransactionRef }), input.now
    ]);
    await client.query(`INSERT INTO consumption_entries (
      id,user_id,entry_type,direction,gift_request_id,external_transaction_id,amount_minor,currency,
      source_type,source_id,idempotency_key,occurred_at,created_at
    ) VALUES ($1,$2,'GIFT_CHARGE','DEBIT',$3,$4,$5,$6,'GIFT_REQUEST',$3,$7,$8,$8)`, [
      consumptionId, snapshot.request.senderId, snapshot.request.id, transactionId,
      snapshot.request.priceMinor, snapshot.request.currency, `gift:consumption:${snapshot.request.id}:v1`, input.now
    ]);
    await createEligibleReferralCommission(client,{referredUserId:snapshot.request.senderId,
      sourceConsumptionEntryId:consumptionId,baseAmountMinor:snapshot.request.priceMinor,
      currency:snapshot.request.currency,source:'GIFT',now:input.now});
    await client.query(`UPDATE gift_requests SET status = 'CAPTURED', row_version = row_version + 1,
      captured_at = $2, updated_at = $2 WHERE id = $1`, [snapshot.request.id, input.now]);
    const announcement = buildGiftAnnouncementJob(snapshot.request, input.broadcastChannelId,
      input.senderDisplayName, input.receiverDisplayName, input.now);
    await client.query(`INSERT INTO outbox_events (
      id,event_type,aggregate_type,aggregate_id,gift_request_id,dedupe_key,payload,status,row_version,
      attempt_count,max_attempts,available_at,created_at,updated_at
    ) VALUES ($1,'GIFT_ANNOUNCEMENT','GIFT_REQUEST',$2,$2,$3,$4::jsonb,'PENDING',1,0,$5,$6,$6,$6)`, [
      announcement.id, snapshot.request.id, announcement.dedupeKey, JSON.stringify(announcement.payload),
      announcement.maxAttempts, input.now
    ]);
    return buildCaptureResult({ request: snapshot.request, reservation: snapshot.reservation,
      consumptionId, announcementJobId: announcement.id, providerTransactionRef: input.providerTransactionRef, now: input.now });
  }

  async markAnnounced(input: { giftRequestId: string; channelId: string; messageId: string; now: Date }): Promise<void> {
    const result = await this.pool.query(`UPDATE gift_requests SET status = 'ANNOUNCED', row_version = row_version + 1,
      announced_at = $2, broadcast_channel_id = $3, broadcast_message_id = $4, updated_at = $2
      WHERE id = $1 AND status = 'CAPTURED'`, [input.giftRequestId, input.now, input.channelId, input.messageId]);
    if (result.rowCount !== 1) {
      const existing = await this.pool.query<{ status: string; broadcast_message_id: string | null }>(
        `SELECT status, broadcast_message_id FROM gift_requests WHERE id = $1`, [input.giftRequestId]);
      if (existing.rows[0]?.status === 'ANNOUNCED' && existing.rows[0].broadcast_message_id === input.messageId) return;
      throw new GiftError(existing.rows[0] ? 'CONFLICT' : 'NOT_FOUND', 'Gift announcement state changed.');
    }
  }

  async rejectGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; reason: string; now: Date }): Promise<{ status: 'REJECTED'; reason: string }> {
    const context=await this.getTerminationContext(input.giftRequestId);
    if(context.request.version!==input.expectedVersion||!context.request.verifiedAt)throw new GiftError('CONFLICT','Gift request is not ready for rejection.');
    await this.commitTermination({giftRequestId:input.giftRequestId,expectedGiftVersion:input.expectedVersion,expectedReservationVersion:context.reservation.version,
      terminalStatus:'REJECTED',reason:input.reason,actorStaffId:input.actorStaffId,now:input.now});return{status:'REJECTED',reason:input.reason};
  }
}

export function registerGiftRoutes(server: FastifyInstance, options: {
  store: GiftStore;
  orderStore: OrderStore;
  accountStore: AccountStore;
  walletFunding: WalletFundingService;
  broadcastChannelId: string;
  botConfigStore?:BotConfigStore;
  now?: () => Date;
  policyReader?: PolicyReader;
}): void {
  if (!server.securityOptions) throw new Error('Gift routes require security options.');
  const security = server.securityOptions;
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  const now = options.now ?? (() => new Date());

  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/gifts', permission: 'gift.request', action: 'LIST_GIFTS', targetType: 'gift_catalog',
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => listGifts({ ...options, actor, orderId: giftOrderIdQuery(request), now: now() }),
    mapError: mapGiftError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/gift-center', permission: 'gift.request', action: 'GET_STANDALONE_GIFT_CENTER', targetType: 'gift_center',
    acceptedSources: ['DISCORD_BOT'],
    handler: async (_request, actor) => getStandaloneGiftCenter({ ...options, actor, now: now() }),
    mapError: mapGiftError
  });

  registerSecureReadRoute(server, security, {
    method: 'POST', url: '/api/v1/gift-center/affordability', permission: 'gift.request',
    action: 'CHECK_STANDALONE_GIFT_AFFORDABILITY', targetType: 'gift_center', acceptedSources: ['DISCORD_BOT'],
    handler: async (request, actor) => checkStandaloneGiftAffordability({ ...options, actor,
      body: parseStandaloneGiftSelectionBody(request.body), now: now() }),
    mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/gift-center/gift-requests', permission: 'gift.request',
    action: 'CREATE_STANDALONE_GIFT_REQUEST', targetType: 'gift_center', acceptedSources: ['DISCORD_BOT'], successStatusCode: 201,
    handler: async (request, actor) => prepareStandaloneGiftRequest({ ...options, actor,
      body: parseStandaloneGiftRequestBody(request.body), idempotencyKey: request.headers['idempotency-key'] as string,
      auditSink, now: now() }),
    fingerprintBody: (request) => parseStandaloneGiftRequestBody(request.body), mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-assist/challenges', permission: 'gift.assist',
    action: 'CREATE_STAFF_GIFT_ASSIST_CHALLENGE', targetType: 'staff_gift_assist_challenge',
    acceptedSources: ['DISCORD_BOT'], successStatusCode: 201,
    handler: async (request, actor) => prepareStaffGiftAssistChallenge({ ...options, actor,
      body: parseStaffGiftAssistChallengeBody(request.body), idempotencyKey: request.headers['idempotency-key'] as string,
      auditSink, now: now() }),
    fingerprintBody: (request) => parseStaffGiftAssistChallengeBody(request.body), mapError: mapGiftError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/gift-assist/challenges/:giftAssistChallengeId', permission: 'gift.assist',
    action: 'GET_STAFF_GIFT_ASSIST_CHALLENGE', targetType: 'staff_gift_assist_challenge', targetId: giftAssistChallengeIdParam,
    acceptedSources: ['DISCORD_BOT'],
    handler: async (request, actor) => getStaffGiftAssistChallenge({ ...options, actor,
      challengeId: giftAssistChallengeIdParam(request), now: now() }), mapError: mapGiftError
  });

  registerSecureReadRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-assist/challenges/:giftAssistChallengeId/affordability', permission: 'gift.assist',
    action: 'CHECK_STAFF_GIFT_ASSIST_AFFORDABILITY', targetType: 'staff_gift_assist_challenge', targetId: giftAssistChallengeIdParam,
    acceptedSources: ['DISCORD_BOT'],
    handler: async (request, actor) => checkStaffGiftAssistAffordability({ ...options, actor,
      challengeId: giftAssistChallengeIdParam(request), body: parseStandaloneGiftSelectionBody(request.body), now: now() }),
    mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-assist/challenges/:giftAssistChallengeId/gift-requests', permission: 'gift.assist',
    action: 'CREATE_STAFF_ASSISTED_GIFT_REQUEST', targetType: 'staff_gift_assist_challenge', targetId: giftAssistChallengeIdParam,
    acceptedSources: ['DISCORD_BOT'], successStatusCode: 201,
    successReason: (request) => parseStaffAssistedGiftRequestBody(request.body).authorizationReason,
    handler: async (request, actor) => prepareStaffAssistedGiftRequest({ ...options, actor,
      challengeId: giftAssistChallengeIdParam(request), body: parseStaffAssistedGiftRequestBody(request.body),
      idempotencyKey: request.headers['idempotency-key'] as string, auditSink, now: now() }),
    fingerprintBody: (request) => parseStaffAssistedGiftRequestBody(request.body), mapError: mapGiftError
  });

  registerSecureReadRoute(server, security, {
    method: 'POST', url: '/api/v1/orders/:orderId/gift-affordability', permission: 'gift.request',
    action: 'CHECK_GIFT_AFFORDABILITY', targetType: 'order', targetId: giftOrderIdParam,
    acceptedSources: ['DISCORD_BOT'],
    handler: async (request, actor) => checkGiftAffordability({ ...options, actor,
      orderId: giftOrderIdParam(request), body: parseGiftAffordabilityBody(request.body), now: now() }),
    mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/orders/:orderId/gift-requests', permission: 'gift.request',
    action: 'CREATE_GIFT_REQUEST', targetType: 'order', targetId: giftOrderIdParam,
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    successStatusCode: 201,
    handler: async (request, actor) => prepareGiftRequest({
      ...options, actor, orderId: giftOrderIdParam(request), body: parseGiftRequestBody(request.body),
      idempotencyKey: request.headers['idempotency-key'] as string, auditSink, now: now()
    }),
    fingerprintBody: (request) => parseGiftRequestBody(request.body), mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method:'POST',url:'/api/v1/gift-requests/:giftRequestId/cancel',permission:'gift.request',action:'CANCEL_GIFT_REQUEST',targetType:'gift_request',targetId:giftRequestIdParam,
    acceptedSources:['DISCORD_BOT','DASHBOARD'],retryCommitFailures:true,handler:async(request,actor)=>{
      const binding=actor.guildId&&actor.discordUserId?await options.accountStore.findByDiscord({guildId:actor.guildId,discordUserId:actor.discordUserId}):null;
      if(!binding)throw new GiftError('PERMISSION_DENIED','A bound sender account is required.');const body=parseCancelBody(request.body);
      const prepared=await prepareGiftTermination({store:options.store,giftRequestId:giftRequestIdParam(request),expectedVersion:body.expectedVersion,
        terminalStatus:'WITHDRAWN',reason:body.reason,actorUserId:binding.userId,now:now()});
      return bindGiftTermination(prepared,auditSink);
    },fingerprintBody:(request)=>parseCancelBody(request.body),mapError:mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/staff-tasks/:staffTaskId/verify', permission: 'staff_task.verify',
    action: 'VERIFY_GIFT_TASK', targetType: 'staff_task', targetId: giftTaskIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    retryCommitFailures: true,
    handler: async (request, actor) => {
      if (!actor.actorStaffId) throw new GiftError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseVerifyBody(request.body);
      const data:Record<string,unknown>={};const operationNow=now();
      return {data,commit:async(auditRecord:AuditRecord)=>Object.assign(data,await options.store.verifyTask({ taskId: giftTaskIdParam(request), expectedVersion: body.expectedVersion,
        actorStaffId: actor.actorStaffId!, verificationMethod: body.verificationMethod, notes: body.notes, now: operationNow,auditRecord,auditSink }))};
    },
    fingerprintBody: (request) => parseVerifyBody(request.body), mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-requests/:giftRequestId/approve', permission: 'gift.approve',
    action: 'AUTHORIZE_GIFT_REQUEST', targetType: 'gift_request', targetId: giftRequestIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    requiresRecentStepUp: (_request, actor) => actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    retryCommitFailures: true,
    handler: async (request, actor) => {
      if (!actor.actorStaffId || !actor.actorLevel) throw new GiftError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseDecisionBody(request.body);
      const captureContext = await options.store.getCaptureContext(giftRequestIdParam(request));
      const approvalThresholds = await giftApprovalThresholds(options.policyReader);
      const pending = !['APPROVED','CAPTURED','ANNOUNCED'].includes(captureContext.request.status)
        && levelRank(actor.actorLevel) < levelRank(requiredGiftLevel(captureContext.request.priceMinor, approvalThresholds));
      const data: Record<string, unknown> = {};
      const operationNow=now();
      const broadcastChannelId=pending?options.broadcastChannelId:await resolveBotConfigString(options.botConfigStore,captureContext.guildId,
        'gift_broadcast_channel_id',options.broadcastChannelId);
      return { data, statusCode: pending ? 202 : 200, commit: async (auditRecord: AuditRecord) => {
        const committed=await options.store.commitApprovalDecision({giftRequestId:giftRequestIdParam(request),expectedVersion:body.expectedVersion,
          actorStaffId:actor.actorStaffId!,actorLevel:actor.actorLevel!,reason:body.reason,approvalThresholds,broadcastChannelId,
          now:operationNow,auditRecord,auditSink});
        if(committed.statusCode!==(pending?202:200))throw new GiftError('CONFLICT','Gift approval outcome changed before commit.');
        Object.assign(data,committed.data);
      }};
    },
    fingerprintBody: (request) => parseDecisionBody(request.body), mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-requests/:giftRequestId/reject', permission: 'gift.reject',
    action: 'REJECT_GIFT_REQUEST', targetType: 'gift_request', targetId: giftRequestIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    requiresRecentStepUp: (_request, actor) => actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    retryCommitFailures: true,
    handler: async (request, actor) => {
      if (!actor.actorStaffId) throw new GiftError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseDecisionBody(request.body);
      const context = await options.store.getTerminationContext(giftRequestIdParam(request));
      if (!context.request.verifiedAt) throw new GiftError('CONFLICT', 'Gift request is not ready for rejection.');
      const prepared=await prepareGiftTermination({ store: options.store,
        giftRequestId: giftRequestIdParam(request), expectedVersion: body.expectedVersion,
        terminalStatus: 'REJECTED', reason: body.reason, actorStaffId: actor.actorStaffId, now: now() });
      return bindGiftTermination(prepared,auditSink);
    },
    fingerprintBody: (request) => parseDecisionBody(request.body), mapError: mapGiftError
  });
}

export async function terminateGiftRequest(input: {
  store: GiftStore; giftRequestId: string;
  expectedVersion: number; terminalStatus: 'REJECTED' | 'WITHDRAWN' | 'EXPIRED'; reason: string;
  actorUserId?: string; actorStaffId?: string; now: Date;
}): Promise<GiftTerminationResult> {
  const prepared=await prepareGiftTermination(input);
  await prepared.commit();
  return prepared.data;
}

async function prepareGiftTermination(input: {
  store: GiftStore; giftRequestId: string;
  expectedVersion: number; terminalStatus: 'REJECTED' | 'WITHDRAWN' | 'EXPIRED'; reason: string;
  actorUserId?: string; actorStaffId?: string; now: Date;
}) {
  const { request, reservation } = await input.store.getTerminationContext(input.giftRequestId);
  if (request.status === input.terminalStatus && ['RELEASED', 'EXPIRED'].includes(reservation.status)) {
    const data=terminationResult(request, reservation, input.reason);
    return {data,commit:async(auditRecord?:AuditRecord,auditSink?:AuditSink)=>{
      if(auditRecord&&auditSink)await auditSink.append(auditRecord);
    }};
  }
  if (request.version !== input.expectedVersion || reservation.status !== 'ACTIVE'
    || !['PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED'].includes(request.status)) {
    throw new GiftError('CONFLICT', 'Gift request or reservation cannot be released.');
  }
  if (input.actorUserId && request.senderId !== input.actorUserId) {
    throw new GiftError('PERMISSION_DENIED', 'Only the sender can withdraw this gift request.');
  }
  const reservationStatus=input.terminalStatus==='EXPIRED'?'EXPIRED':'RELEASED';
  const data:GiftTerminationResult={giftRequestId:request.id,status:input.terminalStatus,reason:input.reason,
    reservation:{reservationId:reservation.id,status:reservationStatus,amountMinor:reservation.amountMinor,
      releasedMinor:reservation.amountMinor,currency:reservation.currency,version:reservation.version+1}};
  return {data,commit:(auditRecord?:AuditRecord,auditSink?:AuditSink)=>input.store.commitTermination({ giftRequestId: request.id, expectedGiftVersion: request.version,
    expectedReservationVersion: reservation.version, terminalStatus: input.terminalStatus, reason: input.reason,
    actorUserId: input.actorUserId, actorStaffId: input.actorStaffId, now: input.now,auditRecord,auditSink })};
}

function bindGiftTermination(prepared:Awaited<ReturnType<typeof prepareGiftTermination>>,auditSink:AuditSink){
  return {data:prepared.data,commit:(auditRecord:AuditRecord)=>prepared.commit(auditRecord,auditSink)};
}

export async function expireGiftRequest(input: {
  store: GiftStore; giftRequestId: string; now: Date;
}): Promise<GiftTerminationResult> {
  const context = await input.store.getTerminationContext(input.giftRequestId);
  if (context.request.status === 'EXPIRED' && context.reservation.status === 'EXPIRED') {
    return terminationResult(context.request, context.reservation, 'GIFT_REQUEST_EXPIRED');
  }
  if (Date.parse(context.request.expiresAt) > input.now.getTime()) throw new GiftError('CONFLICT', 'Gift request has not expired.');
  return terminateGiftRequest({ ...input, expectedVersion: context.request.version,
    terminalStatus: 'EXPIRED', reason: 'GIFT_REQUEST_EXPIRED' });
}

export async function captureApprovedGift(input: {
  store: GiftStore;
  broadcastChannelId: string;
  botConfigStore?:BotConfigStore;
  giftRequestId: string;
  actorStaffId?: string;
  now: Date;
}): Promise<GiftCaptureResult> {
  const existing = await input.store.findCapture(input.giftRequestId);
  if (existing) return existing;
  const context = await input.store.getCaptureContext(input.giftRequestId);
  const broadcastChannelId=await resolveBotConfigString(input.botConfigStore,context.guildId,'gift_broadcast_channel_id',input.broadcastChannelId);
  const { request, reservation } = context;
  if (request.status !== 'APPROVED' || reservation.status !== 'ACTIVE'
    || reservation.amountMinor !== request.priceMinor || reservation.currency !== request.currency) {
    throw new GiftError('CONFLICT', 'Gift is not ready for capture.');
  }
  const providerIdempotencyKey = `wallet:gift:${request.id}:capture:v1`;
  const providerTransactionRef = deterministicUuid(providerIdempotencyKey);
  return input.store.commitCapture({ giftRequestId: request.id, expectedGiftVersion: request.version,
    expectedReservationVersion: reservation.version, provider: 'INTERNAL_WALLET',
    providerTransactionRef, providerIdempotencyKey,
    actorStaffId: input.actorStaffId ?? request.approvedByStaffId ?? request.verifiedByStaffId ?? request.senderId,
    broadcastChannelId,
    senderDisplayName: context.senderDisplayName,
    receiverDisplayName: context.receiverDisplayName,
    now: input.now });
}

export function createGiftAnnouncementHandler(input: {
  store: Pick<GiftStore, 'markAnnounced'>;
  send: (message: { channelId: string; content: string; dedupeKey: string; notBefore: string }) => Promise<{ messageId: string }>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return async (job: OutboxJob): Promise<void> => {
    const payload = job.payload as Record<string, unknown>;
    if (job.type !== 'GIFT_ANNOUNCEMENT' || typeof payload.giftRequestId !== 'string'
      || typeof payload.channelId !== 'string' || typeof payload.content !== 'string') {
      throw new GiftError('VALIDATION_ERROR', 'Gift announcement payload is invalid.');
    }
    const delivered = await input.send({ channelId: payload.channelId, content: payload.content, dedupeKey: job.dedupeKey, notBefore: job.createdAt });
    await input.store.markAnnounced({ giftRequestId: payload.giftRequestId, channelId: payload.channelId,
      messageId: delivered.messageId, now: now() });
  };
}

export function createGiftExpiryHandler(input:{store:GiftStore;now?:()=>Date}){
  const now=input.now??(()=>new Date());return async(job:OutboxJob):Promise<void>=>{if(job.type!=='GIFT_EXPIRY')throw new GiftError('VALIDATION_ERROR','Expected a GIFT_EXPIRY job.');
    const payload=job.payload as Record<string,unknown>;if(typeof payload.giftRequestId!=='string')throw new GiftError('VALIDATION_ERROR','Gift expiry payload is invalid.');
    const context=await input.store.getTerminationContext(payload.giftRequestId);if(!['PENDING_REVIEW','PENDING_APPROVAL','APPROVED'].includes(context.request.status))return;
    await expireGiftRequest({store:input.store,giftRequestId:payload.giftRequestId,now:now()});};
}

export async function listGifts(input: {
  store: GiftStore; orderStore: OrderStore; accountStore: AccountStore;
  walletFunding: WalletFundingService; actor: ActorContext; orderId: string; now: Date;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  const order = await requireEligibleOrder(input.orderStore, input.orderId, binding.userId, binding.guildId, input.now);
  const walletBalance = await input.walletFunding.getBalance({ userId: binding.userId, now: input.now });
  const availableMinor = Math.max(0, walletBalance.availableMinor);
  const items = (await input.store.listActiveCatalog()).filter((item) => item.currency === 'CAT');
  const recipients = await input.store.findActiveOrderParticipants({ orderId: order.id, participantIds: [] });
  if (recipients.length === 0) throw new GiftError('GIFT_WINDOW_CLOSED', 'The order has no active player eligible to receive a gift.');
  return {
    orderId: order.id, orderPublicId: order.publicId,
    receiver: recipients.length === 1 ? { userId: recipients[0]!.playerId, displayName: recipients[0]!.displayName }
      : { userId: recipients[0]?.playerId ?? order.playerId ?? '', displayName: `${recipients.length} 位订单陪玩` },
    recipients,
    balance: walletBalance,
    items: items.map((item) => ({ id: item.id, code: item.code, name: item.name, version: item.version,
      priceMinor: item.priceMinor, currency: item.currency, affordable: item.priceMinor <= availableMinor }))
  };
}

export async function getStandaloneGiftCenter(input: {
  store: GiftStore; accountStore: AccountStore; walletFunding: WalletFundingService;
  actor: ActorContext; now: Date; botConfigStore?: BotConfigStore;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, binding.guildId);
  const [balance, recipients, catalog] = await Promise.all([
    input.walletFunding.getBalance({ userId: binding.userId, now: input.now }),
    input.store.listStandaloneRecipients({ guildId: binding.guildId }),
    input.store.listActiveCatalog()
  ]);
  const items = catalog.filter((item) => item.currency === 'CAT');
  return {
    recipients: recipients.map((recipient) => ({ playerProfileId: recipient.playerProfileId, displayName: recipient.displayName })),
    balance,
    items: items.map((item) => ({ id: item.id, code: item.code, name: item.name, version: item.version,
      priceMinor: item.priceMinor, currency: item.currency, affordable: item.priceMinor <= balance.availableMinor }))
  };
}

export async function checkStandaloneGiftAffordability(input: {
  store: GiftStore; accountStore: AccountStore; walletFunding: WalletFundingService;
  actor: ActorContext; body: { playerProfileId: string; giftCatalogVersionId: string }; now: Date; botConfigStore?: BotConfigStore;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, binding.guildId);
  const [recipient, catalog, balance] = await Promise.all([
    input.store.findStandaloneRecipient({ guildId: binding.guildId, playerProfileId: input.body.playerProfileId }),
    input.store.findCatalogVersion(input.body.giftCatalogVersionId),
    input.walletFunding.getBalance({ userId: binding.userId, now: input.now })
  ]);
  if (!recipient) throw new GiftError('NOT_FOUND', 'Eligible gift recipient was not found.');
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  if (catalog.currency !== balance.currency) throw new GiftError('VALIDATION_ERROR', 'Gift currency does not match the account.');
  const shortfallMinor = Math.max(0, catalog.priceMinor - balance.availableMinor);
  return {
    playerProfileId: recipient.playerProfileId, giftCatalogVersionId: catalog.id, catalogVersion: catalog.version,
    priceMinor: catalog.priceMinor, recipientCount: 1, totalPriceMinor: catalog.priceMinor,
    ledgerBalanceMinor: balance.ledgerBalanceMinor, reservedMinor: balance.reservedMinor,
    availableMinor: balance.availableMinor, shortfallMinor, currency: balance.currency, calculatedAt: balance.calculatedAt,
    stale: false as const, canAfford: shortfallMinor === 0, topUpInstructions: '联系客服并提交付款 receipt。'
  };
}

async function prepareStandaloneGiftRequest(input: {
  store: GiftStore; accountStore: AccountStore; walletFunding: WalletFundingService;
  actor: ActorContext; auditSink: AuditSink;
  body: { playerProfileId: string; giftCatalogVersionId: string; expectedCatalogVersion: number; expectedPriceMinor: number; anonymous: boolean };
  idempotencyKey: string; now: Date; botConfigStore?: BotConfigStore;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, binding.guildId);
  const [recipient, catalog, balance] = await Promise.all([
    input.store.findStandaloneRecipient({ guildId: binding.guildId, playerProfileId: input.body.playerProfileId }),
    input.store.findCatalogVersion(input.body.giftCatalogVersionId),
    input.walletFunding.getBalance({ userId: binding.userId, now: input.now })
  ]);
  if (!recipient) throw new GiftError('NOT_FOUND', 'Eligible gift recipient was not found.');
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  if (catalog.version !== input.body.expectedCatalogVersion || catalog.priceMinor !== input.body.expectedPriceMinor) {
    throw new GiftError('GIFT_CATALOG_CHANGED', 'Gift catalog changed; check affordability and confirm again.');
  }
  if (catalog.currency !== 'CAT' || balance.currency !== catalog.currency) {
    throw new GiftError('VALIDATION_ERROR', 'Gift currency does not match the account.');
  }
  if (balance.availableMinor < catalog.priceMinor) {
    const availableMinor = Math.max(0, balance.availableMinor);
    throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.', [
      { field: 'availableMinor', reason: String(availableMinor) },
      { field: 'shortfallMinor', reason: String(catalog.priceMinor - availableMinor) },
      { field: 'topUpAction', reason: 'CONTACT_SUPPORT_WITH_RECEIPT' }
    ]);
  }
  const requestId = deterministicUuid(`gift-request:${binding.userId}:${binding.guildId}:standalone:${input.idempotencyKey}`);
  const expiresAt = new Date(input.now.getTime() + 30 * 60_000).toISOString();
  const request: GiftRequestRecord = {
    id: requestId, publicId: `G-${requestId.slice(0, 8).toUpperCase()}`, guildId: binding.guildId,
    origin: 'STANDALONE', senderVisibility: input.body.anonymous ? 'ANONYMOUS' : 'PUBLIC', orderId: null, participantId: null,
    giftCatalogVersionId: catalog.id, senderId: binding.userId, receiverId: recipient.userId,
    status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: catalog.code, giftNameSnapshot: catalog.name,
    priceMinor: catalog.priceMinor, currency: catalog.currency, broadcastTemplateSnapshot: catalog.broadcastTemplate,
    expiresAt, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  const draft = buildFundReservationDraft({ businessSource: { type: 'GIFT', referenceId: request.id }, userId: binding.userId,
    provider: null, mode: 'LOCAL_RESERVATION', amountMinor: catalog.priceMinor, currency: 'CAT',
    idempotencyKey: `${input.idempotencyKey}:recipient:1`, ttlMinutes: 30, now: input.now });
  const reservation: GiftReservationRecord = { ...draft, sourceType: 'GIFT', orderId: null, giftRequestId: request.id,
    status: 'ACTIVE', version: 2, providerHoldRef: null, activatedAt: input.now.toISOString() };
  const staffTask: GiftStaffTaskRecord = {
    id: deterministicUuid(`gift-task:${request.id}`), publicId: `T-GIFT-${request.publicId.slice(2)}`,
    type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: 'OPEN', version: 1, orderId: null,
    giftRequestId: request.id, voiceChannelId: null,
    contextSnapshot: { source: 'STANDALONE', orderId: null, orderPublicId: null, channelId: null, voiceChannelId: null,
      senderId: binding.userId, receiverId: recipient.userId, giftCode: catalog.code, giftName: catalog.name,
      priceMinor: catalog.priceMinor, currency: catalog.currency, reservationId: reservation.id },
    createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  return {
    data: { origin: 'STANDALONE', senderVisibility: request.senderVisibility, orderId: null,
      playerProfileId: recipient.playerProfileId, receiverId: recipient.userId, id: request.id, publicId: request.publicId,
      status: request.status, expiresAt, gift: { code: catalog.code, name: catalog.name, priceMinor: catalog.priceMinor, currency: catalog.currency },
      reservation: { id: reservation.id, status: reservation.status, amountMinor: reservation.amountMinor, currency: reservation.currency, expiresAt },
      staffTask: { id: staffTask.id, publicId: staffTask.publicId, type: staffTask.type, status: staffTask.status },
      balance: { ...balance, reservedMinor: balance.reservedMinor + catalog.priceMinor,
        availableMinor: balance.ledgerBalanceMinor - balance.reservedMinor - catalog.priceMinor } },
    statusCode: 201,
    commit: (auditRecord: AuditRecord) => input.store.commitCreateBatch({ items: [{ request, reservation, staffTask }],
      standalonePlayerProfileId: recipient.playerProfileId, ledgerBalanceMinor: balance.ledgerBalanceMinor,
      expectedGuildId: binding.guildId, now: input.now, auditRecord, auditSink: input.auditSink })
  };
}

async function prepareStaffGiftAssistChallenge(input: {
  store: GiftStore; accountStore: AccountStore; walletFunding: WalletFundingService;
  actor: ActorContext; auditSink: AuditSink; botConfigStore?: BotConfigStore;
  body: { customerDiscordUserId: string; authorizationChannelId: string; authorizationMessageId: string };
  idempotencyKey: string; now: Date;
}) {
  const staff = requireStaffGiftActor(input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, staff.guildId);
  const customer = await input.accountStore.findByDiscord({ guildId: staff.guildId, discordUserId: input.body.customerDiscordUserId });
  if (!customer || customer.userStatus !== 'ACTIVE') throw new GiftError('NOT_FOUND', 'An active same-Guild customer was not found.');
  const id = deterministicUuid(`gift-assist:${staff.staffId}:${staff.guildId}:${input.idempotencyKey}`);
  const challenge: StaffGiftAssistChallengeRecord = {
    id, guildId: staff.guildId, staffAccountId: staff.staffId, staffDiscordUserId: staff.discordUserId,
    permissionsVersion: staff.permissionsVersion, customerUserId: customer.userId,
    customerDiscordUserId: customer.discordUserId, customerDisplayName: customer.displayName,
    authorizationChannelId: input.body.authorizationChannelId, authorizationMessageId: input.body.authorizationMessageId,
    authorizationReason: null, failedAttempts: 0, expiresAt: new Date(input.now.getTime() + 10 * 60_000).toISOString(),
    consumedAt: null, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  const center = await buildStaffGiftAssistCenter({ ...input, challenge, now: input.now });
  return {
    data: center, statusCode: 201,
    commit: (auditRecord: AuditRecord) => input.store.commitCreateStaffGiftAssistChallenge({ challenge, auditRecord, auditSink: input.auditSink })
  };
}

async function getStaffGiftAssistChallenge(input: {
  store: GiftStore; walletFunding: WalletFundingService; actor: ActorContext;
  challengeId: string; now: Date; botConfigStore?: BotConfigStore;
}) {
  const staff = requireStaffGiftActor(input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, staff.guildId);
  const challenge = await input.store.findStaffGiftAssistChallenge({ id: input.challengeId, actorStaffId: staff.staffId,
    guildId: staff.guildId, permissionsVersion: staff.permissionsVersion, now: input.now });
  if (!challenge) throw new GiftError('NOT_FOUND', 'Gift assist challenge was not found.');
  return buildStaffGiftAssistCenter({ ...input, challenge, now: input.now });
}

async function buildStaffGiftAssistCenter(input: {
  store: GiftStore; walletFunding: WalletFundingService; challenge: StaffGiftAssistChallengeRecord; now: Date;
}) {
  const [balance, recipients, catalog] = await Promise.all([
    input.walletFunding.getBalance({ userId: input.challenge.customerUserId, now: input.now }),
    input.store.listStandaloneRecipients({ guildId: input.challenge.guildId }),
    input.store.listActiveCatalog()
  ]);
  const items = catalog.filter((item) => item.currency === 'CAT');
  return {
    id: input.challenge.id, customer: { displayName: input.challenge.customerDisplayName },
    recipients: recipients.map((recipient) => ({ playerProfileId: recipient.playerProfileId, displayName: recipient.displayName })),
    balance, items: items.map((item) => ({ id: item.id, code: item.code, name: item.name, version: item.version,
      priceMinor: item.priceMinor, currency: item.currency, affordable: item.priceMinor <= balance.availableMinor })),
    failedAttempts: input.challenge.failedAttempts, expiresAt: input.challenge.expiresAt
  };
}

async function checkStaffGiftAssistAffordability(input: {
  store: GiftStore; walletFunding: WalletFundingService; actor: ActorContext;
  challengeId: string; body: { playerProfileId: string; giftCatalogVersionId: string };
  now: Date; botConfigStore?: BotConfigStore;
}) {
  const staff = requireStaffGiftActor(input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, staff.guildId);
  const challenge = await input.store.findStaffGiftAssistChallenge({ id: input.challengeId, actorStaffId: staff.staffId,
    guildId: staff.guildId, permissionsVersion: staff.permissionsVersion, now: input.now });
  if (!challenge) throw new GiftError('NOT_FOUND', 'Gift assist challenge was not found.');
  const [recipient, catalog, balance] = await Promise.all([
    input.store.findStandaloneRecipient({ guildId: staff.guildId, playerProfileId: input.body.playerProfileId }),
    input.store.findCatalogVersion(input.body.giftCatalogVersionId),
    input.walletFunding.getBalance({ userId: challenge.customerUserId, now: input.now })
  ]);
  if (!recipient) throw new GiftError('NOT_FOUND', 'Eligible gift recipient was not found.');
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  if (catalog.currency !== balance.currency) throw new GiftError('VALIDATION_ERROR', 'Gift currency does not match the account.');
  const shortfallMinor = Math.max(0, catalog.priceMinor - balance.availableMinor);
  return { playerProfileId: recipient.playerProfileId, giftCatalogVersionId: catalog.id, catalogVersion: catalog.version,
    priceMinor: catalog.priceMinor, recipientCount: 1, totalPriceMinor: catalog.priceMinor,
    ledgerBalanceMinor: balance.ledgerBalanceMinor, reservedMinor: balance.reservedMinor, availableMinor: balance.availableMinor,
    shortfallMinor, currency: balance.currency, calculatedAt: balance.calculatedAt, stale: false as const,
    canAfford: shortfallMinor === 0, topUpInstructions: '联系客服并提交付款 receipt。' };
}

async function prepareStaffAssistedGiftRequest(input: {
  store: GiftStore; walletFunding: WalletFundingService; actor: ActorContext; auditSink: AuditSink;
  challengeId: string; botConfigStore?: BotConfigStore; idempotencyKey: string; now: Date;
  body: { playerProfileId: string; giftCatalogVersionId: string; expectedCatalogVersion: number;
    expectedPriceMinor: number; anonymous: boolean; authorizationReason: string; totpCode: string };
}) {
  const staff = requireStaffGiftActor(input.actor);
  await requireStandaloneGiftEnabled(input.botConfigStore, staff.guildId);
  const challenge = await input.store.findStaffGiftAssistChallenge({ id: input.challengeId, actorStaffId: staff.staffId,
    guildId: staff.guildId, permissionsVersion: staff.permissionsVersion, now: input.now });
  if (!challenge) throw new GiftError('NOT_FOUND', 'Gift assist challenge was not found.');
  const [recipient, catalog, balance] = await Promise.all([
    input.store.findStandaloneRecipient({ guildId: staff.guildId, playerProfileId: input.body.playerProfileId }),
    input.store.findCatalogVersion(input.body.giftCatalogVersionId),
    input.walletFunding.getBalance({ userId: challenge.customerUserId, now: input.now })
  ]);
  if (!recipient) throw new GiftError('NOT_FOUND', 'Eligible gift recipient was not found.');
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  if (catalog.version !== input.body.expectedCatalogVersion || catalog.priceMinor !== input.body.expectedPriceMinor)
    throw new GiftError('GIFT_CATALOG_CHANGED', 'Gift catalog changed; check affordability and confirm again.');
  if (catalog.currency !== 'CAT' || balance.currency !== catalog.currency)
    throw new GiftError('VALIDATION_ERROR', 'Gift currency does not match the account.');
  if (balance.availableMinor < catalog.priceMinor) {
    const availableMinor = Math.max(0, balance.availableMinor);
    throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.', [
      { field: 'availableMinor', reason: String(availableMinor) },
      { field: 'shortfallMinor', reason: String(catalog.priceMinor - availableMinor) },
      { field: 'topUpAction', reason: 'CONTACT_SUPPORT_WITH_RECEIPT' }
    ]);
  }
  const requestId = deterministicUuid(`gift-request:${challenge.customerUserId}:${staff.guildId}:assist:${input.challengeId}`);
  const expiresAt = new Date(input.now.getTime() + 30 * 60_000).toISOString();
  const request: GiftRequestRecord = {
    id: requestId, publicId: `G-${requestId.slice(0, 8).toUpperCase()}`, guildId: staff.guildId,
    origin: 'STANDALONE', senderVisibility: input.body.anonymous ? 'ANONYMOUS' : 'PUBLIC',
    initiatorMode: 'STAFF_ASSISTED', assistedByStaffId: staff.staffId, giftAssistChallengeId: challenge.id,
    orderId: null, participantId: null, giftCatalogVersionId: catalog.id, senderId: challenge.customerUserId,
    receiverId: recipient.userId, status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: catalog.code,
    giftNameSnapshot: catalog.name, priceMinor: catalog.priceMinor, currency: catalog.currency,
    broadcastTemplateSnapshot: catalog.broadcastTemplate, expiresAt, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  const draft = buildFundReservationDraft({ businessSource: { type: 'GIFT', referenceId: request.id },
    userId: challenge.customerUserId, provider: null, mode: 'LOCAL_RESERVATION', amountMinor: catalog.priceMinor,
    currency: 'CAT', idempotencyKey: `${input.idempotencyKey}:recipient:1`, ttlMinutes: 30, now: input.now });
  const reservation: GiftReservationRecord = { ...draft, sourceType: 'GIFT', orderId: null, giftRequestId: request.id,
    status: 'ACTIVE', version: 2, providerHoldRef: null, activatedAt: input.now.toISOString() };
  const staffTask: GiftStaffTaskRecord = {
    id: deterministicUuid(`gift-task:${request.id}`), publicId: `T-GIFT-${request.publicId.slice(2)}`,
    type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: 'OPEN', version: 1, orderId: null,
    giftRequestId: request.id, voiceChannelId: null,
    contextSnapshot: { source: 'STANDALONE', initiatorMode: 'STAFF_ASSISTED', assistedByStaffId: staff.staffId,
      giftAssistChallengeId: challenge.id, authorizationChannelId: challenge.authorizationChannelId,
      authorizationMessageId: challenge.authorizationMessageId, authorizationReason: input.body.authorizationReason,
      orderId: null, orderPublicId: null, channelId: null, voiceChannelId: null, senderId: challenge.customerUserId,
      receiverId: recipient.userId, giftCode: catalog.code, giftName: catalog.name, priceMinor: catalog.priceMinor,
      currency: catalog.currency, reservationId: reservation.id },
    createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  return {
    data: { origin: 'STANDALONE', initiatorMode: 'STAFF_ASSISTED', assistedByStaffId: staff.staffId,
      giftAssistChallengeId: challenge.id, senderVisibility: request.senderVisibility, orderId: null,
      playerProfileId: recipient.playerProfileId, receiverId: recipient.userId, id: request.id, publicId: request.publicId,
      status: request.status, expiresAt, gift: { code: catalog.code, name: catalog.name, priceMinor: catalog.priceMinor, currency: catalog.currency },
      reservation: { id: reservation.id, status: reservation.status, amountMinor: reservation.amountMinor, currency: reservation.currency, expiresAt },
      staffTask: { id: staffTask.id, publicId: staffTask.publicId, type: staffTask.type, status: staffTask.status },
      balance: { ...balance, reservedMinor: balance.reservedMinor + catalog.priceMinor,
        availableMinor: balance.ledgerBalanceMinor - balance.reservedMinor - catalog.priceMinor } },
    statusCode: 201,
    commit: (auditRecord: AuditRecord) => input.store.commitCreateBatch({ items: [{ request, reservation, staffTask }],
      standalonePlayerProfileId: recipient.playerProfileId, ledgerBalanceMinor: balance.ledgerBalanceMinor,
      expectedGuildId: staff.guildId, now: input.now, auditRecord, auditSink: input.auditSink,
      staffAssist: { challengeId: challenge.id, actorStaffId: staff.staffId, actorDiscordUserId: staff.discordUserId,
        permissionsVersion: staff.permissionsVersion, authorizationReason: input.body.authorizationReason, totpCode: input.body.totpCode } })
  };
}

function requireStaffGiftActor(actor: ActorContext) {
  if (!actor.actorStaffId || !actor.guildId || !actor.discordUserId || actor.permissionsVersion == null)
    throw new GiftError('PERMISSION_DENIED', 'An approved Discord staff account is required.');
  return { staffId: actor.actorStaffId, guildId: actor.guildId, discordUserId: actor.discordUserId,
    permissionsVersion: actor.permissionsVersion };
}

async function requireStandaloneGiftEnabled(store: BotConfigStore | undefined, guildId: string) {
  if (!await resolveBotConfigBoolean(store, guildId, 'gift_requests_enabled', true))
    throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift requests are currently paused.');
}

export interface GiftAffordabilityResult {
  giftCatalogVersionId: string; catalogVersion: number; priceMinor: number; recipientCount: number; totalPriceMinor: number;
  ledgerBalanceMinor: number; reservedMinor: number; availableMinor: number; shortfallMinor: number;
  currency: string; calculatedAt: string; stale: false; canAfford: boolean; topUpInstructions: string;
}

export async function checkGiftAffordability(input: {
  store: GiftStore; orderStore: OrderStore; accountStore: AccountStore;
  walletFunding: WalletFundingService;
  actor: ActorContext; orderId: string; body: { giftCatalogVersionId: string; participantIds: string[] }; now: Date;
}): Promise<GiftAffordabilityResult> {
  const binding = await requireBinding(input.accountStore, input.actor);
  await requireEligibleOrder(input.orderStore, input.orderId, binding.userId, binding.guildId, input.now);
  const catalog = await input.store.findCatalogVersion(input.body.giftCatalogVersionId);
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  const participantIds = [...new Set(input.body.participantIds)];
  const recipients = await input.store.findActiveOrderParticipants({ orderId: input.orderId, participantIds });
  if (recipients.length !== participantIds.length) throw new GiftError('CONFLICT', 'One or more selected players are no longer active on this order.');
  const balance = await input.walletFunding.getBalance({ userId: binding.userId, now: input.now });
  if (balance.currency !== catalog.currency) throw new GiftError('VALIDATION_ERROR', 'Gift currency does not match the account.');
  const reservedMinor = balance.reservedMinor;
  const availableMinor = balance.availableMinor;
  const totalPriceMinor = catalog.priceMinor * recipients.length;
  if (!Number.isSafeInteger(totalPriceMinor)) throw new GiftError('VALIDATION_ERROR', 'Gift total is outside the supported range.');
  const shortfallMinor = Math.max(0, totalPriceMinor - availableMinor);
  return { giftCatalogVersionId: catalog.id, catalogVersion: catalog.version, priceMinor: catalog.priceMinor,
    recipientCount: recipients.length, totalPriceMinor,
    ledgerBalanceMinor: balance.ledgerBalanceMinor, reservedMinor, availableMinor, shortfallMinor,
    currency: balance.currency, calculatedAt: balance.calculatedAt, stale: false, canAfford: shortfallMinor === 0,
    topUpInstructions: '联系客服并提交付款 receipt。' };
}

async function prepareGiftRequest(input: {
  store: GiftStore; orderStore: OrderStore; accountStore: AccountStore;
  walletFunding: WalletFundingService;
  actor: ActorContext; orderId: string;
  auditSink: AuditSink;
  body: { expectedOrderVersion: number; giftCatalogVersionId: string; participantIds: string[]; expectedCatalogVersion?: number; expectedPriceMinor?: number };
  idempotencyKey: string; now: Date;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  const order = await requireEligibleOrder(input.orderStore, input.orderId, binding.userId, binding.guildId, input.now);
  if (order.version !== input.body.expectedOrderVersion) throw new GiftError('CONFLICT', 'Order changed; refresh before retrying.');
  const catalog = await input.store.findCatalogVersion(input.body.giftCatalogVersionId);
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  if (input.body.expectedCatalogVersion !== undefined && (catalog.version !== input.body.expectedCatalogVersion
    || catalog.priceMinor !== input.body.expectedPriceMinor)) {
    throw new GiftError('GIFT_CATALOG_CHANGED', 'Gift catalog changed; check affordability and confirm again.');
  }
  const participantIds = [...new Set(input.body.participantIds)];
  const recipients = await input.store.findActiveOrderParticipants({ orderId: order.id, participantIds });
  const recipientById = new Map(recipients.map((recipient) => [recipient.participantId, recipient]));
  if (recipients.length !== participantIds.length || participantIds.some((participantId) => !recipientById.has(participantId))) {
    throw new GiftError('CONFLICT', 'One or more selected players are no longer active on this order.');
  }
  const walletBalance = await input.walletFunding.getBalance({ userId: binding.userId, now: input.now });
  if (catalog.currency !== 'CAT') throw new GiftError('VALIDATION_ERROR', 'Gifts must use CAT.');
  const reservedMinor = walletBalance.reservedMinor;
  const totalAmountMinor = catalog.priceMinor * recipients.length;
  if (!Number.isSafeInteger(totalAmountMinor)) throw new GiftError('VALIDATION_ERROR', 'Gift total is outside the supported range.');
  if (walletBalance.availableMinor < totalAmountMinor) {
    const availableMinor=Math.max(0,walletBalance.availableMinor);
    throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.',[
      {field:'availableMinor',reason:String(availableMinor)},{field:'shortfallMinor',reason:String(totalAmountMinor-availableMinor)},
      {field:'topUpAction',reason:'CONTACT_SUPPORT_WITH_RECEIPT'}]);
  }

  const expiresAt = new Date(input.now.getTime() + 30 * 60_000).toISOString();
  const mode: FundReservationMode = 'LOCAL_RESERVATION';
  const items = participantIds.map((participantId, index) => {
    const recipient = recipientById.get(participantId)!;
    const requestId = deterministicUuid(`gift-request:${binding.userId}:${order.id}:${input.idempotencyKey}:${participantId}`);
    const request: GiftRequestRecord = {
      id: requestId, publicId: `G-${requestId.slice(0, 8).toUpperCase()}`, guildId: binding.guildId,
      origin: 'ORDER', senderVisibility: 'PUBLIC', orderId: order.id, participantId,
      giftCatalogVersionId: catalog.id, senderId: binding.userId, receiverId: recipient.playerId,
      status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: catalog.code, giftNameSnapshot: catalog.name,
      priceMinor: catalog.priceMinor, currency: catalog.currency, broadcastTemplateSnapshot: catalog.broadcastTemplate,
      expiresAt, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
    };
    const itemKey = `${input.idempotencyKey}:recipient:${index + 1}`;
    const draft = buildFundReservationDraft({ businessSource: { type: 'GIFT', referenceId: request.id }, userId: binding.userId,
      provider: null, mode, amountMinor: catalog.priceMinor, currency: 'CAT', idempotencyKey: itemKey, ttlMinutes: 30, now: input.now });
    const reservation: GiftReservationRecord = { ...draft, sourceType: 'GIFT', orderId: null, giftRequestId: request.id,
      status: 'ACTIVE', version: 2, providerHoldRef: null, activatedAt: input.now.toISOString() };
    const staffTask: GiftStaffTaskRecord = {
      id: deterministicUuid(`gift-task:${request.id}`), publicId: `T-GIFT-${request.publicId.slice(2)}`,
      type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: 'OPEN', version: 1,
      orderId: order.id, giftRequestId: request.id, voiceChannelId: order.channelSpec.voiceChannelId,
      contextSnapshot: { source: 'ORDER', orderId: order.id, orderPublicId: order.publicId, channelId: order.channelSpec.channelId,
        voiceChannelId: order.channelSpec.voiceChannelId, senderId: binding.userId, receiverId: recipient.playerId,
        giftCode: catalog.code, giftName: catalog.name, priceMinor: catalog.priceMinor, currency: catalog.currency, reservationId: reservation.id },
      createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
    };
    return { request, reservation, staffTask };
  });
  return {
    data: { unitPriceMinor: catalog.priceMinor, recipientCount: items.length, totalAmountMinor,
      items: items.map((item, index) => toGiftRequestResult(item.request, item.reservation, item.staffTask,
        walletBalance, reservedMinor + catalog.priceMinor * index)) }, statusCode: 201,
    commit: async (auditRecord: AuditRecord) => {
      await input.store.commitCreateBatch({ items, ledgerBalanceMinor: walletBalance.ledgerBalanceMinor,
        expectedOrderVersion: input.body.expectedOrderVersion, expectedGuildId: binding.guildId,
        now: input.now, auditRecord, auditSink: input.auditSink });
    }
  };
}

function toGiftRequestResult(request: GiftRequestRecord, reservation: GiftReservationRecord, task: GiftStaffTaskRecord,
  walletBalance: WalletBalance, priorReservedMinor: number) {
  return {
    id: request.id, publicId: request.publicId, orderId: request.orderId, participantId: request.participantId, senderId: request.senderId,
    receiverId: request.receiverId, status: request.status, expiresAt: request.expiresAt,
    gift: { code: request.giftCodeSnapshot, name: request.giftNameSnapshot, priceMinor: request.priceMinor, currency: request.currency },
    reservation: { id: reservation.id, sourceType: reservation.sourceType, status: reservation.status, amountMinor: reservation.amountMinor, currency: reservation.currency, expiresAt: reservation.expiresAt },
    staffTask: { id: task.id, publicId: task.publicId, type: task.type, status: task.status },
    balance: { ...walletBalance, reservedMinor: priorReservedMinor + request.priceMinor,
      availableMinor: walletBalance.ledgerBalanceMinor - priorReservedMinor - request.priceMinor }
  };
}

async function requireBinding(store: AccountStore, actor: ActorContext) {
  if (!actor.guildId || !actor.discordUserId) throw new GiftError('PERMISSION_DENIED', 'A bound customer is required.');
  const binding = await store.findByDiscord({ guildId: actor.guildId, discordUserId: actor.discordUserId });
  if (!binding) throw new GiftError('PERMISSION_DENIED', 'A bound customer is required.');
  return binding;
}

async function requireEligibleOrder(store: OrderStore, orderId: string, customerId: string, guildId: string, now: Date): Promise<OrderRecord> {
  const order = await store.findById(orderId);
  if (!order || order.customerId !== customerId || order.guildId !== guildId) throw new GiftError('NOT_FOUND', 'Order was not found.');
  if (['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(order.status)) return order;
  if (order.status === 'COMPLETED' && order.completedAt && now.getTime() - Date.parse(order.completedAt) <= 24 * 60 * 60_000) return order;
  throw new GiftError('GIFT_WINDOW_CLOSED', 'Gift requests are closed for this order.');
}

function parseGiftRequestBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || !Number.isInteger(body.expectedOrderVersion) || typeof body.giftCatalogVersionId !== 'string'
    || !Array.isArray(body.participantIds) || body.participantIds.length < 1 || body.participantIds.some((id) => typeof id !== 'string')
    || !Number.isSafeInteger(body.expectedCatalogVersion) || !Number.isSafeInteger(body.expectedPriceMinor)
    || Object.keys(body).some((key) => !['expectedOrderVersion','giftCatalogVersionId','participantIds','expectedCatalogVersion','expectedPriceMinor'].includes(key))) {
    throw new GiftError('VALIDATION_ERROR', 'Current order, catalog version, and price confirmation are required.');
  }
  return { expectedOrderVersion: body.expectedOrderVersion as number, giftCatalogVersionId: body.giftCatalogVersionId,
    participantIds: body.participantIds as string[],
    expectedCatalogVersion: body.expectedCatalogVersion as number | undefined, expectedPriceMinor: body.expectedPriceMinor as number | undefined };
}

function parseGiftAffordabilityBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || typeof body.giftCatalogVersionId !== 'string' || !Array.isArray(body.participantIds) || body.participantIds.length < 1
    || body.participantIds.some((id) => typeof id !== 'string')
    || Object.keys(body).some((key) => !['giftCatalogVersionId','participantIds'].includes(key))) {
    throw new GiftError('VALIDATION_ERROR', 'giftCatalogVersionId and participantIds are required.');
  }
  return { giftCatalogVersionId: body.giftCatalogVersionId, participantIds: body.participantIds as string[] };
}

function parseStandaloneGiftSelectionBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || typeof body.playerProfileId !== 'string' || typeof body.giftCatalogVersionId !== 'string'
    || Object.keys(body).some((key) => !['playerProfileId', 'giftCatalogVersionId'].includes(key))) {
    throw new GiftError('VALIDATION_ERROR', 'playerProfileId and giftCatalogVersionId are required.');
  }
  return { playerProfileId: body.playerProfileId, giftCatalogVersionId: body.giftCatalogVersionId };
}

function parseStandaloneGiftRequestBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || typeof body.playerProfileId !== 'string' || typeof body.giftCatalogVersionId !== 'string'
    || !Number.isSafeInteger(body.expectedCatalogVersion) || !Number.isSafeInteger(body.expectedPriceMinor)
    || typeof body.anonymous !== 'boolean'
    || Object.keys(body).some((key) => !['playerProfileId', 'giftCatalogVersionId', 'expectedCatalogVersion', 'expectedPriceMinor', 'anonymous'].includes(key))) {
    throw new GiftError('VALIDATION_ERROR', 'Current player, catalog version, price, and anonymous selection are required.');
  }
  return { playerProfileId: body.playerProfileId, giftCatalogVersionId: body.giftCatalogVersionId,
    expectedCatalogVersion: body.expectedCatalogVersion as number, expectedPriceMinor: body.expectedPriceMinor as number,
    anonymous: body.anonymous };
}

function parseStaffGiftAssistChallengeBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || !isDiscordSnowflake(body.customerDiscordUserId) || !isDiscordSnowflake(body.authorizationChannelId)
    || !isDiscordSnowflake(body.authorizationMessageId)
    || Object.keys(body).some((key) => !['customerDiscordUserId', 'authorizationChannelId', 'authorizationMessageId'].includes(key))) {
    throw new GiftError('VALIDATION_ERROR', 'Customer and authorization message identifiers are required.');
  }
  return { customerDiscordUserId: body.customerDiscordUserId, authorizationChannelId: body.authorizationChannelId,
    authorizationMessageId: body.authorizationMessageId };
}

function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/u.test(value);
}

function parseStaffAssistedGiftRequestBody(value: unknown) {
  const body = value as Record<string, unknown>;
  const authorizationReason = typeof body?.authorizationReason === 'string' ? body.authorizationReason.trim() : '';
  if (!body || typeof body.playerProfileId !== 'string' || typeof body.giftCatalogVersionId !== 'string'
    || !Number.isSafeInteger(body.expectedCatalogVersion) || !Number.isSafeInteger(body.expectedPriceMinor)
    || typeof body.anonymous !== 'boolean' || authorizationReason.length < 3 || authorizationReason.length > 1000
    || typeof body.totpCode !== 'string' || !/^\d{6}$/.test(body.totpCode)
    || Object.keys(body).some((key) => !['playerProfileId', 'giftCatalogVersionId', 'expectedCatalogVersion', 'expectedPriceMinor',
      'anonymous', 'authorizationReason', 'totpCode'].includes(key))) {
    throw new GiftError('VALIDATION_ERROR', 'Current player, catalog, price, anonymous selection, reason, and six-digit TOTP are required.');
  }
  return { playerProfileId: body.playerProfileId, giftCatalogVersionId: body.giftCatalogVersionId,
    expectedCatalogVersion: body.expectedCatalogVersion as number, expectedPriceMinor: body.expectedPriceMinor as number,
    anonymous: body.anonymous, authorizationReason, totpCode: body.totpCode };
}

function parseVerifyBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || !Number.isInteger(body.expectedVersion) || typeof body.verificationMethod !== 'string'
    || typeof body.notes !== 'string' || body.notes.trim().length < 3) {
    throw new GiftError('VALIDATION_ERROR', 'expectedVersion, verificationMethod, and notes are required.');
  }
  return { expectedVersion: body.expectedVersion as number, verificationMethod: body.verificationMethod, notes: body.notes.trim() };
}

function parseDecisionBody(value: unknown) {
  const body = value as Record<string, unknown>;
  const reason = typeof body?.reason === 'string'
    ? body.reason
    : [body?.reasonCode, body?.note].filter((part): part is string => typeof part === 'string').join(': ');
  if (!body || !Number.isInteger(body.expectedVersion) || reason.trim().length < 3) {
    throw new GiftError('VALIDATION_ERROR', 'expectedVersion and reason are required.');
  }
  return { expectedVersion: body.expectedVersion as number, reason: reason.trim() };
}

function parseCancelBody(value: unknown) {
  const body=value as Record<string,unknown>;const reason=[body?.reasonCode,body?.note]
    .filter((part):part is string=>typeof part==='string').join(': ').trim();
  if(!body||!Number.isInteger(body.expectedVersion)||reason.length<3)throw new GiftError('VALIDATION_ERROR','expectedVersion and reasonCode are required.');
  return{expectedVersion:body.expectedVersion as number,reason};
}

function giftOrderIdParam(request: FastifyRequest): string {
  const id = (request.params as { orderId?: unknown }).orderId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'orderId is required.');
  return id;
}

function giftOrderIdQuery(request: FastifyRequest): string {
  const id = (request.query as { orderId?: unknown }).orderId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'orderId is required.');
  return id;
}

function giftTaskIdParam(request: FastifyRequest): string {
  const id = (request.params as { staffTaskId?: unknown }).staffTaskId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'staffTaskId is required.');
  return id;
}

function giftRequestIdParam(request: FastifyRequest): string {
  const id = (request.params as { giftRequestId?: unknown }).giftRequestId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'giftRequestId is required.');
  return id;
}

function giftAssistChallengeIdParam(request: FastifyRequest): string {
  const id = (request.params as { giftAssistChallengeId?: unknown }).giftAssistChallengeId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'giftAssistChallengeId is required.');
  return id;
}

function mapGiftError(error: unknown) {
  if (!(error instanceof GiftError)) return null;
  const statusCode = error.code === 'NOT_FOUND' ? 404
    : ['PERMISSION_DENIED', 'MFA_REQUIRED', 'MFA_INVALID'].includes(error.code) ? 403 : error.code === 'VALIDATION_ERROR' ? 400
    : error.code === 'INSUFFICIENT_AVAILABLE_BALANCE' ? 422
      : 409;
  return { statusCode, code: error.code, message: error.message, details: error.details };
}

function deterministicUuid(seed: string): string {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${bytes.subarray(0, 4).toString('hex')}-${bytes.subarray(4, 6).toString('hex')}-${bytes.subarray(6, 8).toString('hex')}-${bytes.subarray(8, 10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;
}

function giftPayloadHash(request: GiftRequestRecord, reservation: GiftReservationRecord): string {
  return crypto.createHash('sha256').update(JSON.stringify({ giftRequestId: request.id, version: request.version,
    orderId: request.orderId, participantId: request.participantId ?? null, senderId: request.senderId, receiverId: request.receiverId,
    giftCatalogVersionId: request.giftCatalogVersionId, giftCode: request.giftCodeSnapshot,
    giftName: request.giftNameSnapshot, priceMinor: request.priceMinor, currency: request.currency,
    reservationId: reservation.id, reservationVersion: reservation.version, reservationStatus: reservation.status,
    reservationAmountMinor: reservation.amountMinor })).digest('hex');
}

function assertExecutionCredential(request: GiftRequestRecord, reservation: GiftReservationRecord,
  task: GiftStaffTaskRecord | undefined, expectedVersion: number, now: Date): void {
  if (request.version !== expectedVersion || request.status !== 'PENDING_REVIEW' || !request.verifiedAt
    || !request.verificationPayloadHash || !request.executionCredentialExpiresAt || task?.status !== 'VERIFIED'
    || reservation.status !== 'ACTIVE' || reservation.amountMinor !== request.priceMinor
    || Date.parse(request.executionCredentialExpiresAt) <= now.getTime()
    || request.verificationPayloadHash !== giftPayloadHash({ ...request, version: request.version - 1 }, reservation)) {
    throw new GiftError('EXECUTION_CREDENTIAL_STALE', 'Gift verification changed or expired; verify again.');
  }
}

function requiredGiftLevel(amountMinor: number, thresholds: GiftApprovalThresholds = { l2LimitMinor: 200_000, l4FromMinor: 500_000 }): 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER' {
  return requiredLevelForAmount(amountMinor, thresholds);
}

async function giftApprovalThresholds(policyReader?: PolicyReader): Promise<GiftApprovalThresholds> {
  return {
    l2LimitMinor: await policyReader?.getPolicyInteger('L2_GIFT_APPROVAL_LIMIT_MINOR', 200_000) ?? 200_000,
    l4FromMinor: await policyReader?.getPolicyInteger('L4_DIRECT_EXECUTION_THRESHOLD_MINOR', 500_000) ?? 500_000
  };
}

function levelRank(level: StaffLevel): number {
  return { L1_SUPPORT: 1, L2_SUPERVISOR: 2, L3_OPERATIONS: 3, L4_ADMIN_OWNER: 4 }[level];
}

function buildGiftApproval(request: GiftRequestRecord, actorStaffId: string, requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER', reason: string, now: Date): GiftApprovalRecord {
  const id = crypto.randomUUID();
  const payloadSnapshot = { giftRequestId: request.id, expectedVersion: request.version,
    verificationPayloadHash: request.verificationPayloadHash, executionCredentialExpiresAt: request.executionCredentialExpiresAt,
    amountMinor: request.priceMinor, currency: request.currency };
  return { id, publicId: `APR-${id.replaceAll('-', '').slice(0, 18).toUpperCase()}`, action: 'GIFT_APPROVE',
    targetId: request.id, targetVersion: request.version, payloadSnapshot,
    payloadHash: hashStableJson(payloadSnapshot),
    amountMinor: request.priceMinor, currency: request.currency, requestedByStaffId: actorStaffId,
    requiredLevel, reason, expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString(), status: 'PENDING' };
}

function buildGiftAnnouncementJob(request: GiftRequestRecord, broadcastChannelId: string,
  senderDisplayName: string, receiverDisplayName: string, now: Date): OutboxJob {
  const publicSenderName = request.senderVisibility === 'ANONYMOUS' ? '匿名老板' : senderDisplayName;
  return {
    id: deterministicUuid(`gift-announcement:${request.id}`), type: 'GIFT_ANNOUNCEMENT', status: 'PENDING',
    payload: {
      giftRequestId: request.id,
      channelId: broadcastChannelId,
      content: request.broadcastTemplateSnapshot
        .replaceAll('{sender_name}', publicSenderName)
        .replaceAll('{receiver_name}', receiverDisplayName)
        .replaceAll('{gift_name}', request.giftNameSnapshot)
    },
    aggregateType: 'GIFT_REQUEST', aggregateId: request.id,
    dedupeKey: `gift:announcement:${request.id}:v1`, attempts: 0, maxAttempts: 8,
    runAfter: now.toISOString(), lockedAt: null, lockedBy: null, lastError: null,
    version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function buildGiftExpiryJob(request:GiftRequestRecord):OutboxJob{return{id:deterministicUuid(`gift-expiry:${request.id}`),type:'GIFT_EXPIRY',status:'PENDING',
  payload:{giftRequestId:request.id},aggregateType:'GIFT_REQUEST',aggregateId:request.id,dedupeKey:`gift-expiry:${request.id}`,attempts:0,maxAttempts:8,
  runAfter:request.expiresAt,lockedAt:null,lockedBy:null,lastError:null,version:1,createdAt:request.createdAt,updatedAt:request.createdAt};}

function buildCaptureResult(input: {
  request: GiftRequestRecord;
  reservation: GiftReservationRecord;
  consumptionId: string;
  announcementJobId: string;
  providerTransactionRef: string;
  now: Date;
}): GiftCaptureResult {
  return {
    status: 'CAPTURED', giftRequestId: input.request.id,
    reservation: {
      reservationId: input.reservation.id, amountMinor: input.reservation.amountMinor,
      capturedMinor: input.reservation.amountMinor, releasedMinor: 0, currency: input.reservation.currency,
      status: 'CAPTURED', version: input.reservation.version + 1, expiresAt: input.reservation.expiresAt
    },
    chargeOutcome: {
      kind: 'DEBIT', status: 'SUCCEEDED', amountMinor: input.request.priceMinor, currency: input.request.currency,
      providerReferenceDisplay: maskProviderReference(input.providerTransactionRef), observedAt: input.now.toISOString()
    },
    consumptionId: input.consumptionId, announcementJobId: input.announcementJobId
  };
}

function terminationResult(request:GiftRequestRecord,reservation:GiftReservationRecord,reason:string):GiftTerminationResult{
  return{giftRequestId:request.id,status:request.status as GiftTerminationResult['status'],reason,reservation:{reservationId:reservation.id,
    status:reservation.status as 'RELEASED'|'EXPIRED',amountMinor:reservation.amountMinor,releasedMinor:reservation.amountMinor,
    currency:reservation.currency,version:reservation.version}};
}

function maskProviderReference(reference: string): string {
  if (reference.length <= 8) return '***';
  return `${reference.slice(0, 5)}***${reference.slice(-4)}`;
}

const giftCaptureSelect = `SELECT tx.gift_request_id, tx.external_ref, tx.amount_minor, tx.currency,
  tx.settled_at, fr.id AS reservation_id, fr.amount_minor AS reservation_amount_minor,
  fr.row_version AS reservation_version, fr.expires_at AS reservation_expires_at,
  ce.id AS consumption_id, oe.id AS announcement_job_id
FROM external_transactions tx
JOIN fund_reservations fr ON fr.id = tx.fund_reservation_id
JOIN consumption_entries ce ON ce.external_transaction_id = tx.id
JOIN outbox_events oe ON oe.gift_request_id = tx.gift_request_id AND oe.event_type = 'GIFT_ANNOUNCEMENT'`;

function mapGiftCaptureRow(row: GiftCaptureRow): GiftCaptureResult {
  const observedAt = row.settled_at ? toIso(row.settled_at) : new Date(0).toISOString();
  return {
    status: 'CAPTURED', giftRequestId: row.gift_request_id,
    reservation: { reservationId: row.reservation_id, amountMinor: Number(row.reservation_amount_minor),
      capturedMinor: Number(row.reservation_amount_minor), releasedMinor: 0, currency: row.currency,
      status: 'CAPTURED', version: row.reservation_version, expiresAt: toIso(row.reservation_expires_at) },
    chargeOutcome: { kind: 'DEBIT', status: 'SUCCEEDED', amountMinor: Number(row.amount_minor), currency: row.currency,
      providerReferenceDisplay: maskProviderReference(row.external_ref), observedAt },
    consumptionId: row.consumption_id, announcementJobId: row.announcement_job_id
  };
}

interface GiftCaptureRow {
  gift_request_id: string;
  external_ref: string;
  amount_minor: string | number | bigint;
  currency: string;
  settled_at: Date | string | null;
  reservation_id: string;
  reservation_amount_minor: string | number | bigint;
  reservation_version: number;
  reservation_expires_at: Date | string;
  consumption_id: string;
  announcement_job_id: string;
}

async function loadGiftReviewSnapshot(client: PoolClient, selector: { taskId?: string; giftRequestId?: string }) {
  const result = await client.query<GiftReviewRow>(`
SELECT gr.id AS gr_id, gr.public_id, gr.guild_id,gr.origin,gr.sender_visibility,gr.order_id, gr.order_participant_id, gr.gift_catalog_version_id, gr.sender_id, gr.receiver_id,
  gr.status AS gr_status, gr.row_version AS gr_version, gr.gift_code_snapshot, gr.gift_name_snapshot,
  gr.price_minor, gr.currency, gr.broadcast_template_snapshot, gr.verified_by_staff_id, gr.verified_at,
  gr.verification_note, gr.verification_payload_hash, gr.execution_credential_expires_at,
  gr.approved_by_staff_id, gr.approved_at, gr.rejected_reason, gr.expires_at AS gr_expires_at,
  gr.created_at AS gr_created_at, gr.updated_at AS gr_updated_at,
  fr.id AS fr_id, fr.user_id AS fr_user_id, fr.mode AS fr_mode, fr.provider, fr.provider_hold_ref,
  fr.amount_minor AS fr_amount_minor, fr.currency AS fr_currency, fr.status AS fr_status,
  fr.row_version AS fr_version, fr.idempotency_key, fr.expires_at AS fr_expires_at,
  fr.activated_at, fr.settled_at, fr.created_at AS fr_created_at, fr.updated_at AS fr_updated_at,
  st.id AS st_id, st.public_id AS st_public_id, st.status AS st_status, st.row_version AS st_version,
  st.claimed_by_staff_id, st.voice_channel_id, st.context_snapshot, st.created_at AS st_created_at, st.updated_at AS st_updated_at
FROM gift_requests gr
JOIN fund_reservations fr ON fr.gift_request_id = gr.id
JOIN staff_tasks st ON st.gift_request_id = gr.id
WHERE ${selector.taskId ? 'st.id = $1' : 'gr.id = $1'}
FOR UPDATE OF gr, fr, st`, [selector.taskId ?? selector.giftRequestId]);
  const row = result.rows[0];
  if (!row) throw new GiftError('NOT_FOUND', 'Gift review record was not found.');
  const request: GiftRequestRecord = {
    id: row.gr_id, publicId: row.public_id, guildId: row.guild_id ?? undefined, origin: row.origin,
    senderVisibility: row.sender_visibility, orderId: row.order_id, participantId: row.order_participant_id,
    giftCatalogVersionId: row.gift_catalog_version_id,
    senderId: row.sender_id, receiverId: row.receiver_id, status: row.gr_status, version: row.gr_version,
    giftCodeSnapshot: row.gift_code_snapshot, giftNameSnapshot: row.gift_name_snapshot, priceMinor: Number(row.price_minor),
    currency: row.currency, broadcastTemplateSnapshot: row.broadcast_template_snapshot,
    verifiedByStaffId: row.verified_by_staff_id, verifiedAt: nullableIso(row.verified_at), verificationNote: row.verification_note,
    verificationPayloadHash: row.verification_payload_hash, executionCredentialExpiresAt: nullableIso(row.execution_credential_expires_at),
    approvedByStaffId: row.approved_by_staff_id, approvedAt: nullableIso(row.approved_at), rejectedReason: row.rejected_reason,
    expiresAt: toIso(row.gr_expires_at), createdAt: toIso(row.gr_created_at), updatedAt: toIso(row.gr_updated_at)
  };
  const reservation: GiftReservationRecord = {
    id: row.fr_id, userId: row.fr_user_id, sourceType: 'GIFT', orderId: null, giftRequestId: row.gr_id,
    mode: row.fr_mode, provider: row.provider, providerHoldRef: row.provider_hold_ref,
    amountMinor: Number(row.fr_amount_minor), currency: row.fr_currency as GiftReservationRecord['currency'], status: row.fr_status, version: row.fr_version,
    idempotencyKey: row.idempotency_key, expiresAt: toIso(row.fr_expires_at), activatedAt: nullableIso(row.activated_at),
    settledAt: nullableIso(row.settled_at), createdAt: toIso(row.fr_created_at), updatedAt: toIso(row.fr_updated_at)
  };
  const task: GiftStaffTaskRecord = {
    id: row.st_id, publicId: row.st_public_id, type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: row.st_status,
    version: row.st_version, orderId: row.order_id, giftRequestId: row.gr_id, claimedBy: row.claimed_by_staff_id,
    voiceChannelId: row.voice_channel_id, contextSnapshot: row.context_snapshot as GiftStaffTaskRecord['contextSnapshot'],
    createdAt: toIso(row.st_created_at), updatedAt: toIso(row.st_updated_at)
  };
  return { request, reservation, task, guildId:row.guild_id };
}

async function insertGiftApproval(client: PoolClient, approval: GiftApprovalRecord, staffTaskId: string): Promise<void> {
  await client.query(`INSERT INTO approval_requests (
    id, public_id, action, target_type, target_id, target_version, payload_snapshot, payload_hash,
    amount_minor, currency, requested_by_staff_id, required_level, status, row_version, staff_task_id,
    reason, expires_at, created_at, updated_at
  ) VALUES ($1,$2,'GIFT_APPROVE','GIFT_REQUEST',$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'PENDING',1,$11,$12,$13,$14,$14)`, [
    approval.id, approval.publicId, approval.targetId, approval.targetVersion, JSON.stringify(approval.payloadSnapshot),
    approval.payloadHash, approval.amountMinor, approval.currency, approval.requestedByStaffId, approval.requiredLevel,
    staffTaskId, approval.reason, new Date(approval.expiresAt), new Date(approval.createdAt)
  ]);
}

async function rejectStoredGiftApproval(client:PoolClient,input:GiftApprovalDecisionExecution,snapshot:{request:GiftRequestRecord;guildId:string|null}){
  const rows=await client.query<{id:string;target_version:number;payload_snapshot:Record<string,unknown>;payload_hash:string;required_level:StaffLevel;status:string;row_version:number;expires_at:Date|string}>(`
    SELECT id,target_version,payload_snapshot,payload_hash,required_level::text,status::text,row_version,expires_at
    FROM approval_requests WHERE id=$1 AND action='GIFT_APPROVE' AND target_type='GIFT_REQUEST' AND target_id=$2 FOR UPDATE`,
  [input.approvalRequestId,snapshot.request.id]);
  const approval=rows.rows[0];
  if(!approval||approval.status!=='PENDING'||approval.row_version!==input.expectedApprovalVersion
    ||approval.target_version!==input.targetVersion||approval.payload_hash!==input.payloadHash
    ||approval.payload_hash!==hashStableJson(approval.payload_snapshot)||snapshot.guildId!==input.guildId
    ||new Date(approval.expires_at).getTime()<=input.now.getTime())throw new GiftError('EXECUTION_CREDENTIAL_STALE','Approval request changed or expired.');
  if(levelRank(input.actorLevel)<levelRank(approval.required_level))throw new GiftError('PERMISSION_DENIED','Actor level is below the approval requirement.');
  const updated=await client.query(`UPDATE approval_requests SET status='REJECTED',row_version=row_version+1,updated_at=$2 WHERE id=$1 AND status='PENDING' AND row_version=$3`,[approval.id,input.now,input.expectedApprovalVersion]);
  if(updated.rowCount!==1)throw new GiftError('CONFLICT','Approval request changed before rejection.');
  await client.query(`INSERT INTO approval_decisions(id,approval_request_id,decision,decided_by_staff_id,reason,target_version_checked,payload_hash_checked,decided_at)
    VALUES(gen_random_uuid(),$1,'REJECT',$2,$3,$4,$5,$6)`,[approval.id,input.actorStaffId,input.reason,approval.target_version,approval.payload_hash,input.now]);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

interface GiftReviewRow {
  gr_id: string; public_id: string; order_id: string | null; order_participant_id: string | null; gift_catalog_version_id: string; sender_id: string; receiver_id: string;
  origin: 'ORDER' | 'STANDALONE'; sender_visibility: 'PUBLIC' | 'ANONYMOUS';
  gr_status: GiftRequestRecord['status']; gr_version: number; gift_code_snapshot: string; gift_name_snapshot: string;
  price_minor: string | number | bigint; currency: string; broadcast_template_snapshot: string;
  verified_by_staff_id: string | null; verified_at: Date | string | null; verification_note: string | null;
  verification_payload_hash: string | null; execution_credential_expires_at: Date | string | null;
  approved_by_staff_id: string | null; approved_at: Date | string | null; rejected_reason: string | null;
  gr_expires_at: Date | string; gr_created_at: Date | string; gr_updated_at: Date | string;
  fr_id: string; fr_user_id: string; fr_mode: GiftReservationRecord['mode']; provider: string; provider_hold_ref: string | null;
  fr_amount_minor: string | number | bigint; fr_currency: string; fr_status: GiftReservationRecord['status']; fr_version: number;
  idempotency_key: string; fr_expires_at: Date | string; activated_at: Date | string | null; settled_at: Date | string | null;
  fr_created_at: Date | string; fr_updated_at: Date | string;
  st_id: string; st_public_id: string; st_status: GiftStaffTaskRecord['status']; st_version: number;
  claimed_by_staff_id: string | null; voice_channel_id: string | null; context_snapshot: unknown;
  st_created_at: Date | string; st_updated_at: Date | string;
  guild_id:string|null;
}

function mapGiftCatalogRow(row: GiftCatalogRow): GiftCatalogRecord {
  return { id: row.id, itemId: row.gift_catalog_item_id, code: row.code, version: row.version, status: row.status,
    name: row.name, priceMinor: Number(row.price_minor), currency: row.currency, broadcastTemplate: row.broadcast_template };
}

interface GiftCatalogRow {
  id: string; gift_catalog_item_id: string; code: string; version: number; status: GiftCatalogStatus;
  name: string; price_minor: string | number | bigint; currency: string; broadcast_template: string;
}

const standaloneGiftRecipientSelect = `SELECT pp.id AS player_profile_id,pp.user_id,u.display_name,da.guild_id,da.discord_user_id,
  pp.review_status::text AS review_status,u.status::text AS user_status
FROM player_profiles pp JOIN users u ON u.id=pp.user_id JOIN discord_accounts da ON da.user_id=pp.user_id `;

interface StandaloneGiftRecipientRow {
  player_profile_id: string; user_id: string; display_name: string; guild_id: string; discord_user_id: string;
  review_status: StandaloneGiftRecipientRecord['reviewStatus']; user_status: StandaloneGiftRecipientRecord['userStatus'];
}

function mapStandaloneGiftRecipientRow(row: StandaloneGiftRecipientRow): StandaloneGiftRecipientRecord {
  return { playerProfileId: row.player_profile_id, userId: row.user_id, displayName: row.display_name,
    guildId: row.guild_id, discordUserId: row.discord_user_id, reviewStatus: row.review_status, userStatus: row.user_status };
}

const staffGiftAssistChallengeSelect = `SELECT challenge.id,challenge.guild_id,challenge.staff_account_id,
  challenge.staff_discord_user_id,challenge.permissions_version,challenge.customer_user_id,
  challenge.customer_discord_user_id,customer.display_name AS customer_display_name,
  challenge.authorization_channel_id,challenge.authorization_message_id,challenge.authorization_reason,
  challenge.failed_attempts,challenge.expires_at,challenge.consumed_at,challenge.created_at,challenge.updated_at
FROM staff_gift_assist_challenges challenge JOIN users customer ON customer.id=challenge.customer_user_id `;

interface StaffGiftAssistChallengeRow {
  id: string; guild_id: string; staff_account_id: string; staff_discord_user_id: string; permissions_version: number;
  customer_user_id: string; customer_discord_user_id: string; customer_display_name: string;
  authorization_channel_id: string; authorization_message_id: string; authorization_reason: string | null;
  failed_attempts: number; expires_at: Date | string; consumed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
}

function mapStaffGiftAssistChallengeRow(row: StaffGiftAssistChallengeRow): StaffGiftAssistChallengeRecord {
  return { id: row.id, guildId: row.guild_id, staffAccountId: row.staff_account_id,
    staffDiscordUserId: row.staff_discord_user_id, permissionsVersion: row.permissions_version,
    customerUserId: row.customer_user_id, customerDiscordUserId: row.customer_discord_user_id,
    customerDisplayName: row.customer_display_name, authorizationChannelId: row.authorization_channel_id,
    authorizationMessageId: row.authorization_message_id, authorizationReason: row.authorization_reason,
    failedAttempts: row.failed_attempts, expiresAt: toIso(row.expires_at), consumedAt: nullableIso(row.consumed_at),
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function restoreArray<T>(target:T[],snapshot:T[]):void{
  target.splice(0,target.length,...clone(snapshot));
}

function hashStableJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}
