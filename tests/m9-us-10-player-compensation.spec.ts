import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  InMemoryPlayerCompensationStore,
  calculatePlayerCompensation,
  upsertPlayerCompensationRule,
  upsertPlayerCompensationRules
} from '@blackcat/api/player-compensation';
import { buildAdminActionRequest } from '@blackcat/dashboard/admin-business';

describe('M9-US-10 per-player service compensation', () => {
  test('grants the API runtime role access to compensation rules', async () => {
    const migration = await readFile('database/prisma/migrations/000017_player_compensation_runtime_grant/migration.sql', 'utf8');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON player_service_compensation_rules TO blackcat_app');
  });
  test('uses the catalog default percentage when a player has no override', () => {
    expect(calculatePlayerCompensation({ customerUnitPriceMinor: 20, unitCount: 2, defaultPayoutBps: 6000, rule: null }))
      .toEqual({ unitPayoutMinor: 12, totalPayoutMinor: 24, source: 'CATALOG_DEFAULT' });
  });

  test('prefers a player percentage or fixed per-unit override', () => {
    expect(calculatePlayerCompensation({ customerUnitPriceMinor: 20, unitCount: 2, defaultPayoutBps: 6000,
      rule: { type: 'PERCENT_BPS', value: 7500, currency: null } })).toMatchObject({ unitPayoutMinor: 15, totalPayoutMinor: 30, source: 'PLAYER_OVERRIDE' });
    expect(calculatePlayerCompensation({ customerUnitPriceMinor: 20, unitCount: 2, defaultPayoutBps: 6000,
      rule: { type: 'FIXED_MINOR', value: 11, currency: 'CAT' } })).toMatchObject({ unitPayoutMinor: 11, totalPayoutMinor: 22, source: 'PLAYER_OVERRIDE' });
  });

  test('upserts an editable player/service rule with optimistic versioning', async () => {
    const store = new InMemoryPlayerCompensationStore();
    const created = await upsertPlayerCompensationRule({ store, playerId: 'player-1', serviceOfferingId: 'offering-1',
      expectedVersion: null, type: 'PERCENT_BPS', value: 6000, currency: null, actorStaffId: 'staff-1', now: new Date('2026-08-02T20:00:00Z') });
    const updated = await upsertPlayerCompensationRule({ store, playerId: 'player-1', serviceOfferingId: 'offering-1',
      expectedVersion: created.version, type: 'FIXED_MINOR', value: 12, currency: 'CAT', actorStaffId: 'staff-1', now: new Date('2026-08-02T21:00:00Z') });
    expect(updated).toMatchObject({ type: 'FIXED_MINOR', value: 12, currency: 'CAT', version: 2 });
  });

  test('writes multiple project overrides together and rejects the whole stale batch', async () => {
    const store = new InMemoryPlayerCompensationStore();
    await upsertPlayerCompensationRules({store,playerId:'player-1',actorStaffId:'staff-1',now:new Date(),rules:[
      {serviceOfferingId:'offering-1',expectedVersion:null,type:'PERCENT_BPS',value:6000,currency:null},
      {serviceOfferingId:'offering-2',expectedVersion:null,type:'FIXED_MINOR',value:12,currency:'CAT'}
    ]});
    await expect(upsertPlayerCompensationRules({store,playerId:'player-1',actorStaffId:'staff-1',now:new Date(),rules:[
      {serviceOfferingId:'offering-1',expectedVersion:1,type:'PERCENT_BPS',value:7000,currency:null},
      {serviceOfferingId:'offering-2',expectedVersion:99,type:'FIXED_MINOR',value:14,currency:'CAT'}
    ]})).rejects.toMatchObject({code:'CONFLICT'});
    expect(await store.find('player-1','offering-1')).toMatchObject({value:6000,version:1});
  });

  test('uses the database compensation enum when decoding a batch payload', async () => {
    const source = await readFile('apps/api/src/player-compensation.ts', 'utf8');
    expect(source).toContain('type "PlayerCompensationType"');
  });

  test('dashboard submits a selected service and exactly one override mode', () => {
    expect(buildAdminActionRequest({ actionId: 'EDIT_PLAYER_COMPENSATION', item: { playerId: 'player-1', version: 3 }, fields: {
      serviceOfferingId: 'offering-1', compensationType: 'PERCENT_BPS', percentage: '60', fixedAmountMinor: '', reasonCode: 'RATE_UPDATE'
    }})).toEqual({ method: 'PUT', path: '/api/v1/admin/players/player-1/compensation/offering-1', body: {
      expectedVersion: null, type: 'PERCENT_BPS', value: 6000, currency: null, reasonCode: 'RATE_UPDATE'
    }});
  });

  test('dashboard submits every cached project change in one request', () => {
    expect(buildAdminActionRequest({actionId:'EDIT_PLAYER_COMPENSATION',item:{playerId:'player-1',version:1},fields:{reasonCode:'RATE_UPDATE',compensationChangesJson:JSON.stringify([
      {serviceOfferingId:'offering-1',expectedVersion:'1',type:'PERCENT_BPS',percentage:'60',fixedAmountMinor:''},
      {serviceOfferingId:'offering-2',expectedVersion:'',type:'FIXED_MINOR',percentage:'',fixedAmountMinor:'12'}
    ])}})).toEqual({method:'PUT',path:'/api/v1/admin/players/player-1/compensation',body:{reasonCode:'RATE_UPDATE',rules:[
      {serviceOfferingId:'offering-1',expectedVersion:1,type:'PERCENT_BPS',value:6000,currency:null},
      {serviceOfferingId:'offering-2',expectedVersion:null,type:'FIXED_MINOR',value:12,currency:'CAT'}
    ]}});
  });

  test('dashboard shows every player project compensation as a visible list instead of a dropdown', async () => {
    const source = await readFile('apps/dashboard/src/AdminBusinessPage.tsx', 'utf8');
    expect(source).toContain('player-compensation-list');
    expect(source).toContain('player-compensation-item');
    expect(source).toContain('当前个人分成');
    expect(source).toContain('项目默认分成');
    expect(source).toMatch(/type="radio" name="serviceOfferingId"/u);
    expect(source).not.toMatch(/<select name="serviceOfferingId"/u);
  });

  test('caches compensation edits locally and requires a second confirmation before saving', async () => {
    const source = await readFile('apps/dashboard/src/AdminBusinessPage.tsx', 'utf8');
    expect(source).toContain('compensationDrafts');
    expect(source).toContain('草稿已缓存');
    expect(source).toContain('确认分成改动');
    expect(source).toContain('确认并保存');
    expect(source).toContain('CompensationChangeConfirmation');
    expect(source).toContain('确认并保存全部');
    expect(source).toContain('compensationChangesJson');
  });
});
