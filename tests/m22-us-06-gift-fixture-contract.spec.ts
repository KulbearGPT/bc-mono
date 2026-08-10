import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, test } from 'vitest';
import {
  assertGiftTestDatabase,
  snapshotGiftFacts,
  startIsolatedGiftDatabase,
  type IsolatedGiftDatabase
} from './support/gift-automation-fixture';

let database: IsolatedGiftDatabase | undefined;

describe('M22-US-06 isolated gift automation fixture contract', () => {
  afterAll(async () => database?.stop());

  test('starts from current migrations without accepting an ambient DATABASE_URL', async () => {
    database = await startIsolatedGiftDatabase('fixture-contract');
    expect(database.database).toMatch(/^blackcat_m22_gift_fixture_contract_[0-9]+$/u);
    await expect(database.pool.query("SELECT to_regclass('public.gift_requests') AS gift_requests"))
      .resolves.toMatchObject({ rows: [{ gift_requests: 'gift_requests' }] });
    await expect(snapshotGiftFacts(database.pool)).resolves.toMatchObject({
      giftRequests: 0,
      reservations: 0,
      reservationEvents: 0,
      staffTasks: 0,
      consumptions: 0,
      announcementJobs: 0,
      audits: 0
    });
  }, 30_000);

  test('fails closed for a non-isolated database identity', async () => {
    await expect(assertGiftTestDatabase({
      query: async () => ({ rows: [{ database_name: 'blackcat_production', socket_path: '/var/run/postgresql' }] })
    })).rejects.toThrow('UNSAFE_GIFT_TEST_DATABASE');
  });

  test('keeps the dedicated command and manual Discord boundary in the committed plan', async () => {
    const [packageJson, plan] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/M22-US-06-礼物非UI自动化实施计划.md', 'utf8')
    ]);
    expect(JSON.parse(packageJson).scripts['test:gift:non-ui']).toBeTypeOf('string');
    expect(plan).toContain('自动点击真实 Discord 客户端');
    expect(plan).toContain('真实 Discord Desktop/Mobile');
  });
});
