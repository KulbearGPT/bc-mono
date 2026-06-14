import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M10-US-07 multi-project order requirement contract', () => {
  test('separates customer demand from assigned players and freezes slot dispatch operations', async () => {
    const [openapi, prisma, interaction, acceptance] = await Promise.all([
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/03-数据模型/schema.prisma', 'utf8'),
      readFile('outputs/P0开发交付包/01-UIUX/交互映射.csv', 'utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8')
    ]);

    expect(openapi).toContain('operationId: addOrderRequirement');
    expect(openapi).toContain('operationId: updateOrderRequirement');
    expect(prisma).toContain('model OrderRequirement');
    expect(prisma).toContain('orderRequirementId');
    expect(interaction).toContain('多项目订单需求编排器');
    expect(acceptance).toContain('AT-MULTI-006');
    expect(acceptance).toContain('AT-MULTI-007');
  });

  test('provides a complete append-only migration for demand and participant linkage', async () => {
    const migration = await readFile(
      'database/prisma/migrations/000022_order_requirements/migration.sql',
      'utf8'
    );

    expect(migration).toContain('CREATE TABLE order_requirements');
    expect(migration).toContain('CREATE TABLE order_requirement_events');
    expect(migration).toContain('order_requirement_id');
    expect(migration).toContain('requested_player_count > 0');
    expect(migration).toContain('estimated_line_price_minor > 0');
    expect(migration).toContain('deny_append_only_mutation');
  });
});
