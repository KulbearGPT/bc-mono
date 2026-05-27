import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M5-US-04 Sandbox Pilot contracts', () => {
  it('binds stories, API operations, models, permissions, phases and acceptance cases', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const prisma = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');

    for (const id of ['M5-US-04', 'M5-US-05', 'M5-US-06', 'M5-US-07', 'M5-US-08', 'M5-US-09', 'M5-US-10']) {
      expect(backlog).toContain(id);
    }
    expect(openapi).toContain('operationId: getSandboxFundingAccount');
    expect(openapi).toContain('operationId: setSandboxTargetBalance');
    expect(openapi).toContain('phases: [CORE_ORDER, CORE_ORDER_AND_GIFTS, OFF]');
    expect(openapi).not.toContain('REPORTS_AND_PROFILES');
    expect(prisma).toContain('model SandboxProviderAccount');
    expect(prisma).toContain('model SandboxProviderBalanceAdjustment');
    expect(prisma).toContain('model SandboxProviderTransaction');
    expect(backlog).toContain('sandbox_funding.manage');
    expect(backlog).toContain('CORE_ORDER_AND_GIFTS');
    for (const id of ['AT-SBX-001', 'AT-SBX-002', 'AT-SBX-003', 'AT-SBX-004', 'AT-SBX-005', 'AT-RWY-001', 'AT-RWY-002', 'AT-PILOT-001', 'AT-PILOT-002']) {
      expect(acceptance).toContain(id);
    }
  });
});
