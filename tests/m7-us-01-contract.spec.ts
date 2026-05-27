import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M7-US-01 internal USD funding contracts', () => {
  test('creates optional receipts only after and already bound to a funding fact', () => {
    const api = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const receiptBody = api.slice(api.indexOf('    ReceiptAttachmentBody:'), api.indexOf('    CreateUserRiskEventBody:'));
    const topUpInput = api.slice(api.indexOf('    CreateTopUpInput:'), api.indexOf('    CreateExternalRefundDebitInput:'));
    expect(receiptBody).toContain('required: [evidenceType, evidenceId, file]');
    expect(receiptBody).toContain('enum: [TOP_UP, EXTERNAL_REFUND_DEBIT]');
    expect(topUpInput).not.toContain('attachmentIds:');
  });

  test('locks the public balance shape and new write operations', () => {
    const api = read('outputs/P0开发交付包/02-API/openapi.yaml');

    expect(api).toContain('operationId: createAdminTopUp');
    expect(api).toContain('operationId: createAdminExternalRefundDebit');
    expect(api).toContain('ledgerBalanceMinor:');
    expect(api).not.toContain('providerBalanceMinor:');
    expect(api).not.toContain('operationId: createBinding');
  });

  test('defines one USD wallet fact source and universal audit changes', () => {
    const schema = read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');

    expect(schema).toContain('model WalletAccount');
    expect(schema).toContain('model WalletEntry');
    expect(schema).toContain('model AuditLogChange');
    expect(acceptance).toContain('AT-WAL-001');
    expect(acceptance).toContain('AT-WAL-010');
    expect(acceptance).toContain('AT-AUD-005');
    expect(acceptance).toContain('AT-AUD-008');
  });

  test('removes current Provider funding operations and CNY from canonical runtime contracts', () => {
    const api = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const config = read('outputs/P0开发交付包/05-业务配置/business-config.example.yaml');
    const adapter = read('outputs/P0开发交付包/04-支付集成/adapter-contract.yaml');
    const mainSpec = read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    const fixtures = read('outputs/P0开发交付包/07-验收测试/test-fixtures.json');

    expect(api).not.toMatch(/getProviderBalance|createHold|captureHold|releaseHold|createReservationDebit|createRefund/u);
    expect(api).not.toContain('PROVIDER_BALANCE_SNAPSHOT');
    expect(config).not.toMatch(/providerBalanceMinor|LOCAL_RESERVATION|LOCAL_RESERVATION/u);
    expect(`${api}\n${config}\n${adapter}\n${mainSpec}`).not.toMatch(/currency:\s*CNY|default:\s*CNY|人民币/u);
    expect(acceptance).not.toMatch(/PROVIDER_RECOVERY|API_PROVIDER_INTEGRATION|FX-PROVIDER-/u);
    expect(acceptance).toContain('WALLET_RECOVERY');
    expect(fixtures).not.toMatch(/FX-PROVIDER-|FX-BINDING-CODE-|FX-WEBHOOK-(?:CHARGE|REFUND|BAD|EXPIRED)/u);
    expect(fixtures).toContain('FX-WALLET-CAPTURE-RESPONSE-LOST');
  });

  test('keeps outputs and published docs mirrors byte-identical', () => {
    for (const path of [
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'P0开发交付包/07-验收测试/test-fixtures.json',
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'Codex-P0开发TODO.md'
    ]) {
      expect(read(`docs/${path}`)).toBe(read(`outputs/${path}`));
    }
  });

  test('keeps repository guidance and secondary delivery docs on the current internal-wallet boundary', () => {
    const agents = read('AGENTS.md');
    const apiGuide = read('outputs/P0开发交付包/02-API/API使用说明.md');
    const packageIndex = read('outputs/P0开发交付包/index.html');
    const backlogPrototype = read('outputs/P0开发交付包/06-开发计划/Prototype开发Backlog.html');
    const businessConfig = read('outputs/P0开发交付包/05-业务配置/业务配置说明.html');
    const businessConfigExample = read('outputs/P0开发交付包/05-业务配置/business-config.example.yaml');
    const businessConfigSchema = read('outputs/P0开发交付包/05-业务配置/business-config.schema.json');

    expect(agents).toContain('内部 USD 钱包负责客户账户事实、真实余额、充值、消费和退款');
    expect(agents).toContain('ledgerBalanceMinor');
    expect(agents).not.toContain('Provider 负责用户账户事实、真实余额、充值、支付和退款');
    expect(agents).not.toContain('providerBalanceMinor');

    expect(apiGuide).toContain('内部 USD 钱包承担客户账户、真实余额、充值、消费与退款事实');
    expect(packageIndex).toContain('内部 USD 钱包与人工渠道核对');
    expect(backlogPrototype).toContain('M7 当前合同覆盖 M0–M6 的 Provider 资金历史口径');
    expect(businessConfig).toContain('内部 USD 钱包是客户余额、充值、消费与退款的唯一资金事实来源');
    expect(`${businessConfig}\n${businessConfigExample}\n${businessConfigSchema}`)
      .not.toMatch(/account\.bind|webhook\.payment\.receive/u);
    for (const permission of ['wallet.read', 'wallet.top_up', 'wallet.external_refund', 'wallet.adjust']) {
      expect(businessConfigExample).toContain(permission);
      expect(businessConfigSchema).toContain(permission);
    }

    for (const path of [
      'P0开发交付包/02-API/API使用说明.md',
      'P0开发交付包/index.html',
      'P0开发交付包/05-业务配置/业务配置说明.html',
      'P0开发交付包/05-业务配置/business-config.example.yaml',
      'P0开发交付包/05-业务配置/business-config.schema.json',
      'P0开发交付包/06-开发计划/Prototype开发Backlog.html'
    ]) {
      expect(read(`docs/${path}`)).toBe(read(`outputs/${path}`));
    }
  });

  test('resolves every acceptance fixture identifier to concrete fixture data', () => {
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    const fixtureDocument = JSON.parse(
      read('outputs/P0开发交付包/07-验收测试/test-fixtures.json')
    ) as { fixtureIndex: Record<string, string>; [key: string]: unknown };
    const referenced = [...new Set(acceptance.match(/FX-[A-Z0-9-]+/gu) ?? [])].sort();

    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) {
      const pointer = fixtureDocument.fixtureIndex[id];
      expect(pointer, `${id} is missing from fixtureIndex`).toBeTypeOf('string');
      let value: unknown = fixtureDocument;
      for (const segment of pointer!.slice(1).split('/')) {
        const key = segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
        value = (value as Record<string, unknown>)[key];
      }
      expect(value, `${id} points to missing data at ${pointer}`).not.toBeUndefined();
    }
  });
});
