import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M14-US-01 support-first workbench UX contract', () => {
  test('splits the dashboard remediation into one epic and five ordered stories', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    for (const id of ['EP-M14', 'M14-US-01', 'M14-US-02', 'M14-US-03', 'M14-US-04', 'M14-US-05']) {
      expect(backlog).toContain(`"${id}"`);
    }
    expect(backlog).toContain('客服任务优先工作台与可行动订单上下文');
  });

  test('freezes queue-first hierarchy, safe pre-claim context and humanized operations language', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    for (const text of [
      'M14：客服任务优先工作台与可行动订单上下文',
      '任务队列位于首屏操作区',
      '服务端生成任务优先级',
      '认领前只读预览',
      '不得生成 <code>/channels//</code>',
      '相对时间',
      '技术详情默认折叠',
      '不新增 CRM'
    ]) expect(spec).toContain(text);
  });

  test('publishes task-scoped triage summaries, safe links and deterministic server ordering', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const start = openapi.indexOf('operationId: listStaffTasks');
    const end = openapi.indexOf('operationId:', start + 20);
    const operation = openapi.slice(start, end);
    expect(operation).toContain('x-triage-order:');
    expect(operation).toContain('OVERDUE_FIRST');
    expect(openapi).toContain('StaffTaskTriageSummary:');
    expect(openapi).toContain('StaffTaskLinks:');
    expect(openapi).toContain("triage: {$ref: '#/components/schemas/StaffTaskTriageSummary'}");
    expect(openapi).toContain("links: {$ref: '#/components/schemas/StaffTaskLinks'}");
    expect(openapi).toContain('never contains a malformed /channels// URL');
  });

  test('adds interaction and acceptance traceability for the observed support workflows', () => {
    const interactions = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    for (const id of ['INT-A-072', 'INT-A-073', 'INT-A-074']) expect(interactions).toContain(`"${id}"`);

    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (let index = 1; index <= 7; index += 1) {
      expect(acceptance).toContain(`"AT-SUX-${String(index).padStart(3, '0')}"`);
    }
  });

  test('records only the contract story complete and keeps release mirrors exact', () => {
    const todo = read('outputs/Codex-P0开发TODO.md');
    expect(todo).toContain('## M14：客服任务优先工作台与可行动订单上下文');
    expect(todo).toContain('- [x] `M14-US-01`');
    for (const id of ['M14-US-02', 'M14-US-03', 'M14-US-04', 'M14-US-05']) {
      expect(todo).toContain(`- [ ] \`${id}\``);
    }
    expect(todo).toContain('不表示客服工作台运行时已实现');

    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'Codex-P0开发TODO.md',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/06-开发计划/M14-客服任务优先工作台与可行动上下文-Story设计提案.md',
      'P0开发交付包/07-验收测试/acceptance-cases.csv'
    ]) expect(read(`docs/${relative}`)).toBe(read(`outputs/${relative}`));
  });
});
