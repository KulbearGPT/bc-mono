import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M12-US-01 minimal support operations contract', () => {
  test('assigns support operations to M12 without reusing the multi-player M10 or selection M11 stories', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    expect(backlog).toContain('"EP-M12"');
    expect(backlog).toContain('"M12-US-01"');
    expect(backlog).toContain('"M12-US-02"');
    expect(backlog).toContain('"M12-US-03"');
    expect(backlog).toContain('"M12-US-04"');
    expect(backlog).toContain('"M10-US-03","USER_STORY","M10","EP-M10","客服多陪玩管理与逐人计价"');
    expect(backlog).toContain('"M11-US-03","USER_STORY","M11","EP-M11","Discord 选秀面板、语音与客服通知"');
  });

  test('freezes the small-team attendance, response, auto-claim and rating boundaries', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    expect(spec).toContain('M12：轻量客服打卡、首响自动认领与态度评分');
    expect(spec).toContain('任何等级（L1–L4）的 ACTIVE 内部员工');
    expect(spec).toContain('自动认领最早创建的一条 OPEN 任务');
    expect(spec).toContain('订单级 StaffTask');
    expect(spec).toContain('不绑定某个 OrderParticipant');
    expect(spec).toContain('不自动处罚');
  });

  test('publishes the API and data contracts under the current order model', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    for (const operationId of ['getMySupportShift', 'clockInSupportShift', 'clockOutSupportShift', 'getSupportSummary', 'createOrderSupportRating']) {
      expect(openapi).toContain(`operationId: ${operationId}`);
    }
    expect(openapi).toContain('operationId: appendOrderChannelMessageEvent');
    expect(openapi).toContain('without replacing an existing owner');

    const schema = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    expect(schema).toContain('enum SupportResponseStatus');
    expect(schema).toContain('model SupportShift');
    expect(schema).toContain('model OrderSupportRating');
    expect(schema).toContain('firstResponseEventId');
  });

  test('adds acceptance traceability and keeps published mirrors exact', () => {
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (const id of ['AT-SUP-010', 'AT-SUP-011', 'AT-SUP-012', 'AT-SUP-013']) expect(acceptance).toContain(`"${id}"`);
    expect(acceptance).toContain('已有负责人不被覆盖');
    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'Codex-P0开发TODO.md',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv'
    ]) expect(read(`docs/${relative}`)).toBe(read(`outputs/${relative}`));
  });
});
