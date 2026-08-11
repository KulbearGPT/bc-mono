import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const contractPairs = [
  'P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html',
  'P0开发交付包/01-UIUX/交互映射.csv',
  'P0开发交付包/01-UIUX/界面文案清单.csv',
  'P0开发交付包/02-API/API使用说明.md',
  'P0开发交付包/03-数据模型/状态枚举与约束.md',
  'P0开发交付包/04-支付集成/供应商接入核对清单.csv',
  'P0开发交付包/05-业务配置/seed-data.csv',
  'P0开发交付包/05-业务配置/业务配置说明.html',
  'P0开发交付包/06-开发计划/backlog.csv',
  'P0开发交付包/07-验收测试/acceptance-cases.csv',
  'P0开发交付包/07-验收测试/test-fixtures.json',
  'P0开发交付包/index.html'
];

describe('M23-US-02 current CAT account and wallet contract', () => {
  test('keeps every corrected contract byte-identical to its published mirror', async () => {
    for (const path of contractPairs) {
      const [outputs, docs] = await Promise.all([
        readFile(`outputs/${path}`, 'utf8'),
        readFile(`docs/${path}`, 'utf8')
      ]);
      expect(outputs, path).toBe(docs);
    }
  });

  test('removes superseded internal USD and configurable MB wallet language from current delivery contracts', async () => {
    for (const path of contractPairs.filter((path) => !path.endsWith('test-fixtures.json'))) {
      const content = await readFile(`outputs/${path}`, 'utf8');
      expect(content, path).not.toMatch(
        /内部(?:只追加式? )?USD|currency=USD|客户 USD 钱包|三项 USD 余额|仅显示 USD|保持 USD|USD-only|WalletAccount[^\n]*币种固定 USD|全部为 USD|可全局替换|canonical USD|\bMB\b|WALLET_DISPLAY_(?:NAME|SYMBOL)|l1_top_up_limit|l1_limit_minor/u
      );
    }
  });

  test('keeps seed permissions and the Dashboard E2E contract on CAT and L2 plus step-up', async () => {
    const [publishedSeed, runtimeSeed, dashboardPlan] = await Promise.all([
      readFile('outputs/P0开发交付包/05-业务配置/seed-data.csv', 'utf8'),
      readFile('database/seed/seed-data.csv', 'utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/Dashboard-E2E自动化测试开发计划.md', 'utf8')
    ]);
    for (const seed of [publishedSeed, runtimeSeed]) {
      expect(seed).toContain('"business_setting","currency"');
      expect(seed).toContain('"CAT","CAT"');
      expect(seed).toContain('"permission_code","wallet.top_up","L2_SUPERVISOR"');
      expect(seed).toContain('""assigned_roles"":[""L2_SUPERVISOR"",""L3_OPERATIONS"",""L4_ADMIN_OWNER""]');
      expect(seed).toContain('"recent_step_up_required"":true');
      expect(seed).not.toMatch(/l1_top_up_limit|l1_limit_minor|"currency"":""USD""/u);
    }
    expect(dashboardPlan).toContain('DE2E-WLT-008');
    expect(dashboardPlan).toContain('内部金额只显示 CAT');
    expect(dashboardPlan).not.toContain('只显示 USD，不使用客户代币格式化');
  });

  test('aligns wallet acceptance with fixed CAT subunits, USD receipt evidence and L2 authorization', async () => {
    const acceptance = await readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8');
    for (const id of [
      'AT-WAL-001',
      'AT-WAL-003',
      'AT-WAL-004',
      'AT-WAL-010',
      'AT-TKN-001',
      'AT-TKN-007',
      'AT-WLT-011'
    ]) {
      const row = acceptance.split('\n').find((line) => line.startsWith(`"${id}"`));
      expect(row, id).toContain('CAT');
      expect(row, id).not.toMatch(/内部 USD|currency 固定 USD|所有金额字段固定为 USD|5000 美元|可全局替换|\bMB\b/u);
    }
    expect(acceptance.split('\n').find((line) => line.startsWith('"AT-WAL-004"'))).toContain('L1');
    expect(acceptance.split('\n').find((line) => line.startsWith('"AT-WAL-004"'))).toContain('L2');
  });

  test('uses CAT wallet fixtures while retaining USD only as top-up payment evidence', async () => {
    const fixtures = JSON.parse(await readFile('outputs/P0开发交付包/07-验收测试/test-fixtures.json', 'utf8'));
    const supplemental = fixtures.supplementalAcceptanceFixtures;
    expect(supplemental.environment.currency).toBe('CAT');
    expect(supplemental.walletEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'CAT', entryType: 'TOP_UP_CREDIT' }),
        expect.objectContaining({ currency: 'CAT', entryType: 'ORDER_CAPTURE_DEBIT' })
      ])
    );
    expect(supplemental.walletDisplayConfig).toEqual({
      displayName: '猫条',
      symbol: 'CAT',
      subunitsPerCat: 10,
      locked: true
    });
    expect(supplemental.topUpPaymentEvidence).toMatchObject({ paidCurrency: 'USD', rateCatPerUsd: 10 });
  });
});
