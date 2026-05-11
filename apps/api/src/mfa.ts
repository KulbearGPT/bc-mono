import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function buildTotpProvisioningUri(input: { secret: string; accountName: string; issuer: string }): string {
  const label = `${input.issuer}:${input.accountName}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function verifyTotp(proof: string, secret: string, now = new Date()): boolean {
  if (!/^\d{6}$/.test(proof)) return false;
  const counter = Math.floor(now.getTime() / 30_000);
  for (const offset of [-1, 0, 1]) {
    if (safeEqual(proof, totpAt(secret, counter + offset))) return true;
  }
  return false;
}

export function encryptSecret(secret: string, encryptionKey: string): string {
  const key = createHash('sha256').update(encryptionKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(value: string, encryptionKey: string): string {
  const [ivValue, tagValue, ciphertextValue] = value.split('.');
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error('MFA_SECRET_INVALID');
  const key = createHash('sha256').update(encryptionKey).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => randomBytes(6).toString('hex').toUpperCase());
}

export function hashRecoveryCode(code: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${normalizeRecoveryCode(code)}`).digest('hex');
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function totpAt(secret: string, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of input.replace(/=+$/g, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('MFA_SECRET_INVALID');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
