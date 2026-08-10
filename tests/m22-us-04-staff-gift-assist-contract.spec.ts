import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M22-US-04 direct staff-assisted gift authorization contract', () => {
  test('freezes product choice B and the low-click Discord evidence flow', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    const design = read('outputs/P0开发交付包/01-UIUX/独立送礼与匿名模式交互设计.md');
    for (const phrase of [
      '模式 B',
      '直接预留老板余额',
      '消息右键菜单',
      '客户授权消息',
      '六位 TOTP',
      '必填原因'
    ]) {
      expect(`${spec}\n${design}`).toContain(phrase);
    }
    expect(design).toContain('客服最终确认人');
    expect(design).not.toContain('产品决定冻结前');
  });

  test('defines a Discord-only challenge-bound API that never accepts senderId', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    for (const operationId of [
      'createStaffGiftAssistChallenge',
      'getStaffGiftAssistChallenge',
      'checkStaffGiftAssistAffordability',
      'createStaffAssistedGiftRequest'
    ]) {
      expect(openapi).toContain(`operationId: ${operationId}`);
    }
    expect(openapi).toContain('x-required-permissions: [gift.assist]');
    expect(openapi).toContain('customerDiscordUserId');
    expect(openapi).toContain('authorizationMessageId');
    expect(openapi).toContain('authorizationReason');
    expect(openapi).toContain('totpCode');
    expect(openapi).toContain('senderId is never accepted');
    expect(openapi).toContain('direct-staff-confirmation-with-totp');
  });

  test('persists immutable assisted attribution and a bounded single-use challenge', () => {
    const schema = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    expect(schema).toContain('enum GiftRequestInitiatorMode');
    expect(schema).toContain('STAFF_ASSISTED');
    expect(schema).toContain('model StaffGiftAssistChallenge');
    for (const field of [
      'initiatorMode',
      'assistedByStaffId',
      'giftAssistChallengeId',
      'authorizationChannelId',
      'authorizationMessageId',
      'authorizationReason',
      'failedAttempts',
      'permissionsVersion',
      'consumedAt'
    ]) {
      expect(schema).toContain(field);
    }
  });

  test('adds dedicated RBAC, interaction and acceptance traceability', () => {
    const policy = read('outputs/P0开发交付包/05-业务配置/seed-data.csv');
    const config = read('outputs/P0开发交付包/05-业务配置/business-config.example.yaml');
    const configSchema = read('outputs/P0开发交付包/05-业务配置/business-config.schema.json');
    expect(policy).toContain('"permission_code","gift.assist","L1_SUPPORT"');
    expect(policy).toContain('"permission_code","mfa.manage_self","L1_SUPPORT"');
    expect(config).toContain('- gift.assist');
    expect(config.slice(config.indexOf('    L1_SUPPORT:'), config.indexOf('    L2_SUPERVISOR:'))).toContain('- mfa.manage_self');
    expect(configSchema).toContain('"gift.assist"');

    const interactions = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    expect(interactions).toContain('INT-G-M22-004');
    expect(interactions).toContain('createStaffAssistedGiftRequest');

    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    expect(acceptance).toContain('"AT-GIFT2-005"');
    expect(acceptance).toContain('客服本人 TOTP');
    expect(acceptance).toContain('未授权、错误或重放均不创建预留');
  });

  test('keeps all contract mirrors exact', () => {
    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/01-UIUX/独立送礼与匿名模式交互设计.md',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/03-数据模型/状态枚举与约束.md',
      'P0开发交付包/05-业务配置/seed-data.csv',
      'P0开发交付包/05-业务配置/business-config.example.yaml',
      'P0开发交付包/05-业务配置/business-config.schema.json',
      'P0开发交付包/05-业务配置/业务配置说明.html',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'P0开发交付包/07-验收测试/test-fixtures.json',
      'Codex-P0开发TODO.md'
    ]) {
      expect(read(`docs/${relative}`), relative).toBe(read(`outputs/${relative}`));
    }
  });
});
