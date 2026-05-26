import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { InMemoryAccountStore, getCurrentBalance } from '@blackcat/api/accounts';
import { TestWalletFunding } from './support/wallet-fixture';

const now = new Date('2026-07-21T12:00:00.000Z');

describe('M1-US-02 Discord identity and internal account summary', () => {
  test('resolves a trusted Guild Discord identity to one internal USD wallet', async () => {
    const store = new InMemoryAccountStore({ bindings: [{
      userId: '00000000-0000-0000-0000-000000001002', displayName: 'Customer', userStatus: 'ACTIVE', userVersion: 1,
      discordAccountId: '00000000-0000-0000-0000-000000001003', guildId: '900000000000001002',
      discordUserId: '900000000000001003', boundAt: now.toISOString()
    }] });
    const result = await getCurrentBalance({ store, walletFunding: new TestWalletFunding(12_300),
      actor: { source: 'DISCORD_BOT', actorUserId: null, actorStaffId: null, actorLevel: null,
        guildId: '900000000000001002', discordUserId: '900000000000001003', interactionId: null,
        permissions: ['account.self.read'], permissionsVersion: null }, now });
    expect(result).toMatchObject({ ledgerBalanceMinor: 12_300, reservedMinor: 0, availableMinor: 12_300, currency: 'USD' });
  });

  test('contains no self-service payment-platform binding operation', () => {
    const accountSource = readFileSync('apps/api/src/accounts.ts', 'utf8');
    const api = readFileSync('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8');
    expect(`${accountSource}\n${api}`).not.toMatch(/createBinding|\/api\/v1\/bindings|ONE_TIME_CODE/u);
  });
});
