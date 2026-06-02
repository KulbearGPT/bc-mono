import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M8-US-01 superseded customer token contracts', () => {
  test('records M9 as the fixed CAT ledger authority', () => {
    const api = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    const spec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');

    expect(api).toContain('x-customer-display-unit:');
    expect(api).toContain('canonicalCurrency: CAT');
    expect(api).toContain('paidCurrency: {type: string, const: USD');
    for (const id of ['AT-WLT-011','AT-CAT-005','AT-ONB-001','AT-ONB-006']) expect(acceptance).toContain(id);
    expect(spec).toContain('M9 现行补充：Discord 自助入驻与 CAT 内部账本');
    expect(spec).toContain('1 USD cent = 1 CAT subunit');
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
