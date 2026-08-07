import type { ServiceCenterRoute } from './service-center-routes.js';

const uuid = '([0-9a-f-]{36})';
const state = '([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{8})';

export function parseOrderExperienceReviewRoute(customId: string): ServiceCenterRoute | null {
  const open = new RegExp(`^bc:r:${uuid}:o$`, 'u').exec(customId);
  if (open) return { area: 'experience-review', action: 'open', orderId: open[1]! };

  const overall = new RegExp(`^bc:r:${uuid}:o([1-5])$`, 'u').exec(customId);
  if (overall)
    return {
      area: 'experience-review',
      action: 'overall',
      orderId: overall[1]!,
      score: Number(overall[2]) as 1 | 2 | 3 | 4 | 5
    };

  const rating = new RegExp(`^bc:r:${uuid}:s([1-5]):${state}$`, 'u').exec(customId);
  if (rating)
    return {
      area: 'experience-review',
      action: 'rate',
      orderId: rating[1]!,
      score: Number(rating[2]) as 1 | 2 | 3 | 4 | 5,
      state: rating[3]!
    };

  const page = new RegExp(`^bc:r:${uuid}:p([0-9]+):${state}$`, 'u').exec(customId);
  if (page)
    return {
      area: 'experience-review',
      action: 'page',
      orderId: page[1]!,
      page: Number(page[2]),
      state: page[3]!
    };

  const targetSelect = new RegExp(`^bc:r:${uuid}:t([0-9]+):${state}$`, 'u').exec(customId);
  if (targetSelect)
    return {
      area: 'experience-review-target-select',
      orderId: targetSelect[1]!,
      page: Number(targetSelect[2]),
      state: targetSelect[3]!
    };

  const commentSelect = new RegExp(`^bc:r:${uuid}:c$`, 'u').exec(customId);
  if (commentSelect) return { area: 'experience-review-comment-select', orderId: commentSelect[1]! };

  const commentModal = new RegExp(`^bc:rc:${uuid}:${uuid}$`, 'u').exec(customId);
  if (commentModal)
    return {
      area: 'experience-review-comment-modal',
      orderId: commentModal[1]!,
      reviewId: commentModal[2]!
    };
  return null;
}
