import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M13-US-01 business collection sorting and dual-view contract', () => {
  test('assigns the reusable collection capability to one M13 epic and four ordered stories', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    for (const id of ['EP-M13', 'M13-US-01', 'M13-US-02', 'M13-US-03', 'M13-US-04']) {
      expect(backlog).toContain(`"${id}"`);
    }
    expect(backlog).toContain('业务集合稳定排序与可复用双视图');
    expect(backlog).toContain('订单、用户、陪玩、服务目录、服务套餐、礼物目录与礼物请求');
  });

  test('freezes server-side stable sorting and one shared card/table presentation model', () => {
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    for (const text of [
      'M13：业务集合稳定排序与可复用双视图',
      'sortBy',
      'sortDirection',
      'CARD',
      'TABLE',
      'NULLS LAST',
      '唯一 ID',
      '切换视图不重新请求列表 API',
      '禁止仅重排浏览器当前页'
    ]) expect(spec).toContain(text);
  });

  test('publishes resource-specific sort whitelists on all seven cursor list operations', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    for (const operationId of [
      'listAdminOrders',
      'listAdminUsers',
      'listAdminPlayers',
      'listServiceCatalogVersions',
      'listAdminServicePackages',
      'listAdminGiftCatalogItems',
      'listAdminGiftRequests'
    ]) {
      const start = openapi.indexOf(`operationId: ${operationId}`);
      expect(start).toBeGreaterThan(-1);
      const nextOperation = openapi.indexOf('operationId:', start + 20);
      const block = openapi.slice(start, nextOperation === -1 ? undefined : nextOperation);
      expect(block).toContain('name: sortBy');
      expect(block).toContain("$ref: '#/components/parameters/SortDirection'");
    }
    expect(openapi).toContain('x-cursor-binding: [resource, actorGuildId, actorScope, filters, sortBy, sortDirection, sortValue, id]');
    expect(openapi).toContain('x-sort-tie-breaker: id');
    expect(openapi).toContain('x-sort-null-policy: NULLS_LAST');
  });

  test('adds interaction and acceptance traceability for parity, pagination, URL and access boundaries', () => {
    const interactions = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    expect(interactions).toContain('"INT-A-070"');
    expect(interactions).toContain('"INT-A-071"');
    expect(interactions).toContain('卡片/表格');

    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (let index = 1; index <= 8; index += 1) {
      expect(acceptance).toContain(`"AT-LST-${String(index).padStart(3, '0')}"`);
    }
    expect(acceptance).toContain('排序、筛选、Guild 与 scope');
    expect(acceptance).toContain('两种视图');
  });

  test('records the Story gate without claiming API or Dashboard runtime completion and keeps mirrors exact', () => {
    const todo = read('outputs/Codex-P0开发TODO.md');
    expect(todo).toContain('## M13：业务集合稳定排序与可复用双视图');
    expect(todo).toContain('- [x] `M13-US-01`');
    expect(todo).toContain('- [x] `M13-US-02`');
    expect(todo).toContain('- [ ] `M13-US-03`');
    expect(todo).toContain('- [ ] `M13-US-04`');
    expect(todo).toContain('不表示排序 API 或双视图运行时已实现');

    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'Codex-P0开发TODO.md',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/06-开发计划/M13-业务集合排序与双视图-Story设计提案.md',
      'P0开发交付包/07-验收测试/acceptance-cases.csv'
    ]) expect(read(`docs/${relative}`)).toBe(read(`outputs/${relative}`));
  });
});
