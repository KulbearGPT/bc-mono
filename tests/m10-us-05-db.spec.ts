import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M10-US-05 multi-recipient gift persistence contract', () => {
  test('links each new gift fact to its immutable order participant', async () => {
    const [migration, runtimeSchema, contractSchema] = await Promise.all([
      readFile('database/prisma/migrations/000026_multi_recipient_gifts/migration.sql', 'utf8'),
      readFile('database/prisma/schema.prisma', 'utf8'),
      readFile('outputs/P0开发交付包/03-数据模型/schema.prisma', 'utf8')
    ]);
    expect(migration).toContain('gift_requests_order_participant_id_fkey');
    expect(migration).toContain('gift_requests_order_participant_id_created_at_idx');
    expect(runtimeSchema).toMatch(/model GiftRequest[\s\S]*orderParticipantId/u);
    expect(contractSchema).toMatch(/model GiftRequest[\s\S]*orderParticipantId/u);
  });
});
