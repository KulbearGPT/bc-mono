import { createHmac, timingSafeEqual } from 'node:crypto';

export const collectionSortFields = {
  orders: ['createdAt', 'updatedAt', 'amountMinor'],
  users: ['createdAt', 'updatedAt', 'displayName'],
  players: ['createdAt', 'updatedAt', 'displayName'],
  service_catalog: ['createdAt', 'offeringName', 'customerUnitPriceMinor', 'version'],
  service_packages: ['createdAt', 'displayName', 'defaultCustomerPriceMinor', 'version'],
  gift_catalog: ['createdAt', 'name', 'priceMinor', 'version'],
  gift_requests: ['createdAt', 'updatedAt', 'amountMinor', 'expiresAt']
} as const;

export type AdminCollectionResource = keyof typeof collectionSortFields;
export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;
export interface CursorBinding { actorGuildId: string | null; actorScope: string; filters: Record<string, string | null | undefined> }
export interface AdminCollectionPageInput<T> {
  resource: AdminCollectionResource;
  cursor: string | null;
  limit: number;
  sortBy: string;
  sortDirection: SortDirection;
  binding: CursorBinding;
  idOf(item: T): string;
  valueOf(item: T): SortValue;
}

interface CursorPayload {
  version: 1;
  resource: AdminCollectionResource;
  sortBy: string;
  sortDirection: SortDirection;
  binding: string;
  sortValue: string | number | null;
  id: string;
}

const cursorKey = Buffer.from(process.env.PAGINATION_CURSOR_SECRET ?? process.env.BOT_SERVICE_TOKEN ?? 'blackcat-local-pagination-cursor-v1', 'utf8');

export function parseAdminCollectionSort(
  resource: AdminCollectionResource,
  query: Record<string, unknown>,
  invalid: (message: string) => Error
): { sortBy: string; sortDirection: SortDirection } {
  const sortBy = query.sortBy === undefined ? 'createdAt' : query.sortBy;
  const sortDirection = query.sortDirection === undefined ? 'desc' : query.sortDirection;
  if (typeof sortBy !== 'string' || !(collectionSortFields[resource] as readonly string[]).includes(sortBy)) throw invalid('sortBy is invalid.');
  if (sortDirection !== 'asc' && sortDirection !== 'desc') throw invalid('sortDirection is invalid.');
  return { sortBy, sortDirection };
}

export function paginateAdminCollection<T>(items: readonly T[], input: AdminCollectionPageInput<T>): { items: T[]; nextCursor: string | null } {
  assertSort(input.resource, input.sortBy);
  const cursor = input.cursor ? decodeCursor(input) : null;
  const sorted = [...items].sort((left, right) => compareKey(key(input, left), key(input, right), input.sortDirection));
  const remaining = cursor
    ? sorted.filter((item) => compareKey(key(input, item), { value: cursor.sortValue, id: cursor.id }, input.sortDirection) > 0)
    : sorted;
  const selected = remaining.slice(0, input.limit);
  const last = selected.at(-1);
  return {
    items: structuredClone(selected),
    nextCursor: remaining.length > input.limit && last ? encodeCursor(input, last) : null
  };
}

export function decodeAdminCollectionCursor(input: Omit<AdminCollectionPageInput<unknown>, 'idOf' | 'valueOf' | 'limit'>): { sortValue: string | number | null; id: string } | null {
  return input.cursor ? decodeCursor(input) : null;
}

function key<T>(input: AdminCollectionPageInput<T>, item: T) {
  return { value: normalizeValue(input.valueOf(item)), id: input.idOf(item) };
}

function normalizeValue(value: SortValue): string | number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length <= 500) return value;
  throw new Error('Sort value is invalid.');
}

function compareKey(left: { value: string | number | null; id: string }, right: { value: string | number | null; id: string }, direction: SortDirection) {
  if (left.value == null || right.value == null) {
    if (left.value == null && right.value != null) return 1;
    if (left.value != null && right.value == null) return -1;
  } else {
    const difference = typeof left.value === 'number' && typeof right.value === 'number'
      ? left.value - right.value
      : codePointCompare(String(left.value), String(right.value));
    if (difference !== 0) return direction === 'asc' ? difference : -difference;
  }
  const idDifference = codePointCompare(left.id, right.id);
  return direction === 'asc' ? idDifference : -idDifference;
}

function codePointCompare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function encodeCursor<T>(input: AdminCollectionPageInput<T>, item: T) {
  const itemKey = key(input, item);
  const body: CursorPayload = {
    version: 1,
    resource: input.resource,
    sortBy: input.sortBy,
    sortDirection: input.sortDirection,
    binding: bindingDigest(input.binding),
    sortValue: itemKey.value,
    id: itemKey.id
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodeCursor(input: Pick<AdminCollectionPageInput<unknown>, 'cursor' | 'resource' | 'sortBy' | 'sortDirection' | 'binding'>): CursorPayload {
  try {
    const [payload, signature, extra] = input.cursor!.split('.');
    if (!payload || !signature || extra) throw new Error();
    const actual = Buffer.from(signature);
    const expected = Buffer.from(sign(payload));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (decoded.version !== 1 || decoded.resource !== input.resource || decoded.sortBy !== input.sortBy || decoded.sortDirection !== input.sortDirection || decoded.binding !== bindingDigest(input.binding)) throw new Error();
    if (typeof decoded.id !== 'string' || decoded.id.length < 1 || decoded.id.length > 100) throw new Error();
    if (decoded.sortValue !== null && typeof decoded.sortValue !== 'string' && typeof decoded.sortValue !== 'number') throw new Error();
    return decoded as CursorPayload;
  } catch {
    throw new Error('cursor is invalid.');
  }
}

function bindingDigest(binding: CursorBinding) {
  const filters = Object.fromEntries(Object.entries(binding.filters).filter(([, value]) => value != null).sort(([left], [right]) => codePointCompare(left, right)));
  return createHmac('sha256', cursorKey).update(JSON.stringify({ actorGuildId: binding.actorGuildId, actorScope: binding.actorScope, filters })).digest('base64url');
}

function sign(payload: string) { return createHmac('sha256', cursorKey).update(payload).digest('base64url'); }
function assertSort(resource: AdminCollectionResource, sortBy: string) {
  if (!(collectionSortFields[resource] as readonly string[]).includes(sortBy)) throw new Error('sortBy is invalid.');
}
