import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const receiptMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ReceiptMediaType = typeof receiptMediaTypes[number];
const maximumReceiptBytes = 10_485_760;

export class ReceiptStorageError extends Error {}

export interface ReceiptStorage {
  put(input: { body: AsyncIterable<Uint8Array>; mediaType: ReceiptMediaType; originalFileName: string }): Promise<{ storageKey: string; byteSize: number; sha256: string }>;
  open(storageKey: string): Promise<AsyncIterable<Uint8Array>>;
}

export class PrivateFileReceiptStorage implements ReceiptStorage {
  constructor(private readonly root: string) {}

  async put(input: { body: AsyncIterable<Uint8Array>; mediaType: ReceiptMediaType; originalFileName: string }) {
    if (!receiptMediaTypes.includes(input.mediaType)) throw new ReceiptStorageError('Unsupported receipt media type.');
    if (!input.originalFileName.trim() || input.originalFileName.length > 255) throw new ReceiptStorageError('Invalid receipt file name.');
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    const digest = createHash('sha256');
    for await (const chunk of input.body) {
      byteSize += chunk.byteLength;
      if (byteSize > maximumReceiptBytes) throw new ReceiptStorageError('Receipt exceeds 10485760 bytes.');
      digest.update(chunk);
      chunks.push(chunk);
    }
    if (byteSize < 1) throw new ReceiptStorageError('Receipt is empty.');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const storageKey = randomUUID();
    const handle = await open(join(this.root, storageKey), 'wx', 0o600);
    try { await handle.writeFile(Buffer.concat(chunks)); } finally { await handle.close(); }
    return { storageKey, byteSize, sha256: digest.digest('hex') };
  }

  async open(storageKey: string): Promise<AsyncIterable<Uint8Array>> {
    if (!/^[0-9a-f-]{36}$/iu.test(storageKey)) throw new ReceiptStorageError('Invalid storage key.');
    const body = await readFile(join(this.root, storageKey));
    return (async function* () { yield body; })();
  }
}
