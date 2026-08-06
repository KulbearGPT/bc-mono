import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M21-US-01 optional order experience review contract', () => {
  test('defines an ordered M21 review epic without changing the gift contract', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    expect(backlog).toContain('"EP-M21","EPIC","M21"');
    for (let story = 1; story <= 5; story += 1) {
      expect(backlog).toContain(`"M21-US-${String(story).padStart(2, '0')}"`);
    }
    expect(backlog).toContain('订单整体、有效陪玩与实际客服均为可选评价对象');
    expect(backlog).toContain('礼物合同与运行时不在 M21 范围内');
  });

  test('freezes low-friction optional rating and public five-star privacy boundaries', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    for (const phrase of [
      'M21：低负担完单评价与五星好评播报',
      '订单整体、每位有效陪玩和本单实际客服',
      '全部可选',
      '星级点击成功即保存',
      '留言始终可选',
      '明确同意公开',
      '不得公开一至四星',
      '不得公开未评价对象',
      '不自动影响派单、准入、收益、权限、处罚或资金'
    ]) expect(spec).toContain(phrase);
  });

  test('publishes target-scoped append-only data and API contracts', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    for (const operationId of [
      'getOrderExperienceReview',
      'createOrderExperienceRating',
      'appendOrderExperienceReviewComment',
      'publishOrderFiveStarReview'
    ]) expect(openapi).toContain(`operationId: ${operationId}`);
    expect(openapi).toContain('ExperienceReviewTargetType');
    expect(openapi).toContain('ORDER, PLAYER, SUPPORT');

    const schema = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    expect(schema).toContain('enum ExperienceReviewTargetType');
    expect(schema).toContain('model OrderExperienceReview');
    expect(schema).toContain('model OrderExperienceReviewComment');
    expect(schema).toContain('model OrderReviewPublication');
    expect(schema).toContain('orderParticipantId');
    expect(schema).toContain('attributedStaffId');

    const constraints = read('outputs/P0开发交付包/03-数据模型/状态枚举与约束.md');
    expect(constraints).toContain('任一目标无效时整批零写入');
    expect(constraints).toContain('保存五星本身不等于公开同意');

    const config = read('outputs/P0开发交付包/05-业务配置/business-config.example.yaml');
    const configSchema = read('outputs/P0开发交付包/05-业务配置/business-config.schema.json');
    expect(config).toContain('review_broadcast_channel_id:');
    expect(config).toContain('five_star_review_broadcast:');
    expect(configSchema).toContain('"order.experience_review.publish"');
  });

  test('adds Discord interaction and acceptance traceability', () => {
    const design = read('outputs/P0开发交付包/01-UIUX/订单评价交互设计.md');
    expect(design).toContain('只评订单整体 | 1');
    expect(design).toContain('两位好评、一位差评 | 4');
    expect(design).toContain('不得通过人数、占位符或“另有评价”等文字暗示');
    const interaction = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    for (const id of ['INT-D-M21-001', 'INT-D-M21-002', 'INT-D-M21-003']) {
      expect(interaction).toContain(id);
    }
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (const id of ['AT-REVIEW-001', 'AT-REVIEW-002', 'AT-REVIEW-003', 'AT-REVIEW-004']) {
      expect(acceptance).toContain(`"${id}"`);
    }
  });

  test('keeps every edited published mirror byte-identical', () => {
    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/01-UIUX/订单评价交互设计.md',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/03-数据模型/状态枚举与约束.md',
      'P0开发交付包/05-业务配置/business-config.schema.json',
      'P0开发交付包/05-业务配置/business-config.example.yaml',
      'P0开发交付包/05-业务配置/seed-data.csv',
      'P0开发交付包/05-业务配置/业务配置说明.html',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv'
    ]) expect(read(`docs/${relative}`)).toBe(read(`outputs/${relative}`));

    const docsTodo = read('docs/Codex-P0开发TODO.md');
    const outputsTodo = read('outputs/Codex-P0开发TODO.md');
    expect(docsTodo.slice(docsTodo.indexOf('## M21：')))
      .toBe(outputsTodo.slice(outputsTodo.indexOf('## M21：')));
  });
});
