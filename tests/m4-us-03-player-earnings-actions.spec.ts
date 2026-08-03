import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage } from '@blackcat/dashboard/admin-business';

const earnings = [
  { id: 'earning-pending', playerId: 'player-1', status: 'PENDING', amountMinor: 8_400, currency: 'CAT', version: 1, createdAt: '2026-08-10T00:00:00.000Z' },
  { id: 'earning-confirmed', playerId: 'player-2', status: 'CONFIRMED', amountMinor: 6_200, currency: 'CAT', version: 2, createdAt: '2026-08-10T00:01:00.000Z' },
  { id: 'earning-paid', playerId: 'player-3', status: 'PAID', amountMinor: 5_000, currency: 'CAT', version: 3, createdAt: '2026-08-10T00:02:00.000Z' }
];

function renderEarnings(permissions: string[]) {
  const model = buildAdminBusinessPage({ page: 'playerEarnings', permissions, status: 'READY', items: earnings });
  return renderToStaticMarkup(createElement(AdminBusinessPage, { model, onAction: () => undefined }));
}

describe('M4-US-03 player earning action visibility', () => {
  test('shows only the legal next action for each earning state', () => {
    const html = renderEarnings(['earnings.read', 'earnings.manage']);

    const desktopRows = html.split('<tbody>')[1]?.split('</tbody>')[0] ?? '';
    const mobileRows = html.split('<div class="collection-row-list">')[1] ?? '';
    const fragmentsFor = (id: string) => [
      ...desktopRows.split('<tr').filter((fragment) => fragment.includes(id)),
      ...mobileRows.split('<article class="collection-list-row"').filter((fragment) => fragment.includes(id))
    ];
    for (const fragment of fragmentsFor('earning-pending')) {
      expect(fragment).toContain('>确认收益</button>');
      expect(fragment).not.toContain('>标记已支付</button>');
    }
    for (const fragment of fragmentsFor('earning-confirmed')) {
      expect(fragment).not.toContain('>确认收益</button>');
      expect(fragment).toContain('>标记已支付</button>');
    }
    for (const fragment of fragmentsFor('earning-paid')) {
      expect(fragment).not.toContain('>确认收益</button>');
      expect(fragment).not.toContain('>标记已支付</button>');
    }

    expect(html).toContain('待确认收益可“确认收益”');
    expect(html).toContain('已确认收益可“标记已支付”');
    expect(html).toContain('已支付或已冲正记录只读');
  });

  test('explains why L2 can read earnings but cannot approve or mark payment', () => {
    const html = renderEarnings(['earnings.read']);

    expect(html).toContain('当前为只读视图');
    expect(html).toContain('需要 L3+ 的收益管理权限');
    expect(html).toContain('disabled=""');
    expect(html).toContain('>确认收益</button>');
    expect(html).toContain('>标记已支付</button>');
    expect(html).toContain('需要权限 earnings.manage');
    expect(html).toContain('>操作</th>');
  });

  test('does not render an empty operation column when every earning is terminal', () => {
    const model = buildAdminBusinessPage({
      page: 'playerEarnings',
      permissions: ['earnings.read', 'earnings.manage'],
      status: 'READY',
      items: earnings.filter((item) => item.status === 'PAID')
    });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, onAction: () => undefined }));

    expect(html).not.toContain('>操作</th>');
    expect(html).not.toContain('aria-label="可用操作"');
  });
});
