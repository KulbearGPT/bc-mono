export type BotApiDataKind =
  | 'order'
  | 'balance'
  | 'gift-panel'
  | 'gift-affordability'
  | 'gift-request'
  | 'selection-page'
  | 'bot-config'
  | 'experience-review-center'
  | 'experience-review'
  | 'experience-review-batch';

export function validateBotApiData<T>(kind: BotApiDataKind, value: T): T {
  const valid =
    kind === 'order'
      ? validOrder(value)
      : kind === 'balance'
        ? validBalance(value)
        : kind === 'gift-panel'
          ? validGiftPanel(value)
          : kind === 'gift-affordability'
            ? validGiftAffordability(value)
            : kind === 'gift-request'
              ? validGiftRequest(value)
              : kind === 'selection-page'
                ? validSelectionPage(value)
                : kind === 'bot-config'
                  ? validBotConfig(value)
                  : kind === 'experience-review-center'
                    ? validExperienceReviewCenter(value)
                    : kind === 'experience-review'
                      ? validExperienceReview(value)
                      : Array.isArray(value) && value.length > 0 && value.every(validExperienceReview);
  if (!valid) throw new BotApiDataValidationError(kind);
  return value;
}

export class BotApiDataValidationError extends Error {
  public constructor(readonly kind: BotApiDataKind) {
    super(`Unified API returned invalid ${kind} data.`);
    this.name = 'BotApiDataValidationError';
  }
}

function validOrder(value: unknown): boolean {
  if (!record(value) || !text(value.id) || !text(value.publicId) || !text(value.status) || !positive(value.version))
    return false;
  if (!safeMinor(value.amountMinor) || value.currency !== 'CAT' || !record(value.channelSpec)) return false;
  return (
    text(value.channelSpec.channelId) &&
    text(value.channelSpec.panelMessageId) &&
    (value.channelSpec.voiceChannelId === null || text(value.channelSpec.voiceChannelId)) &&
    Array.isArray(value.availableActions)
  );
}

function validBalance(value: unknown): boolean {
  return (
    record(value) &&
    safeMinor(value.ledgerBalanceMinor) &&
    nonNegativeMinor(value.reservedMinor) &&
    safeMinor(value.availableMinor) &&
    value.availableMinor === value.ledgerBalanceMinor - value.reservedMinor &&
    value.currency === 'CAT' &&
    dateTime(value.calculatedAt)
  );
}

function validGiftPanel(value: unknown): boolean {
  return (
    record(value) &&
    text(value.orderId) &&
    text(value.orderPublicId) &&
    Array.isArray(value.recipients) &&
    value.recipients.every((item) => record(item) && text(item.participantId) && text(item.displayName)) &&
    validBalance(value.balance) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        record(item) &&
        text(item.id) &&
        text(item.name) &&
        positive(item.version) &&
        nonNegativeMinor(item.priceMinor) &&
        item.currency === 'CAT'
    )
  );
}

function validGiftAffordability(value: unknown): boolean {
  return (
    record(value) &&
    text(value.giftCatalogVersionId) &&
    positive(value.catalogVersion) &&
    nonNegativeMinor(value.priceMinor) &&
    nonNegativeMinor(value.totalPriceMinor) &&
    safeMinor(value.availableMinor) &&
    nonNegativeMinor(value.shortfallMinor) &&
    value.currency === 'CAT' &&
    typeof value.canAfford === 'boolean' &&
    typeof value.stale === 'boolean' &&
    dateTime(value.calculatedAt)
  );
}

function validGiftRequest(value: unknown): boolean {
  return (
    record(value) &&
    nonNegativeMinor(value.unitPriceMinor) &&
    nonNegativeMinor(value.totalAmountMinor) &&
    Number.isSafeInteger(value.recipientCount) &&
    Number(value.recipientCount) > 0 &&
    Array.isArray(value.items) &&
    value.items.length === value.recipientCount
  );
}

function validSelectionPage(value: unknown): boolean {
  return (
    record(value) &&
    validSelectionPool(value.pool) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        record(item) && text(item.id) && text(item.playerDisplayName) && text(item.status) && positive(item.version)
    ) &&
    (value.nextCursor === null || value.nextCursor === undefined || text(value.nextCursor))
  );
}

function validSelectionPool(value: unknown): boolean {
  return record(value) && text(value.id) && text(value.orderId) && text(value.status) && positive(value.version);
}

function validBotConfig(value: unknown): boolean {
  return (
    record(value) &&
    text(value.guildId) &&
    positive(value.version) &&
    record(value.values) &&
    Array.isArray(value.manageableFields) &&
    value.manageableFields.every(text)
  );
}

function validExperienceReviewCenter(value: unknown): boolean {
  if (
    !record(value) ||
    !text(value.orderId) ||
    !text(value.orderPublicId) ||
    !dateTime(value.expiresAt) ||
    typeof value.hasPublishableFiveStar !== 'boolean' ||
    !Array.isArray(value.targets) ||
    !(value.publication === null || validReviewPublication(value.publication))
  )
    return false;
  const keys = new Set<string>();
  return value.targets.every((target) => {
    if (
      !record(target) ||
      !text(target.targetKey) ||
      keys.has(target.targetKey) ||
      !reviewTargetType(target.targetType) ||
      !text(target.displayName)
    )
      return false;
    keys.add(target.targetKey);
    const review = target.review;
    return (
      review === null ||
      (record(review) &&
        validExperienceReview(review) &&
        review.orderId === value.orderId &&
        review.targetKey === target.targetKey &&
        review.targetType === target.targetType)
    );
  });
}

function validExperienceReview(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    text(value.orderId) &&
    text(value.targetKey) &&
    reviewTargetType(value.targetType) &&
    Number.isInteger(value.score) &&
    Number(value.score) >= 1 &&
    Number(value.score) <= 5 &&
    dateTime(value.createdAt) &&
    (value.orderParticipantId === null || text(value.orderParticipantId)) &&
    (value.attributedStaffId === null || text(value.attributedStaffId)) &&
    (value.comment === null || validExperienceReviewComment(value.comment))
  );
}

function validExperienceReviewComment(value: unknown): boolean {
  return record(value) && text(value.id) && text(value.comment) && value.comment.length <= 500 && dateTime(value.createdAt);
}

function validReviewPublication(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    text(value.orderId) &&
    ['PENDING', 'PUBLISHED', 'FAILED'].includes(String(value.status)) &&
    record(value.snapshot) &&
    dateTime(value.consentedAt) &&
    (value.publishedAt === null || dateTime(value.publishedAt))
  );
}

function reviewTargetType(value: unknown): boolean {
  return value === 'ORDER' || value === 'PLAYER' || value === 'SUPPORT';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function safeMinor(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function nonNegativeMinor(value: unknown): value is number {
  return safeMinor(value) && Number(value) >= 0;
}

function dateTime(value: unknown): value is string {
  return text(value) && !Number.isNaN(Date.parse(value));
}
