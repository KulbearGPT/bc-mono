import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M15-US-01 Dashboard support operations parity contract', () => {
  test('freezes the complete staff-operated Dashboard scope and excludes Dashboard Discord replies', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    expect(spec).toContain('M15：Dashboard 客服运营闭环');
    expect(spec).toContain('独立退款');
    expect(spec).toContain('订单频道 transcript 只读');
    expect(spec).toContain('Bot 配置');
    expect(spec).toContain('钱包 Adjustment');
    expect(spec).toContain('员工控制的陪玩接单资格');
    expect(spec).toContain('客户展示名');
    expect(spec).toContain('员工账户管理');
    expect(spec).toContain('Dashboard 不发送 Discord 消息');
  });

  test('keeps candidate-pool eligibility under staff approval rather than player self availability', () => {
    const interaction = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    const copy = read('outputs/P0开发交付包/01-UIUX/界面文案清单.csv');
    const prototype = read('outputs/P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html');
    const apiGuide = read('outputs/P0开发交付包/02-API/API使用说明.md');
    const dashboardLabels = read('apps/dashboard/src/table-labels.ts');
    const botCenter = read('apps/bot/src/service-center.ts');
    expect(interaction).toContain('Dashboard","陪玩详情/员工控制接单资格');
    expect(interaction).toContain('陪玩端仍不提供在线或接单开关');
    expect(interaction).toContain('setPlayerOperationalStatus');
    for (const artifact of [copy, prototype, apiGuide]) {
      expect(artifact).not.toContain('setMyPlayerAvailability');
      expect(artifact).not.toContain('setPlayerAvailability');
      expect(artifact).not.toContain('保存可接单状态');
      expect(artifact).not.toContain('接受新匹配');
    }
    expect(dashboardLabels).toContain("历史接单状态（参考）");
    expect(botCenter).not.toContain('接单开关尚未开启');
  });

  test('adds traceable stories and acceptance cases for every requested operation group', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    for (const id of ['EP-M15', 'M15-US-01', 'M15-US-02', 'M15-US-03', 'M15-US-04', 'M15-US-05', 'M15-US-06', 'M15-US-07', 'M15-US-08', 'M15-US-09']) {
      expect(backlog).toContain(`"${id}"`);
    }
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (const id of ['AT-DOP-001', 'AT-DOP-002', 'AT-DOP-003', 'AT-DOP-004', 'AT-DOP-005', 'AT-DOP-006', 'AT-DOP-007', 'AT-DOP-008']) {
      expect(acceptance).toContain(`"${id}"`);
    }
  });

  test('freezes new API contracts only where no unified API operation exists yet', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    expect(openapi).toContain('operationId: listAdminOrderTranscript');
    expect(openapi).toContain('operationId: updateAdminCustomerProfile');
    expect(openapi).toContain('operationId: listAdminStaffAccounts');
    expect(openapi).not.toContain('operationId: sendAdminDiscordReply');
  });
});
