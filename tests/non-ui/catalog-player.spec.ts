import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import {
  PostgresServiceCatalogStore,
  prepareCreateServiceCatalogVersion,
  prepareUpdateServiceCatalogVersion
} from '@blackcat/api/catalog';
import { PostgresBusinessTagStore } from '@blackcat/api/business-tags';
import { PostgresOrderParticipantStore } from '@blackcat/api/order-participants';
import {
  PostgresPlayerCompensationStore,
  upsertPlayerCompensationRule,
  upsertPlayerCompensationRules
} from '@blackcat/api/player-compensation';
import { PostgresPlayerStore } from '@blackcat/api/players';
import { PostgresServicePackageStore } from '@blackcat/api/service-packages';
import {
  InMemoryAuditSink,
  PostgresAuditSink,
  PostgresIdempotencyStore,
  type AuditRecord,
  type StaffAccount
} from '@blackcat/api/security';
import { expectNoBusinessWrites, snapshotBusinessFacts } from '../support/non-ui-assertions';
import { startIsolatedPostgres, type IsolatedPostgres } from '../support/isolated-postgres';
import { stableSnowflake, stableUuid } from '../support/non-ui-fixtures/actors';

const now = new Date('2026-08-14T15:00:00.000Z');
const env = {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost',
  BOT_SERVICE_TOKEN: 'valid-bot-token',
  PAGINATION_CURSOR_SIGNING_SECRET: 'nui-a2-catalog-player-signing-secret'
};
let database: IsolatedPostgres;
let pool: Pool;

interface Scenario {
  id: string;
  guildId: string;
  staffUserId: string;
  staffId: string;
  customerId: string;
  playerUserId: string;
  playerId: string;
}

