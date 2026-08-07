import type {
  BotActorContext,
  OrderExperienceReview,
  OrderExperienceReviewCenter,
  OrderReviewPublication
} from './service-center-api-contracts.js';

type ReviewRequest = <T>(
  path: string,
  input: {
    method: 'GET' | 'POST';
    actor: BotActorContext;
    idempotencyKey?: string;
    body?: unknown;
    validateAs: 'experience-review-center' | 'experience-review' | 'experience-review-batch' | 'review-publication';
  }
) => Promise<T>;

export class OrderExperienceReviewApiClient {
  constructor(private readonly request: ReviewRequest) {}

  getCenter(orderId: string, actor: BotActorContext) {
    return this.request<OrderExperienceReviewCenter>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/experience-review`,
      {
        method: 'GET',
        actor,
        validateAs: 'experience-review-center'
      }
    );
  }

  createRatings(
    orderId: string,
    input: { targetKeys: string[]; score: number },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<OrderExperienceReview[]>(`/api/v1/orders/${encodeURIComponent(orderId)}/experience-ratings`, {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input,
      validateAs: 'experience-review-batch'
    });
  }

  appendComment(
    orderId: string,
    reviewId: string,
    input: { comment: string },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<OrderExperienceReview>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/experience-ratings/${encodeURIComponent(reviewId)}/comment`,
      { method: 'POST', actor, idempotencyKey, body: input, validateAs: 'experience-review' }
    );
  }

  publish(
    orderId: string,
    input: { confirmation: 'PUBLISH_FIVE_STAR_SNAPSHOT' },
    actor: BotActorContext,
    idempotencyKey: string
  ) {
    return this.request<OrderReviewPublication>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/experience-review/publication`,
      {
        method: 'POST',
        actor,
        idempotencyKey,
        body: input,
        validateAs: 'review-publication'
      }
    );
  }
}
