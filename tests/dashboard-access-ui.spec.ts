import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AccessManagementPage } from '../apps/dashboard/src/AccessManagementPage.js';
import {
  buildRoleMappingUpdateRequest,
  type RoleMappingRecord
} from '../apps/dashboard/src/access-management.js';

const mappings: RoleMappingRecord[] = [
  {
    guildId: 'guild-1',
    discordRoleId: 'role-110',
    targetLevel: 'L1_SUPPORT',
    enabled: true,
    version: 12,
    reconciliationQueued: false
  }
];

describe('Dashboard access-management UI', () => {
  test('renders the L4 access workspace instead of falling back to the overview', () => {
    const html = renderToStaticMarkup(createElement(AccessManagementPage, {
      model: { kind: 'READY', mappings, requestId: null },
      onRefresh: () => undefined,
      onUpdateMapping: () => undefined
    }));

    expect(html).toContain('权限管理');
    expect(html).toContain('Discord Role 映射');
    expect(html).toContain('L1 客服');
    expect(html).toContain('role-110');
    expect(html).toContain('仅内部有效级别决定最终权限');
  });

  test('builds mapping writes from server versions without inferring authorization', () => {
    expect(buildRoleMappingUpdateRequest({
      mapping: mappings[0]!,
      discordRoleId: 'role-111',
      reasonCode: 'ROLE_MAPPING_CORRECTION'
    })).toEqual({
      method: 'PUT',
      path: '/api/v1/admin/discord-role-mappings/L1_SUPPORT',
      body: {
        guildId: 'guild-1',
        discordRoleId: 'role-111',
        expectedVersion: 12,
        enabled: true,
        reasonCode: 'ROLE_MAPPING_CORRECTION'
      }
    });
  });

  test('keeps sidebar navigation mounted and scopes route loading to the content region', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => [
      'apps/dashboard/src/App.tsx',
      'apps/dashboard/src/DashboardChrome.tsx'
    ].map((path) => readFileSync(path, 'utf8')).join('\n'));
    expect(source).toContain("currentPath === '/access'");
    expect(source).toContain('window.history.pushState');
    expect(source).toContain('setCurrentPath');
    expect(source).toContain('aria-busy={props.contentBusy}');
    expect(source).not.toMatch(/onNavigate[\s\S]{0,300}window\.location\.href/u);
  });
});
