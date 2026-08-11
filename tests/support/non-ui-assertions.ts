import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

export type BusinessSnapshot = Record<string, unknown[]>;

export async function snapshotBusinessFacts(database: Pool | PoolClient, tables: string[]): Promise<BusinessSnapshot> {
  const snapshot: BusinessSnapshot = {};
  for (const table of [...new Set(tables)].sort()) {
    if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new Error(`Unsafe snapshot table: ${table}`);
    const exists = await database.query(`SELECT to_regclass($1) relation`, [`public.${table}`]);
    if (exists.rows[0]?.relation === null) throw new Error(`Snapshot table does not exist: ${table}`);
    const result = await database.query(`SELECT to_jsonb(row_value) value FROM (SELECT * FROM "${table}") row_value
      ORDER BY to_jsonb(row_value)::text`);
    snapshot[table] = result.rows.map(({ value }) => value);
  }
  return snapshot;
}

export function expectNoBusinessWrites(before: BusinessSnapshot, after: BusinessSnapshot): void {
  assert.deepEqual(after, before, 'Expected business facts to remain unchanged.');
}

export function expectAppendOnlyDelta(
  before: BusinessSnapshot,
  after: BusinessSnapshot,
  allowedAdds: Record<string, number>
): void {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'Snapshot table set changed.');
  for (const table of Object.keys(before)) {
    const oldRows = before[table] ?? [];
    const newRows = after[table] ?? [];
    const remaining = new Map<string, number>();
    for (const row of newRows) {
      const key = JSON.stringify(row);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const row of oldRows) {
      const key = JSON.stringify(row);
      const count = remaining.get(key) ?? 0;
      assert.equal(count > 0, true, `${table} rewrote or removed prior facts.`);
      remaining.set(key, count - 1);
    }
    assert.equal(newRows.length - oldRows.length, allowedAdds[table] ?? 0, `${table} append count mismatch.`);
  }
}

export function expectWalletInvariant(wallet: {
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: string;
}): void {
  for (const field of ['ledgerBalanceMinor', 'reservedMinor', 'availableMinor'] as const) {
    assert.equal(Number.isSafeInteger(wallet[field]), true, `${field} must be a safe integer.`);
  }
  assert.equal(wallet.currency, 'CAT', 'Internal wallet currency must be CAT.');
  assert.equal(wallet.reservedMinor >= 0, true, 'reservedMinor must not be negative.');
  assert.equal(
    wallet.availableMinor,
    wallet.ledgerBalanceMinor - wallet.reservedMinor,
    'availableMinor must equal ledgerBalanceMinor - reservedMinor.'
  );
  assert.equal(wallet.availableMinor >= 0, true, 'availableMinor must not be negative.');
}

export function expectAuditAtomicity(input: {
  businessWrites: number;
  successAuditWrites: number;
  rejectedAuditWrites: number;
}): void {
  if (input.businessWrites > 0) {
    assert.equal(input.successAuditWrites, 1, 'Successful business writes require exactly one success audit.');
    assert.equal(input.rejectedAuditWrites, 0, 'A successful action cannot also record a rejected audit.');
  } else {
    assert.equal(input.successAuditWrites, 0, 'A zero-write action cannot record a success audit.');
    assert.equal(input.rejectedAuditWrites <= 1, true, 'A rejection may record at most one attempt audit.');
  }
}

export function expectIdempotentReplay(input: {
  firstObjectId: string;
  replayObjectId: string;
  firstSideEffectCount: number;
  replaySideEffectCount: number;
}): void {
  assert.equal(input.replayObjectId, input.firstObjectId, 'Idempotent replay returned another object.');
  assert.equal(input.replaySideEffectCount, input.firstSideEffectCount, 'Idempotent replay added side effects.');
}

export function expectGuildIsolation(input: {
  listRows: unknown[];
  detailVisible: boolean;
  businessWriteDelta: number;
}): void {
  assert.equal(input.listRows.length, 0, 'Cross-Guild list exposed rows.');
  assert.equal(input.detailVisible, false, 'Cross-Guild detail was enumerable.');
  assert.equal(input.businessWriteDelta, 0, 'Cross-Guild attempt changed business facts.');
}

export function expectOutboxConvergence(input: {
  businessWrites: number;
  deliveredEffects: number;
  activeOutboxFacts: number;
}): void {
  assert.equal(input.businessWrites, 1, 'Recovery must not replay the business write.');
  assert.equal(input.deliveredEffects, 1, 'Recovery must converge to one external effect.');
  assert.equal(input.activeOutboxFacts, 1, 'Recovery must retain one active outbox fact.');
}

export function expectPrivacyAllowlist(value: unknown, allowedKeys: string[]): void {
  const allowed = new Set(allowedKeys);
  const forbiddenKey = /(?:totp|password|secret|receiptBody|accountNumber|privateKey|idempotencyKey)/iu;
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (current === null || typeof current !== 'object') return;
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      if (forbiddenKey.test(key)) throw new Error(`Sensitive field at ${path}.${key}`);
      if (!allowed.has(key)) throw new Error(`Field is not allowlisted at ${path}.${key}`);
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value, '$');
}
