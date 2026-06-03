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

  test('replaces free-text service, companion and gift classification fields with selects', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync('apps/dashboard/src/AdminBusinessPage.tsx', 'utf8'));
    expect(source).toContain('businessTagOptions');
    expect(source).toContain('name="gameTagId"');
    expect(source).toContain('name="serviceTagIds"');
    expect(source).toContain('name="giftCategoryTagId"');
    expect(source).not.toContain('游戏标签（逗号分隔）');
    expect(source).not.toContain('服务标签（逗号分隔）');
  });
});
