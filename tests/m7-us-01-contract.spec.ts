import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('M7-US-01 internal USD funding contracts', () => {
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

    expect(api).not.toMatch(/getProviderBalance|createHold|captureHold|releaseHold|createReservationDebit|createRefund/u);
    expect(config).not.toMatch(/providerBalanceMinor|PROVIDER_NATIVE_HOLD|LOCAL_RESERVATION_FALLBACK/u);
    expect(`${api}\n${config}\n${adapter}`).not.toMatch(/currency:\s*CNY|default:\s*CNY/u);
  });

  test('keeps outputs and published docs mirrors byte-identical', () => {
    for (const path of [
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'Codex-P0开发TODO.md'
    ]) {
      expect(read(`docs/${path}`)).toBe(read(`outputs/${path}`));
    }
  });
});
