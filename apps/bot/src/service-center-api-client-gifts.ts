import type { BotActorContext } from './service-center-api-contracts.js';
import type { GiftAffordabilityResult, GiftPanelData, GiftRequestResult } from './gifts.js';
import type {
  StandaloneGiftAffordabilityData,
  StandaloneGiftCenterData,
  StandaloneGiftRequestData
} from './standalone-gifts.js';
import type {
  StaffAssistedGiftRequestData,
  StaffGiftAssistChallengeData
} from './service-center-api-client-staff-gift-contract.js';

type GiftRequest = <T>(
  path: string,
  input: {
    method: 'GET' | 'POST';
    actor: BotActorContext;
    idempotencyKey?: string;
    body?: unknown;
    validateAs:
      | 'gift-panel'
      | 'gift-affordability'
      | 'gift-request'
      | 'standalone-gift-center'
      | 'standalone-gift-affordability'
      | 'standalone-gift-request'
      | 'staff-gift-assist-challenge'
      | 'staff-assisted-gift-request';
  }
) => Promise<T>;

export class GiftApiClient {
  constructor(private readonly request: GiftRequest) {}

  listOrder(orderId: string, actor: BotActorContext) {
    return this.request<GiftPanelData>(`/api/v1/gifts?orderId=${encodeURIComponent(orderId)}`, {
      method: 'GET',
      actor,
      validateAs: 'gift-panel'
    });
  }

  checkOrder(orderId: string, giftCatalogVersionId: string, participantIds: string[], actor: BotActorContext) {
    return this.request<GiftAffordabilityResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/gift-affordability`, {
      method: 'POST',
      actor,
      body: { giftCatalogVersionId, participantIds },
      validateAs: 'gift-affordability'
    });
  }

  createOrder(
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
  ) {
    return this.request<GiftRequestResult>(`/api/v1/orders/${encodeURIComponent(orderId)}/gift-requests`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input,
      validateAs: 'gift-request'
    });
  }

  getStandaloneCenter(actor: BotActorContext) {
    return this.request<StandaloneGiftCenterData>('/api/v1/gift-center', {
      method: 'GET',
      actor,
      validateAs: 'standalone-gift-center'
    });
  }

  checkStandalone(playerProfileId: string, giftCatalogVersionId: string, actor: BotActorContext) {
    return this.request<StandaloneGiftAffordabilityData>('/api/v1/gift-center/affordability', {
      method: 'POST',
      actor,
      body: { playerProfileId, giftCatalogVersionId },
      validateAs: 'standalone-gift-affordability'
    });
  }

  createStandalone(
    input: {
      playerProfileId: string;
      giftCatalogVersionId: string;
      expectedCatalogVersion: number;
      expectedPriceMinor: number;
      anonymous: boolean;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<StandaloneGiftRequestData>('/api/v1/gift-center/gift-requests', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input,
      validateAs: 'standalone-gift-request'
    });
  }

  createStaffAssistChallenge(
    input: { customerDiscordUserId: string; authorizationChannelId: string; authorizationMessageId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<StaffGiftAssistChallengeData>('/api/v1/admin/gift-assist/challenges', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input,
      validateAs: 'staff-gift-assist-challenge'
    });
  }

  getStaffAssistChallenge(challengeId: string, actor: BotActorContext) {
    return this.request<StaffGiftAssistChallengeData>(
      `/api/v1/admin/gift-assist/challenges/${encodeURIComponent(challengeId)}`,
      {
        method: 'GET',
        actor,
        validateAs: 'staff-gift-assist-challenge'
      }
    );
  }

  checkStaffAssist(challengeId: string, playerProfileId: string, giftCatalogVersionId: string, actor: BotActorContext) {
    return this.request<StandaloneGiftAffordabilityData>(
      `/api/v1/admin/gift-assist/challenges/${encodeURIComponent(challengeId)}/affordability`,
      {
        method: 'POST',
        actor,
        body: { playerProfileId, giftCatalogVersionId },
        validateAs: 'standalone-gift-affordability'
      }
    );
  }

  createStaffAssisted(
    challengeId: string,
    input: {
      playerProfileId: string;
      giftCatalogVersionId: string;
      expectedCatalogVersion: number;
      expectedPriceMinor: number;
      anonymous: boolean;
      authorizationReason: string;
      totpCode: string;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<StaffAssistedGiftRequestData>(
      `/api/v1/admin/gift-assist/challenges/${encodeURIComponent(challengeId)}/gift-requests`,
      {
        method: 'POST',
        actor,
        idempotencyKey,
        body: input,
        validateAs: 'staff-assisted-gift-request'
      }
    );
  }
}
