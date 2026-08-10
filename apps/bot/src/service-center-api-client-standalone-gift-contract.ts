import type { BotActorContext } from './service-center-api-contracts.js';
import type {
  StandaloneGiftAffordabilityData,
  StandaloneGiftCenterData,
  StandaloneGiftRequestData
} from './standalone-gifts.js';

export interface StandaloneGiftApiClientContract {
  getStandaloneGiftCenter(actor: BotActorContext): Promise<StandaloneGiftCenterData>;
  checkStandaloneGiftAffordability(
    playerProfileId: string,
    giftCatalogVersionId: string,
    actor: BotActorContext
  ): Promise<StandaloneGiftAffordabilityData>;
  createStandaloneGiftRequest(
    input: {
      playerProfileId: string;
      giftCatalogVersionId: string;
      expectedCatalogVersion: number;
      expectedPriceMinor: number;
      anonymous: boolean;
    },
    actor: BotActorContext,
    idempotencyKey: string
  ): Promise<StandaloneGiftRequestData>;
}
