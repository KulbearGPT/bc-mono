import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M4-US-03 complete administrative detail contract', () => {
  test('keeps contract mirrors aligned and exposes dedicated detail operations', async () => {
    const [docs, outputs] = await Promise.all([
      readFile(resolve(root, 'docs/P0开发交付包/02-API/openapi.yaml'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/02-API/openapi.yaml'), 'utf8')
    ]);
    expect(docs).toBe(outputs);
    for (const operationId of ['getAdminUser', 'getAdminPlayer', 'getAdminServiceCatalogVersion', 'getAdminServicePackageVersion', 'getAdminGiftCatalogItem', 'getAdminGiftRequest']) {
      expect(outputs).toContain(`operationId: ${operationId}`);
    }
  });

  test('defines identity-rich user and player projections without changing selection eligibility', async () => {
    const openapi = await readFile(resolve(root, 'outputs/P0开发交付包/02-API/openapi.yaml'), 'utf8');
    expect(openapi).toMatch(/AdminUser:[\s\S]*?discordUserId[\s\S]*?discordUsername[\s\S]*?createdAt[\s\S]*?updatedAt/u);
    expect(openapi).toMatch(/AdminPlayer:[\s\S]*?userId[\s\S]*?displayName[\s\S]*?discordUserId[\s\S]*?discordUsername[\s\S]*?availability[\s\S]*?discordPresence[\s\S]*?gameTagDetails[\s\S]*?serviceTagDetails[\s\S]*?languageTagDetails[\s\S]*?createdAt[\s\S]*?updatedAt/u);
    expect(openapi).toMatch(/PlayerProfile:[\s\S]*?reviewStatus[\s\S]*?gameTags/u);
  });

  test('returns complete version metadata for catalog and package details', async () => {
    const openapi = await readFile(resolve(root, 'outputs/P0开发交付包/02-API/openapi.yaml'), 'utf8');
    expect(openapi).toMatch(/AdminServiceCatalog:[\s\S]*?offeringKey[\s\S]*?status[\s\S]*?defaultPlayerPayoutBps[\s\S]*?createdByStaffId[\s\S]*?activatedAt[\s\S]*?retiredAt/u);
    expect(openapi).toMatch(/AdminServicePackage:[\s\S]*?status[\s\S]*?slots[\s\S]*?createdByStaffId[\s\S]*?createdAt[\s\S]*?activatedAt[\s\S]*?retiredAt/u);
  });

  test('returns complete catalog-version and review context for gift details', async () => {
    const openapi = await readFile(resolve(root, 'outputs/P0开发交付包/02-API/openapi.yaml'), 'utf8');
    expect(openapi).toMatch(/AdminGiftCatalogItem:[\s\S]*?giftCatalogVersionId[\s\S]*?status[\s\S]*?giftCategoryTagDetails[\s\S]*?createdByStaffId[\s\S]*?activatedAt[\s\S]*?retiredAt[\s\S]*?archivedAt/u);
    expect(openapi).toMatch(/AdminGiftRequest:[\s\S]*?orderPublicId[\s\S]*?orderParticipantId[\s\S]*?giftCatalogVersionId[\s\S]*?giftCode[\s\S]*?senderDisplayName[\s\S]*?senderDiscordUserId[\s\S]*?receiverDisplayName[\s\S]*?receiverDiscordUserId[\s\S]*?reservationStatus[\s\S]*?verifiedAt[\s\S]*?approvedAt[\s\S]*?capturedAt[\s\S]*?announcedAt[\s\S]*?expiresAt[\s\S]*?updatedAt/u);
  });

  test('traces the four detail projections through interaction, backlog and acceptance contracts', async () => {
    const [interaction, backlog, acceptance] = await Promise.all([
      readFile(resolve(root, 'outputs/P0开发交付包/01-UIUX/交互映射.csv'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/06-开发计划/backlog.csv'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/07-验收测试/acceptance-cases.csv'), 'utf8')
    ]);
    for (const operationId of ['getAdminUser', 'getAdminPlayer', 'getAdminServiceCatalogVersion', 'getAdminServicePackageVersion', 'getAdminGiftCatalogItem', 'getAdminGiftRequest']) {
      expect(interaction).toContain(operationId);
      expect(backlog).toContain(operationId);
    }
    expect(acceptance).toContain('AT-DTL-001');
  });
});
