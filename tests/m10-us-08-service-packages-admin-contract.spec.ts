import { readFile } from 'node:fs/promises';
import { describe,expect,test } from 'vitest';

describe('M10-US-08 package administration contract',()=>{
  test('freezes immutable Dashboard package version lifecycle',async()=>{
    const [spec,openapi,backlog,mapping,acceptance]=await Promise.all([
      readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html','utf8'),
      readFile('outputs/P0开发交付包/02-API/openapi.yaml','utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv','utf8'),
      readFile('outputs/P0开发交付包/01-UIUX/交互映射.csv','utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv','utf8')]);
    expect(spec).toContain('套餐由 Dashboard 运营端维护，不硬编码在 Bot');
    expect(openapi).toContain('operationId: listAdminServicePackages');
    expect(openapi).toContain('operationId: createAdminServicePackageVersion');
    expect(openapi).toContain('operationId: updateAdminServicePackageVersionStatus');
    expect(openapi).toContain('active-service-versions-only');
    expect(openapi).toContain('append-only-version-history');
    expect(openapi).toContain('Clients cannot submit this field.');
    expect(openapi).not.toMatch(/CreateAdminServicePackageVersionRequest:[\s\S]{0,900}defaultCustomerPriceMinor:/);
    expect(backlog).toContain('AT-MULTI-010');
    expect(mapping).toContain('INT-A-064');
    expect(acceptance).toContain('SERVICE_PACKAGE_VERSION_ADMIN');
  });
});
