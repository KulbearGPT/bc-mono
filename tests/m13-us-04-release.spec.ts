import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  collectionSortFields,
  paginateAdminCollection,
  parseAdminCollectionSort,
  type AdminCollectionResource,
} from "@blackcat/api/admin-collection-sort";
import { AdminBusinessPage } from "../apps/dashboard/src/AdminBusinessPage.js";
import {
  adminCollectionConfigs,
  buildAdminBusinessPage,
  type AdminCollectionPageId,
} from "@blackcat/dashboard/admin-business";

const resourcePage: Record<AdminCollectionResource, AdminCollectionPageId> = {
  orders: "orders",
  users: "users",
  players: "players",
  service_catalog: "serviceCatalog",
  service_packages: "servicePackages",
  gift_catalog: "giftCatalog",
  gift_requests: "giftRequests",
};
const permissions = [
  "order.read",
  "user.read",
  "player.read",
  "catalog.read",
  "gift_catalog.read",
  "gift_request.read",
];

describe("M13-US-04 collection release regression", () => {
  test("keeps every Dashboard sort option aligned with the API whitelist and accepts both directions", () => {
    for (const [resource, fields] of Object.entries(
      collectionSortFields,
    ) as Array<[AdminCollectionResource, readonly string[]]>) {
      expect(
        adminCollectionConfigs[resourcePage[resource]].sortOptions.map(
          (option) => option.id,
        ),
      ).toEqual(fields);
      for (const sortBy of fields)
        for (const sortDirection of ["asc", "desc"] as const) {
          expect(
            parseAdminCollectionSort(
              resource,
              { sortBy, sortDirection },
              (message) => new Error(message),
            ),
          ).toEqual({ sortBy, sortDirection });
        }
    }
  });

  test("keeps null last and unique-id continuity across the complete sort matrix", () => {
    const rows = [
      { id: "00000000-0000-0000-0000-000000000001", value: 20 },
      { id: "00000000-0000-0000-0000-000000000002", value: 20 },
      { id: "00000000-0000-0000-0000-000000000003", value: null },
    ];
    for (const [resource, fields] of Object.entries(
      collectionSortFields,
    ) as Array<[AdminCollectionResource, readonly string[]]>) {
      for (const sortBy of fields)
        for (const sortDirection of ["asc", "desc"] as const) {
          const first = paginateAdminCollection(rows, {
            resource,
            cursor: null,
            limit: 1,
            sortBy,
            sortDirection,
            binding: { actorGuildId: "guild", actorScope: "L4", filters: {} },
            idOf: (row) => row.id,
            valueOf: (row) => row.value,
          });
          const second = paginateAdminCollection(rows, {
            resource,
            cursor: first.nextCursor,
            limit: 5,
            sortBy,
            sortDirection,
            binding: { actorGuildId: "guild", actorScope: "L4", filters: {} },
            idOf: (row) => row.id,
            valueOf: (row) => row.value,
          });
          const ids = [...first.items, ...second.items].map((row) => row.id);
          expect(new Set(ids).size).toBe(3);
          expect(ids.at(-1)).toBe("00000000-0000-0000-0000-000000000003");
        }
    }
  });

  test("renders keyboard-operable table/list controls for all seven resources", () => {
    for (const page of Object.values(resourcePage)) {
      const model = buildAdminBusinessPage({
        page,
        permissions,
        status: "READY",
        items: [
          {
            id: `${page}-1`,
            playerId: `${page}-player`,
            publicId: "P-1",
            displayName: "对象",
            name: "礼物",
            giftName: "礼物",
            status: "ACTIVE",
            createdAt: "2026-08-05T00:00:00Z",
          },
        ],
      });
      const html = renderToStaticMarkup(
        createElement(AdminBusinessPage, {
          model,
          view: "TABLE",
          sortBy: "createdAt",
          sortDirection: "desc",
          onViewChange: () => undefined,
          onSortChange: () => undefined,
          onOpenDetail: () => undefined,
        }),
      );
      expect(html).toContain('role="group"');
      expect(html).toContain('aria-label="排序字段"');
      expect(html).toContain('tabindex="0"');
      expect(html).toContain("查看详情");
    }
  });

  test("keeps real UAT in the current business Guild while retaining automated Guild isolation", async () => {
    const [todo, acceptance] = await Promise.all([
      readFile("outputs/Codex-P0开发TODO.md", "utf8"),
      readFile("outputs/P0开发交付包/07-验收测试/acceptance-cases.csv", "utf8"),
    ]);
    const releaseCase = acceptance.split("\n").find((line) => line.startsWith('"AT-LST-008"')) ?? "";
    expect(releaseCase).toContain("FX-TWO-GUILDS");
    expect(todo).not.toContain("当前 fixture 缺少 ACTIVE L2、L3 与第二 Guild");
    expect(todo).toContain("跨 Guild 隔离由 API/数据库自动化回归证明");
  });
});