describe('NUI-A2 catalog, packages, tags and player eligibility automation', () => {
  beforeAll(async () => {
    database = await startIsolatedPostgres('a2_catalog_player');
    pool = database.pool;
  }, 40_000);

  afterAll(async () => database.stop());

  test('BNUI-CAT-001 creates, supersedes and archives immutable CAT service versions without rewriting an order snapshot', async () => {
    const scenario = await seedScenario('BNUI-CAT-001', 1);
    const store = new PostgresServiceCatalogStore({ pool });
    const first = await prepareCreateServiceCatalogVersion({
      store,
      actor: catalogActor(scenario),
      input: catalogInput('DELTA', 'TECH', 100, 60, true),
      now
    });
    await commitCatalog(store, scenario, first, 'catalog-v1');
    await seedHistoricalRequirement(scenario, first.data.id, 100);

    const second = await prepareCreateServiceCatalogVersion({
      store,
      actor: catalogActor(scenario),
      input: catalogInput('DELTA', 'TECH', 150, 90, true),
      now: new Date(now.getTime() + 1_000)
    });
    await commitCatalog(store, scenario, second, 'catalog-v2');
    const archived = await prepareUpdateServiceCatalogVersion({
      store,
      actor: catalogActor(scenario),
      serviceCatalogId: second.data.id,
      input: { expectedVersion: 2, action: 'ARCHIVE', reasonCode: 'NO_LONGER_SOLD' },
      now: new Date(now.getTime() + 2_000)
    });
    await commitCatalog(store, scenario, archived, 'catalog-archive');

    const facts = await pool.query(
      `SELECT version.version,version.status::text,version.customer_unit_price_minor::int customer_price,
       version.player_unit_payout_minor::int player_price,offering.archived_at IS NOT NULL archived
       FROM service_catalog_versions version JOIN service_offerings offering ON offering.id=version.service_offering_id
       WHERE offering.code='DELTA|TECH|' ORDER BY version.version`
    );
    expect(facts.rows).toEqual([
      { version: 1, status: 'RETIRED', customer_price: 100, player_price: 60, archived: true },
      { version: 2, status: 'RETIRED', customer_price: 150, player_price: 90, archived: true }
    ]);
    const snapshot = await pool.query(
      `SELECT customer_unit_price_minor_snapshot::int price,game_code_snapshot game,service_code_snapshot service
       FROM order_requirements WHERE order_id=$1`,
      [stableUuid(`${scenario.id}:historical-order`)]
    );
    expect(snapshot.rows[0]).toEqual({ price: 100, game: 'DELTA', service: 'TECH' });
    expect((await store.getById(first.data.id))?.customerUnitPriceMinor).toBe(100);
  });

  test('BNUI-CAT-002 rejects missing prices, invalid units and wrong tag types with zero catalog, audit or outbox writes', async () => {
    const scenario = await seedScenario('BNUI-CAT-002', 2);
    const store = new PostgresServiceCatalogStore({ pool });
    const tags = new PostgresBusinessTagStore(pool);
    const tag = await tags.stageCreate({
      type: 'SERVICE',
      code: 'ONLY_SERVICE',
      displayName: '仅服务标签',
      actorStaffId: scenario.staffId,
      now
    });
    await tag.commit(audit(scenario, 'CREATE_BUSINESS_TAG', tag.data.id, 'cat2-tag'), new InMemoryAuditSink());
    const tables = ['audit_logs', 'outbox_events', 'service_catalog_versions', 'service_offerings'];
    const before = await snapshotBusinessFacts(pool, tables);
    await expect(
      prepareCreateServiceCatalogVersion({
        store,
        actor: catalogActor(scenario),
        input: { ...catalogInput('DELTA', 'BROKEN', 100, 60, true), playerUnitPayout: null },
        now
      })
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    await expect(
      prepareCreateServiceCatalogVersion({
        store,
        actor: catalogActor(scenario),
        input: { ...catalogInput('DELTA', 'BROKEN', 100, 60, true), billingUnitMinutes: 0 },
        now
      })
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    await expect(tags.resolveEnabled([tag.data.id], ['GAME'])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, tables));
  });

  test('BNUI-PKG-001 publishes ordered same-game slots with a server-derived total and one immutable active version per code', async () => {
    const scenario = await seedScenario('BNUI-PKG-001', 3);
    const [technical, social] = await seedDirectCatalogs(scenario, ['DELTA', 'DELTA']);
    const store = new PostgresServicePackageStore(pool);
    const first = await store.createAdmin({
      actorStaffId: scenario.staffId,
      payload: packagePayload('DELTA_ESCORT', true, [
        { serviceCatalogVersionId: technical, unitCount: 2, customerNoteTemplate: '技术位' },
        { serviceCatalogVersionId: social, unitCount: 1, customerNoteTemplate: '聊天位' }
      ]),
      now
    });
    await first.commit(audit(scenario, 'CREATE_ADMIN_SERVICE_PACKAGE_VERSION', first.data.id, 'pkg1-v1'));
    expect(first.data).toMatchObject({ version: 1, status: 'ACTIVE', defaultCustomerPriceMinor: 300 });
    expect(first.data.slots.map((slot) => slot.position)).toEqual([1, 2]);

    const second = await store.createAdmin({
      actorStaffId: scenario.staffId,
      payload: packagePayload('DELTA_ESCORT', true, [
        { serviceCatalogVersionId: social, unitCount: 1, customerNoteTemplate: '新版聊天位' },
        { serviceCatalogVersionId: technical, unitCount: 1, customerNoteTemplate: '新版技术位' }
      ]),
      now: new Date(now.getTime() + 1_000)
    });
    await second.commit(audit(scenario, 'CREATE_ADMIN_SERVICE_PACKAGE_VERSION', second.data.id, 'pkg1-v2'));
    const versions = await pool.query(
      `SELECT version.version,version.status::text,version.default_customer_price_minor::int total,
       array_agg(slot.position ORDER BY slot.position) positions
       FROM service_package_versions version JOIN service_packages package ON package.id=version.service_package_id
       JOIN service_package_slots slot ON slot.service_package_version_id=version.id
       WHERE package.code='DELTA_ESCORT' GROUP BY version.id ORDER BY version.version`
    );
    expect(versions.rows).toEqual([
      { version: 1, status: 'RETIRED', total: 300, positions: [1, 2] },
      { version: 2, status: 'ACTIVE', total: 200, positions: [1, 2] }
    ]);
  });

  test('BNUI-PKG-002 rejects mixed-game slots and lets only one concurrent activation of the same draft succeed', async () => {
    const scenario = await seedScenario('BNUI-PKG-002', 4);
    const [delta, valorant] = await seedDirectCatalogs(scenario, ['DELTA', 'VALORANT']);
    const store = new PostgresServicePackageStore(pool);
    const before = await snapshotBusinessFacts(pool, [
      'audit_logs',
      'service_package_slots',
      'service_package_versions',
      'service_packages'
    ]);
    await expect(
      store.createAdmin({
        actorStaffId: scenario.staffId,
        payload: packagePayload('MIXED_GAMES', false, [
          { serviceCatalogVersionId: delta, unitCount: 1, customerNoteTemplate: null },
          { serviceCatalogVersionId: valorant, unitCount: 1, customerNoteTemplate: null }
        ]),
        now
      })
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_ERROR' });
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, Object.keys(before)));

    const draft = await store.createAdmin({
      actorStaffId: scenario.staffId,
      payload: packagePayload('DELTA_RACE', false, [
        { serviceCatalogVersionId: delta, unitCount: 1, customerNoteTemplate: null }
      ]),
      now
    });
    await draft.commit(audit(scenario, 'CREATE_ADMIN_SERVICE_PACKAGE_VERSION', draft.data.id, 'pkg2-draft'));
    const publish = async (key: string) => {
      const staged = await store.updateAdmin({
        actorStaffId: scenario.staffId,
        servicePackageVersionId: draft.data.id,
        payload: { expectedStatus: 'DRAFT', action: 'ACTIVATE', reasonCode: 'PUBLISH_PACKAGE' },
        now: new Date(now.getTime() + 1_000)
      });
      await staged.commit(audit(scenario, 'UPDATE_ADMIN_SERVICE_PACKAGE_VERSION_STATUS', draft.data.id, key));
      return staged.data;
    };
    const results = await Promise.allSettled([publish('pkg2-race-a'), publish('pkg2-race-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = await pool.query(
      `SELECT count(*)::int count FROM service_package_versions version JOIN service_packages package
       ON package.id=version.service_package_id WHERE package.code='DELTA_RACE' AND version.status='ACTIVE'`
    );
    expect(active.rows[0].count).toBe(1);
  });

  test('BNUI-TAG-001 keeps tag codes and historical references stable while disabling only future selection', async () => {
    const scenario = await seedScenario('BNUI-TAG-001', 5);
    const store = new PostgresBusinessTagStore(pool);
    const created = await store.stageCreate({
      type: 'GAME',
      code: 'DELTA',
      displayName: '三角洲行动',
      actorStaffId: scenario.staffId,
      now
    });
    await created.commit(
      audit(scenario, 'CREATE_BUSINESS_TAG', created.data.id, 'tag1-create'),
      new InMemoryAuditSink()
    );
    const [catalog] = await seedDirectCatalogs(scenario, ['DELTA']);
    await pool.query(
      `INSERT INTO service_version_skill_requirements(service_catalog_version_id,skill_tag_id)
       VALUES($1,$2)`,
      [catalog, created.data.id]
    );
    const disabled = await store.stageUpdate({
      tagId: created.data.id,
      expectedVersion: 1,
      displayName: '三角洲',
      enabled: false,
      actorStaffId: scenario.staffId,
      now: new Date(now.getTime() + 1_000)
    });
    await disabled.commit(
      audit(scenario, 'UPDATE_BUSINESS_TAG', created.data.id, 'tag1-disable'),
      new InMemoryAuditSink()
    );
    expect(disabled.data).toMatchObject({ code: 'DELTA', displayName: '三角洲', enabled: false, version: 2 });
    await expect(store.resolveEnabled([created.data.id], ['GAME'])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      store.stageUpdate({
        tagId: created.data.id,
        expectedVersion: 1,
        displayName: '陈旧修改',
        enabled: true,
        actorStaffId: scenario.staffId,
        now
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const history = await pool.query(
      `SELECT tag.code,requirement.service_catalog_version_id::text catalog_id
       FROM service_version_skill_requirements requirement JOIN skill_tags tag ON tag.id=requirement.skill_tag_id
       WHERE requirement.skill_tag_id=$1`,
      [created.data.id]
    );
    expect(history.rows[0]).toEqual({ code: 'DELTA', catalog_id: catalog });
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile('apps/api/src/business-tags.ts', 'utf8')
    );
    expect(source).not.toContain("method:'DELETE',url:'/api/v1/admin/business-tags");
  });

  test('BNUI-PLY-001 approves and rejects companion applications atomically with version, tags, role tasks and audit', async () => {
    const scenario = await seedScenario('BNUI-PLY-001', 6);
    const approved = await seedPlayer(scenario, 'approve', 'PENDING_REVIEW');
    const rejected = await seedPlayer(scenario, 'reject', 'PENDING_REVIEW');
    const rollback = await seedPlayer(scenario, 'rollback', 'PENDING_REVIEW');
    const tagIds = await seedPlayerTags(scenario);
    const server = playerServer(scenario);

    const approvedResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/players/${approved.playerId}/approve`,
      headers: dashboardHeaders('nui:a2:player:approve'),
      payload: {
        expectedVersion: 1,
        gameTagIds: [tagIds.game],
        serviceTagIds: [tagIds.service],
        languageTagIds: [tagIds.language],
        reasonCode: 'APPROVED'
      }
    });
    expect(approvedResponse.statusCode, approvedResponse.body).toBe(200);
    const rejectedResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/players/${rejected.playerId}/reject`,
      headers: dashboardHeaders('nui:a2:player:reject'),
      payload: { expectedVersion: 1, reasonCode: 'SKILL_MISMATCH', note: '技能范围不匹配' }
    });
    expect(rejectedResponse.statusCode, rejectedResponse.body).toBe(200);
    const facts = await pool.query(
      `SELECT profile.id,profile.review_status::text,users.status::text user_status,
       (SELECT count(*)::int FROM companion_review_events event WHERE event.player_profile_id=profile.id) review_events,
       (SELECT count(*)::int FROM discord_product_role_tasks task WHERE task.user_id=profile.user_id) role_tasks,
       (SELECT count(*)::int FROM player_skills skill WHERE skill.player_profile_id=profile.id) skills
       FROM player_profiles profile JOIN users ON users.id=profile.user_id WHERE profile.id=ANY($1::uuid[]) ORDER BY profile.id`,
      [[approved.playerId, rejected.playerId]]
    );
    expect(facts.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: approved.playerId,
          review_status: 'ACTIVE',
          user_status: 'ACTIVE',
          review_events: 1,
          role_tasks: 2,
          skills: 3
        }),
        expect.objectContaining({
          id: rejected.playerId,
          review_status: 'REJECTED',
          user_status: 'ACTIVE',
          review_events: 1,
          role_tasks: 1,
          skills: 0
        })
      ])
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::int count FROM audit_logs WHERE action IN ('APPROVE_PLAYER','REJECT_PLAYER') AND outcome='SUCCEEDED'`
        )
      ).rows[0].count
    ).toBe(2);

    await pool.query(
      `CREATE FUNCTION reject_a2_player_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END $$`
    );
    await pool.query(
      `CREATE TRIGGER reject_a2_player_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_a2_player_audit()`
    );
    const rollbackResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/players/${rollback.playerId}/approve`,
      headers: dashboardHeaders('nui:a2:player:audit-failure'),
      payload: {
        expectedVersion: 1,
        gameTagIds: [tagIds.game],
        serviceTagIds: [tagIds.service],
        languageTagIds: [tagIds.language],
        reasonCode: 'APPROVED'
      }
    });
    await pool.query(`DROP TRIGGER reject_a2_player_audit ON audit_logs`);
    await pool.query(`DROP FUNCTION reject_a2_player_audit()`);
    expect(rollbackResponse.statusCode, rollbackResponse.body).toBe(500);
    expect(await new PostgresPlayerStore({ pool }).findById(rollback.playerId)).toMatchObject({
      reviewStatus: 'PENDING_REVIEW',
      version: 1
    });
    await server.close();
  });

  test('BNUI-PLY-002 excludes a paused player from new candidates, restores them, and leaves an existing order fact unchanged', async () => {
    const scenario = await seedScenario('BNUI-PLY-002', 7);
    const player = await seedPlayer(scenario, 'active', 'ACTIVE');
    const [catalog] = await seedDirectCatalogs(scenario, ['DELTA']);
    const orderId = await seedDraftOrder(scenario, 'candidate-order');
    const historicalOrderId = await seedDraftOrder(scenario, 'historical-order');
    await pool.query(`UPDATE orders SET status='IN_SERVICE' WHERE id=$1`, [historicalOrderId]);
    await pool.query(
      `INSERT INTO order_participants(id,order_id,player_id,service_catalog_version_id,status,row_version,
       player_display_name_snapshot,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,
       billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,compensation_type_snapshot,
       compensation_value_snapshot,compensation_source,expected_earning_minor,created_at,updated_at)
       VALUES($2,$1,$3,$4,'ACTIVE',1,'既有陪玩','DELTA','三角洲','TECH','技术陪玩',60,1,100,100,'PERCENT_BPS',6000,'CATALOG_DEFAULT',60,$5,$5)`,
      [historicalOrderId, stableUuid(`${scenario.id}:historical-participant`), scenario.playerUserId, catalog, now]
    );
    const participants = new PostgresOrderParticipantStore(pool);
    const scope = {
      orderId,
      actorStaffId: scenario.staffId,
      actorLevel: 'L3_OPERATIONS' as const,
      guildId: scenario.guildId,
      cursor: null,
      limit: 20,
      query: null
    };
    expect((await participants.listCandidates(scope)).items.map((item) => item.playerId)).toContain(
      scenario.playerUserId
    );
    const server = playerServer(scenario);
    const paused = await server.inject({
      method: 'PUT',
      url: `/api/v1/admin/players/${player.playerId}/operational-status`,
      headers: dashboardHeaders('nui:a2:player:pause'),
      payload: { expectedVersion: 1, reviewStatus: 'PAUSED', reasonCode: 'PLAYER_NO_SHOW', note: '爽约暂停' }
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect((await participants.listCandidates(scope)).items.map((item) => item.playerId)).not.toContain(
      scenario.playerUserId
    );
    const resumed = await server.inject({
      method: 'PUT',
      url: `/api/v1/admin/players/${player.playerId}/operational-status`,
      headers: dashboardHeaders('nui:a2:player:resume'),
      payload: { expectedVersion: 2, reviewStatus: 'ACTIVE', reasonCode: 'RISK_CLEARED', note: '复核通过' }
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await participants.listCandidates(scope)).items.map((item) => item.playerId)).toContain(
      scenario.playerUserId
    );
    const historical = await pool.query(
      `SELECT participant.status::text,orders.status::text order_status,participant.expected_earning_minor::int earning
       FROM order_participants participant JOIN orders ON orders.id=participant.order_id WHERE participant.id=$1`,
      [stableUuid(`${scenario.id}:historical-participant`)]
    );
    expect(historical.rows[0]).toEqual({ status: 'ACTIVE', order_status: 'IN_SERVICE', earning: 60 });
    await server.close();
  });

  test('BNUI-PLY-003 validates batch compensation and freezes the selected rule into the participant snapshot', async () => {
    const scenario = await seedScenario('BNUI-PLY-003', 8);
    await seedPlayer(scenario, 'active', 'ACTIVE');
    const [catalog, secondCatalog] = await seedDirectCatalogs(scenario, ['DELTA', 'DELTA']);
    const offering = await pool.query<{ service_offering_id: string }>(
      `SELECT service_offering_id FROM service_catalog_versions WHERE id=$1`,
      [catalog]
    );
    const secondOffering = await pool.query<{ service_offering_id: string }>(
      `SELECT service_offering_id FROM service_catalog_versions WHERE id=$1`,
      [secondCatalog]
    );
    const compensation = new PostgresPlayerCompensationStore(pool);
    const rules = await upsertPlayerCompensationRules({
      store: compensation,
      playerId: scenario.playerId,
      actorStaffId: scenario.staffId,
      now,
      rules: [
        {
          serviceOfferingId: offering.rows[0]!.service_offering_id,
          expectedVersion: null,
          type: 'PERCENT_BPS',
          value: 7500,
          currency: null
        },
        {
          serviceOfferingId: secondOffering.rows[0]!.service_offering_id,
          expectedVersion: null,
          type: 'FIXED_MINOR',
          value: 50,
          currency: 'CAT'
        }
      ]
    });
    expect(rules).toHaveLength(2);
    const before = await snapshotBusinessFacts(pool, ['player_service_compensation_rules']);
    await expect(
      upsertPlayerCompensationRules({
        store: compensation,
        playerId: scenario.playerId,
        actorStaffId: scenario.staffId,
        now,
        rules: [
          {
            serviceOfferingId: offering.rows[0]!.service_offering_id,
            expectedVersion: 1,
            type: 'PERCENT_BPS',
            value: 8000,
            currency: null
          },
          {
            serviceOfferingId: secondOffering.rows[0]!.service_offering_id,
            expectedVersion: 99,
            type: 'FIXED_MINOR',
            value: 60,
            currency: 'CAT'
          }
        ]
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNoBusinessWrites(before, await snapshotBusinessFacts(pool, Object.keys(before)));

    const orderId = await seedDraftOrder(scenario, 'compensation-order');
    const participants = new PostgresOrderParticipantStore(pool);
    const staged = await participants.add({
      orderId,
      actorStaffId: scenario.staffId,
      actorLevel: 'L3_OPERATIONS',
      guildId: scenario.guildId,
      playerId: scenario.playerUserId,
      serviceCatalogVersionId: catalog,
      unitCount: 1,
      linePriceMinor: 100,
      expectedOrderVersion: 1,
      reasonCode: 'ADD_PLAYER',
      idempotencyKey: 'nui:a2:compensation:participant',
      now
    });
    await staged.commit(audit(scenario, 'ADD_ADMIN_ORDER_PARTICIPANT', staged.data.participant.id, 'ply3-participant'));
    expect(staged.data.participant).toMatchObject({
      compensationType: 'PERCENT_BPS',
      compensationValue: 7500,
      compensationSource: 'PLAYER_OVERRIDE',
      expectedEarningMinor: 75
    });
    await upsertPlayerCompensationRule({
      store: compensation,
      playerId: scenario.playerId,
      serviceOfferingId: offering.rows[0]!.service_offering_id,
      expectedVersion: 1,
      type: 'FIXED_MINOR',
      value: 40,
      currency: 'CAT',
      actorStaffId: scenario.staffId,
      now: new Date(now.getTime() + 1_000)
    });
    const frozen = await participants.list({
      orderId,
      actorStaffId: scenario.staffId,
      actorLevel: 'L3_OPERATIONS',
      guildId: scenario.guildId,
      cursor: null,
      limit: 20
    });
    expect(frozen.items[0]).toMatchObject({ compensationValue: 7500, expectedEarningMinor: 75 });
  });
});

function scenarioFixture(id: string, sequence: number): Scenario {
  return {
    id,
    guildId: stableSnowflake(`${id}:${sequence}:guild`),
    staffUserId: stableUuid(`${id}:${sequence}:staff-user`),
    staffId: stableUuid(`${id}:${sequence}:staff`),
    customerId: stableUuid(`${id}:${sequence}:customer`),
    playerUserId: stableUuid(`${id}:${sequence}:player-user`),
    playerId: stableUuid(`${id}:${sequence}:player-profile`)
  };
}

async function seedScenario(id: string, sequence: number): Promise<Scenario> {
  const scenario = scenarioFixture(id, sequence);
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,$2,'ACTIVE',1,$3,$3)`,
    [scenario.staffUserId, `${id} staff`, now]
  );
  await pool.query(
    `INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
     VALUES($1,$2,'L3_OPERATIONS','ACTIVE','MANUAL',1,$3,$3)`,
    [scenario.staffId, scenario.staffUserId, now]
  );
  await pool.query(
    `INSERT INTO guild_bot_configs(guild_id,version,config_json,updated_by_staff_id,updated_at)
     VALUES($1,1,$2::jsonb,$3,$4)`,
    [
      scenario.guildId,
      JSON.stringify({
        companion_applicant_role_id: stableSnowflake(`${id}:applicant-role`),
        companion_role_id: stableSnowflake(`${id}:companion-role`)
      }),
      scenario.staffId,
      now
    ]
  );
  return scenario;
}

function catalogActor(scenario: Scenario) {
  return {
    actorId: scenario.staffUserId,
    actorStaffId: scenario.staffId,
    actorLevel: 'L3_OPERATIONS' as const,
    actorSource: 'DASHBOARD' as const,
    clientId: 'DASHBOARD',
    guildId: scenario.guildId,
    discordUserId: null,
    interactionId: null,
    permissionsVersion: 1
  };
}

function catalogInput(game: string, service: string, customer: number, player: number, enabled: boolean) {
  return {
    game,
    gameDisplayName: game,
    service,
    serviceDisplayName: service,
    region: null,
    regionDisplayName: null,
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPrice: { amountMinor: customer, currency: 'CAT' as const },
    playerUnitPayout: { amountMinor: player, currency: 'CAT' as const },
    defaultPlayerPayoutBps: Math.floor((player * 10_000) / customer),
    enabled,
    reasonCode: 'CATALOG_CHANGE'
  };
}

async function commitCatalog(
  store: PostgresServiceCatalogStore,
  scenario: Scenario,
  prepared: Awaited<ReturnType<typeof prepareCreateServiceCatalogVersion>>,
  key: string
) {
  await store.commit!({
    records: prepared.records,
    auditRecord: audit(scenario, 'CREATE_SERVICE_CATALOG_VERSION', prepared.data.id, key),
    auditSink: new InMemoryAuditSink()
  });
}

async function seedHistoricalRequirement(scenario: Scenario, catalogId: string, price: number) {
  const orderId = await seedDraftOrder(scenario, 'historical-order');
  await pool.query(
    `INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,
     game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,
     billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,
     estimated_line_price_minor,created_at,updated_at)
     VALUES($1,$2,$3,'ACTIVE',1,'DELTA','DELTA','TECH','TECH',60,1,1,$4,$4,$5,$5)`,
    [stableUuid(`${scenario.id}:historical-requirement`), orderId, catalogId, price, now]
  );
}

async function seedDirectCatalogs(scenario: Scenario, games: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, game] of games.entries()) {
    const offeringId = stableUuid(`${scenario.id}:offering:${index}`);
    const catalogId = stableUuid(`${scenario.id}:catalog:${index}`);
    const serviceCode = `${scenario.id.replaceAll('-', '_')}_${index}`;
    ids.push(catalogId);
    await pool.query(
      `INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at)
       VALUES($1,$2,$3,$3,$4,$4,NULL,$5,$5)`,
      [offeringId, `${scenario.id}|${game}|${index}`, game, serviceCode, now]
    );
    await pool.query(
      `INSERT INTO service_catalog_versions(id,service_offering_id,version,status,active_offering_key,billing_unit_minutes,
       minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,
       created_by_staff_id,activated_at,created_at)
       VALUES($1,$2,1,'ACTIVE',$2,60,1,100,60,6000,'CAT',$3,$4,$4)`,
      [catalogId, offeringId, scenario.staffId, now]
    );
  }
  return ids;
}

function packagePayload(
  code: string,
  activate: boolean,
  slots: Array<{ serviceCatalogVersionId: string; unitCount: number; customerNoteTemplate: string | null }>
) {
  return {
    code,
    displayName: code,
    description: `${code} non-UI package`,
    currency: 'CAT' as const,
    activate,
    slots,
    reasonCode: 'PACKAGE_CHANGE'
  };
}

async function seedPlayer(scenario: Scenario, suffix: string, status: 'PENDING_REVIEW' | 'ACTIVE') {
  const playerUserId = suffix === 'active' ? scenario.playerUserId : stableUuid(`${scenario.id}:${suffix}:user`);
  const playerId = suffix === 'active' ? scenario.playerId : stableUuid(`${scenario.id}:${suffix}:profile`);
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,$2,'ACTIVE',1,$3,$3)`,
    [playerUserId, `${scenario.id}-${suffix}`, now]
  );
  await pool.query(
    `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,username,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$6)`,
    [
      stableUuid(`${scenario.id}:${suffix}:discord-account`),
      playerUserId,
      scenario.guildId,
      stableSnowflake(`${scenario.id}:${suffix}:discord-user`),
      `${scenario.id}-${suffix}`,
      now
    ]
  );
  await pool.query(
    `INSERT INTO player_profiles(id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at)
     VALUES($1,$2,$3,1,'AVAILABLE','ONLINE',$4,$4)`,
    [playerId, playerUserId, status, now]
  );
  return { playerUserId, playerId };
}

