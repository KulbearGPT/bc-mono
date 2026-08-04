import { SelectionCandidate, SelectionRoute } from './selection-discord-contracts.js';

export function withdrawCustomId(input: {
  orderId: string;
  poolId: string;
  applicationId: string;
  poolVersion: number;
  applicationVersion: number;
}) {
  return `bc:sp:w:${short(input.orderId)}:${short(input.poolId)}:${short(input.applicationId)}:v${input.poolVersion}:a${input.applicationVersion}`;
}
export function closeCustomId(input: { orderId: string; poolId: string; poolVersion: number }) {
  return `bc:sp:c:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}`;
}

export function parseSelectionCustomId(value: string): SelectionRoute {
  let initial = /^bc:sp:new:([0-9a-f-]{36}):o(\d+)$/u.exec(value);
  if (initial)
    return {
      action: 'start',
      orderId: initial[1]!,
      poolId: null,
      expectedPoolVersion: null,
      expectedOrderVersion: Number(initial[2])
    };
  initial = /^bc:sp:r:([^:]+):([^:]+):v(\d+):o(\d+)$/u.exec(value);
  if (initial)
    return {
      action: 'start',
      orderId: long(initial[1]!),
      poolId: long(initial[2]!),
      expectedPoolVersion: Number(initial[3]),
      expectedOrderVersion: Number(initial[4])
    };
  let match = /^bc:sp:a:([^:]+):([^:]+):([^:]+):v(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'apply',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      requirementId: long(match[3]!),
      expectedPoolVersion: Number(match[4])
    };
  match = /^bc:sp:m:([^:]+):([^:]+):v(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'apply-menu',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3])
    };
  match = /^bc:sp:w:([^:]+):([^:]+):([^:]+):v(\d+):a(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'withdraw',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      applicationId: long(match[3]!),
      expectedPoolVersion: Number(match[4]),
      expectedApplicationVersion: Number(match[5])
    };
  match = /^bc:sp:c:([^:]+):([^:]+):v(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'close',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3])
    };
  match = /^bc:sp:f:([^:]+):([^:]+):v(\d+):o(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'finalize',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3]),
      expectedOrderVersion: Number(match[4])
    };
  match = /^bc:sp:b:([^:]+):([^:]+):v(\d+):o(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'reselect',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3]),
      expectedOrderVersion: Number(match[4])
    };
  match = /^bc:sp:b:([^:]+):([^:]+)$/u.exec(value);
  if (match)
    return {
      action: 'reselect',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: null,
      expectedOrderVersion: null
    };
  match = /^bc:sp:pg:([^:]+):([^:]+):v(\d+):o(\d+):p(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'page',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3]),
      expectedOrderVersion: Number(match[4]),
      pageIndex: Number(match[5])
    };
  match = /^bc:sp:n:([^:]+):([^:]+):o(\d+):([A-Za-z0-9_-]+)$/u.exec(value);
  if (match)
    return {
      action: 'page',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: null,
      expectedOrderVersion: Number(match[3]),
      pageIndex: 1,
      legacyCursor: match[4]!
    };
  return { action: 'unknown' };
}
export function decodeSelectionId(value: string) {
  return long(value);
}

export function short(uuid: string) {
  if (!/^[0-9a-f-]{36}$/iu.test(uuid)) throw new Error('Invalid UUID.');
  return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url');
}

export function selectionPageCustomId(
  input: { orderId: string; poolId: string; poolVersion: number; orderVersion: number },
  pageIndex: number
) {
  return `bc:sp:pg:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}:p${pageIndex}`;
}

export function normalizeSelectedCandidates(input: {
  items: SelectionCandidate[];
  selectedApplicationIds: string[];
  selectedCandidates?: Array<{ id: string; playerDisplayName: string }>;
}) {
  const labels = new Map(input.items.map((item) => [item.id, item.playerDisplayName]));
  const selected =
    input.selectedCandidates ??
    input.selectedApplicationIds.map((id, index) => ({
      id,
      playerDisplayName: labels.get(id) ?? `已选陪玩 ${index + 1}`
    }));
  const unique = new Map(selected.map((candidate) => [candidate.id, candidate.playerDisplayName]));
  if (unique.size > 25) throw new Error('Selection context exceeds the Discord component limit.');
  return [...unique].map(([id, playerDisplayName]) => ({ id, playerDisplayName }));
}

export function* walkComponents(components: readonly unknown[]): Generator<unknown> {
  for (const component of components) {
    yield component;
    const children = (component as { components?: readonly unknown[] } | null)?.components;
    if (children) yield* walkComponents(children);
  }
}
export function long(value: string) {
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) throw new Error('Invalid compact UUID.');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
