import type { BotActorContext } from './service-center-api-contracts.js';
import type {
  StandaloneGiftAffordabilityData,
  StandaloneGiftCenterData,
  StandaloneGiftRequestData
} from './standalone-gifts.js';

export interface StaffGiftAssistChallengeData extends StandaloneGiftCenterData {
  id: string;
  customer: { displayName: string };
  failedAttempts: number;
  expiresAt: string;
}

export interface StaffAssistedGiftRequestData extends StandaloneGiftRequestData {
  initiatorMode: 'STAFF_ASSISTED';
  assistedByStaffId: string;
  giftAssistChallengeId: string;
}

export interface StaffGiftAssistApiClientContract {
  createStaffGiftAssistChallenge(
    input: { customerDiscordUserId: string; authorizationChannelId: string; authorizationMessageId: string },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<StaffGiftAssistChallengeData>;
  getStaffGiftAssistChallenge(challengeId: string, actor: BotActorContext): Promise<StaffGiftAssistChallengeData>;
  checkStaffGiftAssistAffordability(
    challengeId: string,
    playerProfileId: string,
    giftCatalogVersionId: string,
    actor: BotActorContext
  ): Promise<StandaloneGiftAffordabilityData>;
  createStaffAssistedGiftRequest(
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
  ): Promise<StaffAssistedGiftRequestData>;
}
