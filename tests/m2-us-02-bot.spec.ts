import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';

describe('M2-US-02 Bot dispatch card', () => {
  test('removes the retired direct accept/decline Bot client path', async () => {
    const source = await readFile('apps/bot/src/service-center-api.ts', 'utf8');
    expect(source).not.toContain('acceptOrder(');
    expect(source).not.toContain('declineOrderOffer(');
    expect(source).toContain('applyToSelectionPool(');
    expect(source).toContain('withdrawSelectionApplication(');
  });

  test('registers a Sapphire dispatch interaction handler', async () => {
    const manifest = await discoverSapphirePieces();
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts', 'utf8');

    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'interaction-handlers',
          name: 'dispatch-buttons'
        })
      ])
    );
    expect(source).toContain('applyToSelectionPool');
    expect(source).toContain('withdrawSelectionApplication');
    expect(source).not.toContain('acceptOrder(');
    expect(source).toContain('buildDiscordIdempotencyKey');
  });
});
