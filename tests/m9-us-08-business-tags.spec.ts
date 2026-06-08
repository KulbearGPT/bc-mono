import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  BusinessTagError,
  InMemoryBusinessTagStore,
  createBusinessTag,
  updateBusinessTag
} from '@blackcat/api/business-tags';
import { BusinessTagsPage } from '../apps/dashboard/src/BusinessTagsPage.js';
import { buildBusinessTagCreateRequest, groupEnabledBusinessTags } from '../apps/dashboard/src/business-tags.js';
import { buildAdminActionRequest } from '../apps/dashboard/src/admin-business.js';

const actor = { actorStaffId: 'staff-1', actorLevel: 'L3_OPERATIONS' as const };

describe('M9-US-08 unified business tags', () => {
  test('creates stable typed codes and only updates display name or enabled state', async () => {
    const store = new InMemoryBusinessTagStore();
    const created = await createBusinessTag({ store, actor, input: { type: 'GAME', code: 'valorant', displayName: '无畏契约' } });
    expect(created).toMatchObject({ type: 'GAME', code: 'VALORANT', displayName: '无畏契约', enabled: true, version: 1 });

    const disabled = await updateBusinessTag({ store, actor, tagId: created.id, input: { expectedVersion: 1, displayName: '无畏契约', enabled: false } });
    expect(disabled).toMatchObject({ code: 'VALORANT', enabled: false, version: 2 });
    await expect(updateBusinessTag({ store, actor, tagId: created.id, input: { expectedVersion: 1, displayName: 'VAL', enabled: true } }))
      .rejects.toBeInstanceOf(BusinessTagError);
  });

  test('groups only enabled options by their fixed business type', () => {
    const grouped = groupEnabledBusinessTags([
      { id: 'g1', type: 'GAME', code: 'VALORANT', displayName: '无畏契约', enabled: true, version: 1 },
      { id: 's1', type: 'SERVICE', code: 'RANKED', displayName: '排位陪玩', enabled: true, version: 1 },
      { id: 'x1', type: 'GIFT_CATEGORY', code: 'PREMIUM', displayName: '高端礼物', enabled: false, version: 2 }
    ]);
    expect(grouped.GAME).toHaveLength(1);
    expect(grouped.SERVICE).toHaveLength(1);
    expect(grouped.GIFT_CATEGORY).toEqual([]);
  });

  test('renders a dedicated management page and emits stable create requests', () => {
    const html = renderToStaticMarkup(createElement(BusinessTagsPage, {
      model: { kind: 'READY', items: [], requestId: null },
      onCreate: () => undefined,
      onUpdate: () => undefined,
      onRefresh: () => undefined
    }));
    expect(html).toContain('业务标签库');
    expect(html).toContain('游戏');
    expect(html).toContain('礼物分类');
    expect(buildBusinessTagCreateRequest({ type: 'SERVICE', code: 'ranked', displayName: '排位陪玩' })).toEqual({
      method: 'POST', path: '/api/v1/admin/business-tags', body: { type: 'SERVICE', code: 'RANKED', displayName: '排位陪玩' }
    });
  });

  test('keeps tag rows inside their card grid at dense desktop widths', async () => {
    const html = renderToStaticMarkup(createElement(BusinessTagsPage, {
      model: {
        kind: 'READY',
        requestId: null,
        items: [{ id: 'g1', type: 'GAME', code: 'VALORANT', displayName: '无畏契约', enabled: true, version: 1 }]
      },
      onCreate: () => undefined,
      onUpdate: () => undefined,
      onRefresh: () => undefined
    }));
    const { readFile } = await import('node:fs/promises');
    const styles = await readFile('apps/dashboard/src/styles.css', 'utf8');
    expect(html).toContain('class="tag-row__identity"');
    expect(html).toContain('class="tag-row__actions"');
    expect(styles).toMatch(/\.tag-type-grid\s*\{[\s\S]*width:\s*100%[\s\S]*min-width:\s*0[\s\S]*margin-top:\s*18px/u);
    expect(styles).toMatch(/\.tag-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*\.8fr\)\s+minmax\(0,\s*1.4fr\)\s+minmax\(74px,\s*90px\)\s+minmax\(156px,\s*\.9fr\)/u);
    expect(styles).toMatch(/\.tag-row__actions\s*\{[\s\S]*white-space:\s*nowrap/u);
  });

  test('replaces free-text service, companion and gift classification fields with selects', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync('apps/dashboard/src/AdminBusinessPage.tsx', 'utf8'));
    expect(source).toContain('businessTagOptions');
    expect(source).toContain('name="gameTagId"');
    expect(source).toContain('name="serviceTagIds"');
    expect(source).toContain('name="giftCategoryTagId"');
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("action.id==='EDIT_COMPANION_TAGS'");
    expect(source).not.toContain('游戏标签（逗号分隔）');
    expect(source).not.toContain('服务标签（逗号分隔）');
  });

  test('keeps tag maintenance permissioned and audited without requiring MFA step-up', async () => {
    const { readFile } = await import('node:fs/promises');
    const routeSource = await readFile('apps/api/src/business-tags.ts', 'utf8');
    const openApi = await readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8');
    const tagPaths = openApi.slice(openApi.indexOf('  /api/v1/admin/business-tags:'), openApi.indexOf('\ncomponents:'));
    expect(routeSource).toContain("permission:'catalog.manage'");
    expect(routeSource).not.toContain('requiresRecentStepUp:true');
    expect(tagPaths).not.toContain('x-requires-recent-step-up');
  });

  test('replaces an approved companion support range with multiple tag IDs', () => {
    expect(buildAdminActionRequest({
      actionId: 'EDIT_COMPANION_TAGS',
      item: { playerId: 'player-1', version: 4 },
      fields: { gameTagIds: 'game-1,game-2', serviceTagIds: 'service-1,service-2', languageTagIds: 'language-1', reasonCode: 'SUPPORT_RANGE_UPDATE' }
    })).toEqual({
      method: 'PUT', path: '/api/v1/admin/players/player-1/tags',
      body: { expectedVersion: 4, gameTagIds: ['game-1','game-2'], serviceTagIds: ['service-1','service-2'], languageTagIds: ['language-1'], reasonCode: 'SUPPORT_RANGE_UPDATE' }
    });
  });

  test('does not require MFA step-up for service or gift catalog maintenance', async () => {
    const { readFile } = await import('node:fs/promises');
    const catalog = await readFile('apps/api/src/catalog.ts', 'utf8');
    const directory = await readFile('apps/api/src/admin-directory.ts', 'utf8');
    const giftRoutes = directory.slice(directory.indexOf("url: '/api/v1/admin/gift-catalog'"), directory.indexOf('\n}\n\nfunction bindAudit'));
    expect(catalog.slice(catalog.indexOf("url: '/api/v1/admin/service-catalog'"), catalog.indexOf('\nfunction requireCatalogManager'))).not.toContain('requiresRecentStepUp');
    expect(giftRoutes).not.toContain('requiresRecentStepUp');
  });
});
