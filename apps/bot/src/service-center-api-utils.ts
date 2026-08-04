export function pagePath(path: string, cursor: string | undefined, limit: number): string {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  query.set('limit', String(limit));
  return `${path}?${query.toString()}`;
}

export function buildDiscordIdempotencyKey(action: string, interactionId: string): string {
  return `discord:${action}:${interactionId}`.replaceAll(/[^A-Za-z0-9:_-]/gu, '_').slice(0, 200);
}