async function seedPlayerTags(scenario: Scenario) {
  const ids = {
    game: stableUuid(`${scenario.id}:tag:game`),
    service: stableUuid(`${scenario.id}:tag:service`),
    language: stableUuid(`${scenario.id}:tag:language`)
  };
  await pool.query(
    `INSERT INTO skill_tags(id,type,code,display_name,enabled,row_version,created_at,updated_at) VALUES
     ($1,'GAME',$5,'三角洲',true,1,$4,$4),
     ($2,'SERVICE',$6,'技术陪玩',true,1,$4,$4),
     ($3,'LANGUAGE',$7,'中文',true,1,$4,$4)`,
    [
      ids.game,
      ids.service,
      ids.language,
      now,
      `${scenario.id}_GAME`,
      `${scenario.id}_SERVICE`,
      `${scenario.id}_LANGUAGE`
    ]
  );
  return ids;
}

async function seedDraftOrder(scenario: Scenario, suffix: string): Promise<string> {
  const orderId = stableUuid(`${scenario.id}:${suffix}`);
  const customerId =
    suffix === 'historical-order' && scenario.id === 'BNUI-CAT-001'
      ? scenario.customerId
      : stableUuid(`${scenario.id}:${suffix}:customer`);
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
     VALUES($1,$2,'ACTIVE',1,$3,$3) ON CONFLICT(id) DO NOTHING`,
    [customerId, `${scenario.id} customer`, now]
  );
  await pool.query(
    `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,
     expected_player_earning_minor,currency,guild_id,channel_id,panel_message_id,created_at,updated_at)
     VALUES($1,$2,$3,$3,'DRAFT',1,0,0,'CAT',$4,$5,$6,$7,$7)`,
    [
      orderId,
      `P-${scenario.id.slice(-3)}-${suffix}`,
      customerId,
      scenario.guildId,
      stableSnowflake(`${scenario.id}:${suffix}:channel`),
      stableSnowflake(`${scenario.id}:${suffix}:panel`),
      now
    ]
  );
  return orderId;
}

function playerServer(scenario: Scenario): FastifyInstance {
  const staff: StaffAccount = {
    staffId: scenario.staffId,
    userId: scenario.staffUserId,
    level: 'L3_OPERATIONS',
    permissionsVersion: 1,
    status: 'ACTIVE'
  };
  return buildApiServer({
    env,
    security: {
      dashboardSessions: { resolve: () => ({ ok: true as const, staff, csrfToken: 'csrf' }), verifyCsrf: () => true },
      dashboardGuildId: scenario.guildId,
      auditSink: new PostgresAuditSink({ client: pool }),
      idempotencyStore: new PostgresIdempotencyStore({ client: pool, now: () => now })
    },
    player: {
      store: new PostgresPlayerStore({ pool }),
      businessTags: new PostgresBusinessTagStore(pool),
      now: () => now
    }
  });
}

function dashboardHeaders(key: string) {
  return {
    cookie: 'p0_session=session; p0_csrf=csrf',
    'x-csrf-token': 'csrf',
    'x-client-source': 'DASHBOARD',
    'idempotency-key': key
  };
}

function audit(scenario: Scenario, action: string, targetId: string, key: string): AuditRecord {
  return {
    id: stableUuid(`${scenario.id}:audit:${key}`),
    actorId: scenario.staffUserId,
    actorStaffId: scenario.staffId,
    actorLevel: 'L3_OPERATIONS',
    actorSource: 'DASHBOARD',
    clientId: 'DASHBOARD',
    interactionId: null,
    permissionCode: action.includes('PLAYER') ? 'player.approve' : 'catalog.manage',
    action,
    targetType: action.includes('PACKAGE') ? 'service_package_version' : 'service_catalog_version',
    targetId,
    outcome: 'SUCCEEDED',
    reason: 'non-ui automation',
    requestId: `req-${key}`,
    approvalRequestId: null,
    occurredAt: now.toISOString(),
    changes: []
  };
}
