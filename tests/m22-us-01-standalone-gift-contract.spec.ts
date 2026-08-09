import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M22-US-01 standalone and anonymous gift contract', () => {
  test('replaces the order-only guard with dual-source trusted-recipient rules', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('P0 礼物支持订单内与独立入口两种来源');
    expect(agents).toContain('独立入口只接受 API 返回的同 Guild 有效陪玩 playerProfileId');
    expect(agents).toContain('不得接受任意 receiverId');
    expect(agents).not.toContain('P0 礼物只能从符合条件的订单发起');
  });

  test('freezes a five-story M22 epic and the standalone low-click interaction', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    expect(backlog).toContain('"EP-M22","EPIC","M22"');
    for (let story = 1; story <= 5; story += 1)
      expect(backlog).toContain(`"M22-US-${String(story).padStart(2, '0')}"`);
    const design = read('outputs/P0开发交付包/01-UIUX/独立送礼与匿名模式交互设计.md');
    for (const phrase of [
      '送礼常驻消息',
      '选择一位陪玩',
      '选择礼物',
      '匿名赠送',
      '余额不足',
      '刷新余额',
      '不创建礼物、预留或客服任务'
    ])
      expect(design).toContain(phrase);
  });

  test('defines standalone API, data, configuration and privacy contracts', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    for (const operationId of ['getStandaloneGiftCenter', 'checkStandaloneGiftAffordability', 'createStandaloneGiftRequest'])
      expect(openapi).toContain(`operationId: ${operationId}`);
    expect(openapi).toContain('playerProfileId');
    expect(openapi).toContain('anonymous');
    expect(openapi).toContain('receiverId is never accepted');

    const schema = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    expect(schema).toContain('enum GiftRequestOrigin');
    expect(schema).toContain('enum GiftSenderVisibility');
    expect(schema).toContain('guildId');
    expect(schema).toContain('origin');
    expect(schema).toContain('senderVisibility');
    expect(schema).toContain('model GuildGiftEntryMessage');

    const config = read('outputs/P0开发交付包/05-业务配置/business-config.example.yaml');
    expect(config).toContain('gift_entry_channel_id:');
  });

  test('makes anonymity presentation-only and preserves internal accountability', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    for (const phrase of [
      'M22：独立送礼入口与匿名模式',
      '订单内送礼继续保留',
      '匿名只影响面向陪玩与公共频道的展示',
      '客服、资金、风控和审计仍使用真实 sender_id',
      '匿名老板'
    ])
      expect(spec).toContain(phrase);
  });

  test('adds traceable acceptance and keeps all edited mirrors exact', () => {
    const interactions = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    for (const id of ['INT-G-M22-001', 'INT-G-M22-002', 'INT-G-M22-003']) expect(interactions).toContain(id);
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (const id of ['AT-GIFT2-001', 'AT-GIFT2-002', 'AT-GIFT2-003', 'AT-GIFT2-004'])
      expect(acceptance).toContain(`"${id}"`);

    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/01-UIUX/独立送礼与匿名模式交互设计.md',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/03-数据模型/状态枚举与约束.md',
      'P0开发交付包/05-业务配置/business-config.schema.json',
      'P0开发交付包/05-业务配置/business-config.example.yaml',
      'P0开发交付包/05-业务配置/seed-data.csv',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'Codex-P0开发TODO.md'
    ])
      expect(read(`docs/${relative}`), relative).toBe(read(`outputs/${relative}`));
  });
});
