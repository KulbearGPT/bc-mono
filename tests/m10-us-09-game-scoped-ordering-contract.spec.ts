import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M10-US-09 game-scoped ordering contracts', () => {
  it('traces the game-first ordering flow through specification, backlog, interaction and acceptance contracts', () => {
    expect(read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html')).toContain('按游戏点菜式下单与单游戏套餐');
    expect(read('outputs/P0开发交付包/06-开发计划/backlog.csv')).toContain('"M10-US-09"');
    expect(read('outputs/P0开发交付包/01-UIUX/交互映射.csv')).toContain('"INT-D-065"');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    for (const id of ['AT-MULTI-011', 'AT-MULTI-012', 'AT-MULTI-013']) expect(acceptance).toContain(`"${id}"`);
  });

  it('freezes single-game package and same-game customization rules in API and data contracts', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    expect(openapi).toMatch(/\/api\/v1\/service-packages:[\s\S]*?name: game/);
    expect(openapi).toContain('single-game-package');
    expect(openapi).toContain('same-game-project-replacement');
    expect(openapi).toMatch(/ServicePackageVersion:[\s\S]*?gameDisplayName/);

    const prisma = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    expect(prisma).toMatch(/model ServicePackage \{[\s\S]*?gameCode/);
    expect(prisma).toMatch(/model ServicePackage \{[\s\S]*?gameName/);
  });

  it('keeps delivery mirrors byte-identical', () => {
    const pairs = [
      ['outputs/P0开发交付包/01-UIUX/交互映射.csv', 'docs/P0开发交付包/01-UIUX/交互映射.csv'],
      ['outputs/P0开发交付包/02-API/openapi.yaml', 'docs/P0开发交付包/02-API/openapi.yaml'],
      ['outputs/P0开发交付包/03-数据模型/schema.prisma', 'docs/P0开发交付包/03-数据模型/schema.prisma'],
      ['outputs/P0开发交付包/06-开发计划/backlog.csv', 'docs/P0开发交付包/06-开发计划/backlog.csv'],
      ['outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'docs/P0开发交付包/07-验收测试/acceptance-cases.csv'],
    ];
    for (const [output, doc] of pairs) expect(read(output)).toBe(read(doc));
  });
});
