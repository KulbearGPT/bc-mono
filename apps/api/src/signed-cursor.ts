import { createHmac, timingSafeEqual } from 'node:crypto';

export type CursorScope = 'customer-orders' | 'account-consumptions' | 'account-commissions' | 'weekly-reports' | 'wallet-entries' | 'approval-requests';

const scopeCodes: Record<CursorScope, number> = {
  'customer-orders': 1,
  'account-consumptions': 2,
  'account-commissions': 3,
  'weekly-reports': 4,
  'wallet-entries': 5,
  'approval-requests': 6
};
const version = 1;
const keysetKind = 1;
const offsetKind = 2;
const signatureLength = 16;
let signingKey = Buffer.from('blackcat-test-cursor-signing-key-v1');

export function configureCursorSigningSecret(secret: string): void {
  if (!secret.trim()) throw new Error('Pagination cursor signing secret is required.');
  signingKey = createHmac('sha256', secret).update('blackcat-pagination-cursor-v1').digest();
}

export function encodeKeysetCursor(scope: CursorScope, value: { id: string; at: string }): string {
  const id = uuidBytes(value.id);
  const milliseconds = Date.parse(value.at);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('Cursor timestamp is invalid.');
  const payload = Buffer.alloc(27);
  payload[0] = version;
  payload[1] = scopeCodes[scope];
  payload[2] = keysetKind;
  payload.writeBigUInt64BE(BigInt(milliseconds), 3);
  id.copy(payload, 11);
  return encode(payload);
}

export function decodeKeysetCursor(token: string, scope: CursorScope): { id: string; at: string } {
  const payload = decode(token, scope, keysetKind, 27);
  const milliseconds = Number(payload.readBigUInt64BE(3));
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Cursor timestamp is invalid.');
  return { id: uuidString(payload.subarray(11, 27)), at: new Date(milliseconds).toISOString() };
}

export function encodeBoundKeysetCursor(
  scope: CursorScope,
  value: { id: string; at: string },
  binding: string
): string {
  const id = uuidBytes(value.id);
  const milliseconds = Date.parse(value.at);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('Cursor timestamp is invalid.');
  const payload = Buffer.alloc(43);
  payload[0] = version;
  payload[1] = scopeCodes[scope];
  payload[2] = keysetKind;
  payload.writeBigUInt64BE(BigInt(milliseconds), 3);
  id.copy(payload, 11);
  bindingSignature(binding).copy(payload, 27);
  return encode(payload);
}

export function decodeBoundKeysetCursor(
  token: string,
  scope: CursorScope,
  binding: string
): { id: string; at: string } {
  const payload = decode(token, scope, keysetKind, 43);
  if (!timingSafeEqual(payload.subarray(27, 43), bindingSignature(binding))) {
    throw new Error('Cursor binding is invalid.');
  }
  const milliseconds = Number(payload.readBigUInt64BE(3));
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Cursor timestamp is invalid.');
  return { id: uuidString(payload.subarray(11, 27)), at: new Date(milliseconds).toISOString() };
}

export function encodeOffsetCursor(scope: CursorScope, offset: number): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff_ffff) throw new Error('Cursor offset is invalid.');
  const payload = Buffer.alloc(7);
  payload[0] = version;
  payload[1] = scopeCodes[scope];
  payload[2] = offsetKind;
  payload.writeUInt32BE(offset, 3);
  return encode(payload);
}

export function decodeOffsetCursor(token: string, scope: CursorScope): number {
  return decode(token, scope, offsetKind, 7).readUInt32BE(3);
}

function encode(payload: Buffer): string {
  return `c1_${Buffer.concat([payload, signature(payload)]).toString('base64url')}`;
}

function decode(token: string, scope: CursorScope, kind: number, payloadLength: number): Buffer {
  if (!/^c1_[A-Za-z0-9_-]+$/u.test(token)) throw new Error('Cursor format is invalid.');
  const encoded = token.slice(3);
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error('Cursor encoding is invalid.');
  if (bytes.length !== payloadLength + signatureLength) throw new Error('Cursor length is invalid.');
  const payload = bytes.subarray(0, payloadLength);
  const actual = bytes.subarray(payloadLength);
  const expected = signature(payload);
  if (!timingSafeEqual(actual, expected) || payload[0] !== version || payload[1] !== scopeCodes[scope] || payload[2] !== kind) {
    throw new Error('Cursor signature is invalid.');
  }
  return payload;
}

function signature(payload: Buffer): Buffer {
  return createHmac('sha256', signingKey).update(payload).digest().subarray(0, signatureLength);
}

function bindingSignature(binding: string): Buffer {
  if (!binding) throw new Error('Cursor binding is required.');
  return createHmac('sha256', signingKey).update('binding\0').update(binding).digest().subarray(0, 16);
}

function uuidBytes(value: string): Buffer {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) throw new Error('Cursor ID is invalid.');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function uuidString(value: Buffer): string {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
