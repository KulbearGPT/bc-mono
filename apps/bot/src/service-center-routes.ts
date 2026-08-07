export type ServiceCenterRoute =
  | {
      area: 'entry';
      action: 'create-order' | 'service-center' | 'player-workbench';
    }
  | { area: 'service-center-action'; action: 'commissions' | 'recharge' }
  | { area: 'order-open'; orderId: string }
  | {
      area: 'support-rating';
      orderId: string;
      score: number | null;
      reason: string | null;
    }
  | { area: 'support-rating-comment'; orderId: string; score: 1 | 2 }
  | { area: 'experience-review'; action: 'open'; orderId: string }
  | { area: 'experience-review'; action: 'overall'; orderId: string; score: 1 | 2 | 3 | 4 | 5 }
  | {
      area: 'experience-review';
      action: 'rate';
      orderId: string;
      score: 1 | 2 | 3 | 4 | 5;
      state: string;
    }
  | { area: 'experience-review'; action: 'page'; orderId: string; page: number; state: string }
  | { area: 'experience-review-target-select'; orderId: string; page: number; state: string }
  | { area: 'experience-review-comment-select'; orderId: string }
  | { area: 'experience-review-comment-modal'; orderId: string; reviewId: string }
  | {
      area: 'cancellation-action';
      action: 'confirm';
      orderId: string;
      previewId: string;
      expectedVersion: number;
    }
  | {
      area: 'order-select';
      orderId: string;
      field: 'catalog' | 'duration' | 'preferred-players';
      expectedVersion: number;
    }
  | {
      area: 'order-requirement-select';
      orderId: string;
      action: 'add' | 'preview';
      requirementId?: undefined;
      expectedVersion: number;
    }
  | {
      area: 'order-requirement-select';
      orderId: string;
      action: 'edit';
      requirementId?: undefined;
      expectedVersion: number;
      cursor?: string;
    }
  | {
      area: 'order-requirement-select';
      orderId: string;
      action: 'project' | 'units' | 'players';
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'order-requirement-action';
      orderId: string;
      action: 'back';
      expectedVersion: number;
    }
  | {
      area: 'order-requirement-action';
      orderId: string;
      action: 'page';
      expectedVersion: number;
      cursor?: string;
    }
  | {
      area: 'order-requirement-action';
      orderId: string;
      action: 'remove';
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'order-requirement-add-action';
      orderId: string;
      serviceCatalogVersionId: string;
      action: 'add';
      expectedVersion: number;
    }
  | { area: 'service-package-select'; orderId: string; expectedVersion: number }
  | { area: 'order-game-select'; orderId: string; expectedVersion: number }
  | {
      area: 'order-game-action';
      orderId: string;
      game: string;
      action: 'open';
      expectedVersion: number;
    }
  | {
      area: 'service-package-action';
      orderId: string;
      action: 'open' | 'back';
      expectedVersion: number;
    }
  | {
      area: 'service-package-action';
      orderId: string;
      action: 'preview';
      servicePackageVersionId: string;
      expectedVersion: number;
    }
  | {
      area: 'service-package-action';
      orderId: string;
      action: 'apply';
      servicePackageVersionId: string;
      expectedVersion: number;
    }
  | {
      area: 'order-action';
      orderId: string;
      action: 'submit' | 'submit-final' | 'cancel';
      expectedVersion: number;
    }
  | { area: 'order-refresh'; orderId: string }
  | {
      area: 'service-action';
      orderId: string;
      action: 'ready' | 'request-completion' | 'confirm' | 'support';
      expectedVersion: number;
    }
  | { area: 'order-notes-modal'; orderId: string; expectedVersion: number }
  | { area: 'order-notes-open'; orderId: string; expectedVersion: number }
  | { area: 'order-menu-notes-modal'; orderId: string; game: string; expectedVersion: number }
  | { area: 'order-menu-notes-open'; orderId: string; game: string; expectedVersion: number }
  | {
      area: 'requirement-note-modal';
      orderId: string;
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'requirement-note-open';
      orderId: string;
      requirementId: string;
      expectedVersion: number;
      expectedRequirementVersion: number;
    }
  | {
      area: 'profile';
      action: 'open' | 'refresh' | 'orders' | 'consumptions';
      cursor?: string;
    }
  | { area: 'reports'; action: 'list'; cursor?: string }
  | { area: 'gift'; action: 'open'; orderId: string; expectedVersion: number }
  | {
      area: 'gift';
      action: 'select' | 'refresh' | 'confirm' | 'back';
      token: string;
    }
  | {
      area: 'gift-recipient-select';
      orderId: string;
      expectedVersion: number;
      page: number;
      selection: string;
    }
  | { area: 'gift-catalog-select'; selection: string }
  | {
      area: 'gift-recipient-page';
      orderId: string;
      expectedVersion: number;
      page: number;
      selection: string;
    }
  | { area: 'reports'; action: 'detail'; reportId: string }
  | { area: 'unknown' };

import { parseSupportGiftProfileRoute } from './service-center-route-support-gift-profile.js';
import { parseOrderBaseRoute } from './service-center-route-order-base.js';
import { parseRequirementsRoute } from './service-center-route-requirements.js';
import { parseCatalogNotesRoute } from './service-center-route-catalog-notes.js';
import { parseOrderActionsRoute } from './service-center-route-order-actions.js';
import { parseOrderExperienceReviewRoute } from './service-center-route-order-reviews.js';

const routeParsers = [
  parseOrderExperienceReviewRoute,
  parseSupportGiftProfileRoute,
  parseOrderBaseRoute,
  parseRequirementsRoute,
  parseCatalogNotesRoute,
  parseOrderActionsRoute
] as const;

export function parseServiceCenterCustomId(customId: string): ServiceCenterRoute {
  for (const parser of routeParsers) {
    const route = parser(customId);
    if (route) return route;
  }
  return { area: 'unknown' };
}
