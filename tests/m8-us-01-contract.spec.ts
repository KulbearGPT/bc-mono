import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M8-US-01 configurable customer token contracts', () => {
  test('defines the fixed customer display unit without changing canonical USD', () => {
    const api = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    const prototype = read('outputs/P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html');
    const config = read('outputs/P0开发交付包/05-业务配置/业务配置说明.html');

    expect(api).toContain('x-customer-display-unit:');
    expect(api).toContain('unitsPerUsd: 10');
    expect(api).toContain('currency: {type: string, const: USD}');
    for (const id of [
      'AT-TKN-001',
      'AT-TKN-002',
      'AT-TKN-003',
      'AT-TKN-004',
      'AT-TKN-005',
      'AT-TKN-006',
      'AT-TKN-007'
    ]) {
      expect(acceptance).toContain(id);
    }
    expect(prototype).toContain('3,680.00 MB');
    expect(prototype).toContain('到账后按 1 USD = 10 MB 发放');
    expect(config).toContain('WALLET_DISPLAY_NAME');
    expect(config).toContain('比例不可配置');
    expect(config).toContain('陪玩收益、返佣、周报、结算和转账清单只显示 USD');
  });

  test('adds sequential M8 delivery stories to the canonical backlog', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');

    for (const id of ['EP-M8', 'M8-US-01', 'M8-US-02', 'M8-US-03']) {
      expect(backlog).toContain(`"${id}"`);
    }
  });

  test('keeps every changed delivery artifact byte-identical to its published mirror', () => {
    for (const path of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/01-UIUX/界面文案清单.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/05-业务配置/业务配置说明.html',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'Codex-P0开发TODO.md'
    ]) {
      expect(read(`docs/${path}`)).toBe(read(`outputs/${path}`));
    }
  });
});
