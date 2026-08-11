import { access, readFile, rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { assertIsolatedPostgresTarget, startIsolatedPostgres } from '../support/isolated-postgres';
import {
  createCatalogFixture,
  createFixtureKernel,
  createJobFixture,
  createOrderFixture,
  createPlayerFixture,
  createReferralFixture,
  createSettlementFixture,
  createWalletFixture
} from '../support/non-ui-fixtures/business';
import { createAccountFixture, createActorFixture, createGuildFixture } from '../support/non-ui-fixtures/actors';
import { ControlledFaultBoundary } from '../support/non-ui-fixtures/faults';
import {
  expectAppendOnlyDelta,
  expectAuditAtomicity,
  expectGuildIsolation,
  expectIdempotentReplay,
  expectNoBusinessWrites,
  expectOutboxConvergence,
  expectPrivacyAllowlist,
  expectWalletInvariant,
  snapshotBusinessFacts
} from '../support/non-ui-assertions';
import { buildNonUiAcceptanceReport, validateNonUiAcceptanceReport } from '../support/non-ui-acceptance-report';
import { nonUiAutomationCoverage } from '../support/non-ui-coverage';

describe.sequential('M23-US-01 / NUI-A0 shared non-UI harness', () => {
  test('fails closed for unsafe labels, remote hosts, ordinary database names and non-test environments', () => {
    expect(() =>
      assertIsolatedPostgresTarget({
        database: 'production',
        host: 'db.example.com',
        root: '/tmp/not-owned',
        nodeEnv: 'production'
      })
    ).toThrow();
    expect(() =>
      assertIsolatedPostgresTarget({
        database: 'blackcat_non_ui_safe_123',
        host: '/tmp/foreign',
        root: '/tmp/owned',
        nodeEnv: 'test'
      })
    ).toThrow();
  });

  test('starts from current migrations on a private Unix socket and removes the instance cleanly', async () => {
    const database = await startIsolatedPostgres('a0-migrations');
    const identity = await database.pool.query(`SELECT current_database() database,
      current_setting('listen_addresses') listen_addresses,
      current_setting('unix_socket_directories') socket_path,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') table_count`);
    expect(identity.rows[0]).toMatchObject({ database: database.database, listen_addresses: '' });
    expect(identity.rows[0].socket_path).toContain(database.socketDir);
    expect(identity.rows[0].table_count).toBeGreaterThan(20);
    const root = database.root;
    await database.stop();
    await expect(access(root)).rejects.toThrow();
  }, 40_000);

  test('creates distinct instances and can retain a stopped failure snapshot explicitly', async () => {
    const first = await startIsolatedPostgres('a0-isolation');
    const second = await startIsolatedPostgres('a0-isolation');
    expect(first.database).not.toBe(second.database);
    expect(first.root).not.toBe(second.root);
    await first.stop();
    await second.stop({ failed: true, keepFailed: true });
    await expect(access(second.root)).resolves.toBeUndefined();
    await rm(second.root, { recursive: true, force: true });
  }, 60_000);

  test('builds deterministic fixtures without embedding proof, receipt body or external credentials', () => {
    const first = createFixtureKernel('NUI-A0-HARNESS', 7);
    const replay = createFixtureKernel('NUI-A0-HARNESS', 7);
    expect(first).toEqual(replay);
    expect(JSON.stringify(first)).not.toMatch(/totp|password|receiptBody|accountNumber/iu);
    const builders = [
      createGuildFixture,
      createActorFixture,
      createAccountFixture,
      createWalletFixture,
      createCatalogFixture,
      createPlayerFixture,
      createOrderFixture,
      createReferralFixture,
      createSettlementFixture,
      createJobFixture
    ];
    for (const builder of builders) expect(builder('NUI-A0-HARNESS', 7)).toBeTypeOf('object');
  });

  test('takes stable business snapshots and proves a no-write interval', async () => {
    const database = await startIsolatedPostgres('a0-snapshot');
    const before = await snapshotBusinessFacts(database.pool, [
      'users',
      'wallet_accounts',
      'audit_logs',
      'outbox_events'
    ]);
    const after = await snapshotBusinessFacts(database.pool, [
      'users',
      'wallet_accounts',
      'audit_logs',
      'outbox_events'
    ]);
    expectNoBusinessWrites(before, after);
    await database.stop();
  }, 40_000);

  test('checks CAT wallet arithmetic and rejects inconsistent or non-CAT projections', () => {
    const wallet = createWalletFixture('NUI-A0-HARNESS', 7);
    expectWalletInvariant(wallet);
    expect(() => expectWalletInvariant({ ...wallet, availableMinor: wallet.availableMinor + 1 })).toThrow();
    expect(() => expectWalletInvariant({ ...wallet, currency: 'USD' })).toThrow();
  });

  test('checks audit atomicity and privacy allowlists across nested payloads', () => {
    expectAuditAtomicity({ businessWrites: 1, successAuditWrites: 1, rejectedAuditWrites: 0 });
    expect(() => expectAuditAtomicity({ businessWrites: 1, successAuditWrites: 0, rejectedAuditWrites: 0 })).toThrow();
    expectPrivacyAllowlist({ publicId: 'P-001', status: 'ACTIVE' }, ['publicId', 'status']);
    expect(() => expectPrivacyAllowlist({ publicId: 'P-001', totp: '123456' }, ['publicId'])).toThrow();
  });

  test('checks append-only, idempotency, Guild isolation and Outbox convergence contracts', () => {
    expectAppendOnlyDelta({ events: [{ id: '1' }] }, { events: [{ id: '2' }, { id: '1' }] }, { events: 1 });
    expectIdempotentReplay({
      firstObjectId: 'object-1',
      replayObjectId: 'object-1',
      firstSideEffectCount: 1,
      replaySideEffectCount: 1
    });
    expectGuildIsolation({ listRows: [], detailVisible: false, businessWriteDelta: 0 });
    expectOutboxConvergence({ businessWrites: 1, deliveredEffects: 1, activeOutboxFacts: 1 });
    const faults = new ControlledFaultBoundary();
    faults.failNext('after-commit');
    expect(() => faults.trigger('after-commit')).toThrow('CONTROLLED_FAULT:after-commit');
    expect(() => faults.trigger('after-commit')).not.toThrow();
  });

  test('defines exactly 77 unique business scenarios without treating A0 infrastructure as a business case', () => {
    expect(nonUiAutomationCoverage).toHaveLength(77);
    expect(new Set(nonUiAutomationCoverage.map(({ automationId }) => automationId)).size).toBe(77);
    expect(
      nonUiAutomationCoverage.filter(({ status }) => status === 'AUTOMATED').map(({ automationId }) => automationId)
    ).toEqual([
      'BNUI-ACC-001',
      'BNUI-ACC-002',
      'BNUI-ACC-003',
      'BNUI-WLT-001',
      'BNUI-WLT-002',
      'BNUI-WLT-003',
      'BNUI-WLT-004',
      'BNUI-WLT-005',
      'BNUI-WLT-006',
      'BNUI-CAT-001',
      'BNUI-CAT-002',
      'BNUI-PKG-001',
      'BNUI-PKG-002',
      'BNUI-TAG-001',
      'BNUI-PLY-001',
      'BNUI-PLY-002',
      'BNUI-PLY-003'
    ]);
  });

  test('builds a redacted machine report with explicit acceptance classifications', () => {
    const report = buildNonUiAcceptanceReport({
      story: 'M23-US-03',
      implementationPackage: 'NUI-A2',
      commitSha: 'WORKTREE',
      generatedAt: '2026-08-14T00:00:00.000Z',
      cases: nonUiAutomationCoverage
    });
    expect(() => validateNonUiAcceptanceReport(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toContain('123456');
    expect(report.summary).toMatchObject({ total: 77, automated: 17, planned: 60 });
  });

  test('freezes nine sequential M23 Stories and mirrored implementation contracts', async () => {
    const [backlog, backlogMirror, plan, mirror, todo, todoMirror] = await Promise.all([
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('docs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/P0-其他业务非UI自动化实施计划.md', 'utf8'),
      readFile('docs/P0开发交付包/06-开发计划/P0-其他业务非UI自动化实施计划.md', 'utf8'),
      readFile('outputs/Codex-P0开发TODO.md', 'utf8'),
      readFile('docs/Codex-P0开发TODO.md', 'utf8')
    ]);
    const stories = [...backlog.matchAll(/^"(M23-US-[0-9]{2})","USER_STORY"/gmu)].map((match) => match[1]);
    expect(stories).toEqual(Array.from({ length: 9 }, (_, index) => `M23-US-${String(index + 1).padStart(2, '0')}`));
    expect(backlog).toBe(backlogMirror);
    expect(plan).toBe(mirror);
    expect(plan).toContain('77 个显式 BNUI 场景');
    expect(todo).toBe(todoMirror);
    expect(todo).toContain('## M23：全业务非 UI 自动化');
  });
});
