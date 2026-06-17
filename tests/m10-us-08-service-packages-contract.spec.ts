import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFile(path, 'utf8');

describe('M10-US-08 versioned service package contract', () => {
  test('freezes package templates as a layer above independently editable order requirements', async () => {
    const [spec, backlog, interaction, acceptance, schema] = await Promise.all([
      read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html'),
      read('outputs/P0开发交付包/06-开发计划/backlog.csv'),
      read('outputs/P0开发交付包/01-UIUX/交互映射.csv'),
      read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv'),
      read('outputs/P0开发交付包/03-数据模型/schema.prisma')
    ]);

    expect(spec).toContain('套餐模板只是订单需求购物篮的版本化生成器');
    expect(backlog).toContain('M10-US-08');
    expect(interaction).toContain('套餐订单编排器');
    expect(acceptance).toContain('AT-MULTI-008');
    expect(schema).toContain('model ServicePackageVersion');
    expect(schema).toContain('model ServicePackageSlot');
    expect(schema).toContain('sourcePackageVersionId');
    expect(schema).toContain('sourcePackageSlotId');
  });

  test('exposes discover, preview and atomic apply operations without accepting client prices', async () => {
    const openapi = await read('outputs/P0开发交付包/02-API/openapi.yaml');
    expect(openapi).toContain('operationId: listServicePackages');
    expect(openapi).toContain('operationId: previewServicePackage');
    expect(openapi).toContain('operationId: applyServicePackage');
    expect(openapi).toContain('compositionMode');
    expect(openapi).toContain('PACKAGE_DEFAULT');
    expect(openapi).toContain('CUSTOMIZED');
    expect(openapi).toContain('ApplyServicePackageRequest');
    expect(openapi).not.toMatch(/ApplyServicePackageRequest:[\s\S]{0,900}(?:amountMinor|customerUnitPriceMinor|estimatedLinePriceMinor):/);
  });
});
