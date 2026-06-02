import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M9-US-01 onboarding and CAT contract', () => {
  test('keeps authoritative contract mirrors identical', async () => {
    for (const relative of [
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'P0开发交付包/07-验收测试/test-fixtures.json'
    ]) {
      const [docs, outputs] = await Promise.all([
        readFile(resolve(root, 'docs', relative), 'utf8'),
        readFile(resolve(root, 'outputs', relative), 'utf8')
      ]);
      expect(docs).toBe(outputs);
    }
  });

  test('defines the fixed USD receipt to CAT ledger boundary', async () => {
    const spec = await readFile(resolve(root, 'outputs/Discord陪玩业务Bot最小原型设计开发文档.html'), 'utf8');
    expect(spec).toContain('1 USD = 10 猫条');
    expect(spec).toContain('1 USD cent = 1 CAT subunit');
    expect(spec).toContain('不绑定任何外部资金账户');
  });
});
