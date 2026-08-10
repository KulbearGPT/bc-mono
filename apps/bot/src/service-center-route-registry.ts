import type { ServiceCenterRoute } from './service-center-routes.js';

export type ServiceCenterInteractionKind = 'button' | 'select' | 'modal' | 'none';

const buttonAreas = new Set<ServiceCenterRoute['area']>([
  'entry',
  'service-center-action',
  'order-open',
  'order-action',
  'order-refresh',
  'order-requirement-action',
  'order-requirement-add-action',
  'order-game-action',
  'service-package-action',
  'order-notes-open',
  'order-menu-notes-open',
  'requirement-note-open',
  'service-action',
  'cancellation-action',
  'profile',
  'reports',
  'gift',
  'standalone-gift',
  'gift-recipient-page',
  'support-rating',
  'experience-review'
]);

const selectAreas = new Set<ServiceCenterRoute['area']>([
  'order-select',
  'order-requirement-select',
  'service-package-select',
  'order-game-select',
  'gift-recipient-select',
  'gift-catalog-select',
  'standalone-gift-recipient-select',
  'standalone-gift-catalog-select',
  'experience-review-target-select',
  'experience-review-comment-select'
]);

const modalAreas = new Set<ServiceCenterRoute['area']>([
  'order-notes-modal',
  'order-menu-notes-modal',
  'requirement-note-modal',
  'support-rating-comment',
  'experience-review-comment-modal'
]);

export function serviceCenterInteractionKind(route: ServiceCenterRoute): ServiceCenterInteractionKind {
  if (buttonAreas.has(route.area)) return 'button';
  if (selectAreas.has(route.area)) return 'select';
  if (modalAreas.has(route.area)) return 'modal';
  return 'none';
}
