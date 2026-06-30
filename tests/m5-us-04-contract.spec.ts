import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M5-US-04 Sandbox Pilot contracts after M9 supersession', () => {
  it('retires production pilot phases and the sandbox funding provider contract', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const prisma = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    const productionEnv = read('modules/platform/src/production-env.js');

    for (const id of ['M9-US-01', 'M9-US-02', 'M9-US-03', 'M9-US-04', 'M9-US-05', 'M9-US-06', 'M9-US-07']) {
      expect(backlog).toContain(id);
    }
    expect(openapi).not.toContain('operationId: getSandboxFundingAccount');
    expect(openapi).not.toContain('operationId: setSandboxTargetBalance');
    expect(openapi).toContain('operationId: createAdminTopUp');
    expect(openapi).toContain('operationId: registerCurrentDiscordPlayer');
    expect(productionEnv).not.toContain('PILOT_PHASE');
    expect(productionEnv).not.toContain('CORE_ORDER_AND_GIFTS');
    expect(prisma).not.toContain('model SandboxProviderAccount');
    expect(prisma).not.toContain('model SandboxProviderBalanceAdjustment');
    expect(prisma).not.toContain('model SandboxProviderTransaction');
    expect(backlog).not.toContain('sandbox_funding.manage');
    for (const id of ['AT-ONB-001', 'AT-ONB-005', 'AT-WLT-011', 'AT-WLT-012', 'AT-CAT-005']) {
      expect(acceptance).toContain(id);
    }
  });
});
