import { createHash } from 'node:crypto';

export type AuditChangeType =
  | 'CREATE'
  | 'UPDATE'
  | 'APPEND'
  | 'STATE_TRANSITION'
  | 'INVALIDATE';

export interface AuditChangeInput {
  targetType: string;
  targetId: string;
  changeType: AuditChangeType;
  beforeSnapshot: unknown | null;
  afterSnapshot: unknown | null;
  changedFields: string[];
}

const sensitiveKey = /password|token|secret|cookie|authorization|cvv|cardnumber|filebody|signedurl/i;
const maximumSnapshotBytes = 64 * 1024;

export function redactAuditSnapshot(snapshot: unknown): unknown {
  if (snapshot == null) return snapshot;
  const redacted = redactValue(snapshot, new WeakSet<object>(), 0);
  const serialized = safeSerialize(redacted);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maximumSnapshotBytes) return redacted;
  return {
    truncated: true,
    byteLength,
    sha256: createHash('sha256').update(serialized).digest('hex')
  };
}

export function buildPrimaryAuditChange(input: {
  targetType: string;
  targetId: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  changeType?: AuditChangeType;
  changedFields?: string[];
}): AuditChangeInput {
  const beforeSnapshot = input.beforeSnapshot ?? null;
  const afterSnapshot = input.afterSnapshot ?? null;
  return {
    targetType: requireIdentity(input.targetType, 'targetType'),
    targetId: requireIdentity(input.targetId, 'targetId'),
    changeType: input.changeType ?? (beforeSnapshot == null ? 'APPEND' : 'UPDATE'),
    beforeSnapshot: redactAuditSnapshot(beforeSnapshot),
    afterSnapshot: redactAuditSnapshot(afterSnapshot),
    changedFields: normalizeChangedFields(
      input.changedFields ?? inferChangedFields(beforeSnapshot, afterSnapshot)
    )
  };
}

export function normalizeAuditChanges(changes: AuditChangeInput[]): AuditChangeInput[] {
  return changes.map((change) => ({
    targetType: requireIdentity(change.targetType, 'targetType'),
    targetId: requireIdentity(change.targetId, 'targetId'),
    changeType: change.changeType,
    beforeSnapshot: redactAuditSnapshot(change.beforeSnapshot),
    afterSnapshot: redactAuditSnapshot(change.afterSnapshot),
    changedFields: normalizeChangedFields(change.changedFields)
  }));
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= 20) return '[Maximum depth]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key)) continue;
    output[key] = redactValue(item, seen, depth + 1);
  }
  seen.delete(value);
  return output;
}

function inferChangedFields(beforeSnapshot: unknown, afterSnapshot: unknown): string[] {
  const keys = new Set<string>();
  if (isRecord(beforeSnapshot)) for (const key of Object.keys(beforeSnapshot)) keys.add(key);
  if (isRecord(afterSnapshot)) for (const key of Object.keys(afterSnapshot)) keys.add(key);
  return [...keys];
}

function normalizeChangedFields(fields: string[]): string[] {
  return [...new Set(fields.map((field) => field.trim()).filter(Boolean))].sort();
}

function requireIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Audit change ${field} is required.`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationFailed: true });
  }
}
