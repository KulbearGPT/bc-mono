# M13-US-02 验收证据

## Story

- Story：`M13-US-02` 七类列表 API 稳定排序与游标
- 状态：本地候选完成
- 日期：2026-08-05
- Requirement：`LST-01; ACCESS-02`
- 验收：`AT-LST-001`、`AT-LST-002`、`AT-LST-003`、`AT-LST-008`

## 实现范围

- 新增七资源共用的排序字段白名单、默认值解析、确定性比较和签名 keyset 游标。
- 游标绑定资源、Guild、Actor scope、筛选、排序字段、方向、排序值和唯一 ID；篡改或跨查询复用返回 400。
- 升序和降序均使用唯一 ID tie-breaker，空值固定 `NULLS LAST`。
- 订单、用户、陪玩、服务目录、服务套餐、礼物目录、礼物请求的内存与 PostgreSQL 存储均接入；服务套餐不再使用 offset 游标。
- PostgreSQL 只拼接服务端白名单 SQL 表达式，并增加可排序投影的复合索引；金额继续使用 minor-unit 整数。

## RED / GREEN

```text
npx vitest run tests/m13-us-02-stable-sort.spec.ts
RED: Cannot find package '@blackcat/api/admin-collection-sort'
```

```text
npx vitest run tests/m13-us-02-stable-sort.spec.ts
Test Files  1 passed (1)
Tests       6 passed (6)
```

完整命令与最终结果见同目录 `summary.md`。

## 修改文件

- `apps/api/src/admin-collection-sort.ts`
- `apps/api/src/admin-directory.ts`
- `apps/api/src/catalog.ts`
- `apps/api/src/service-packages.ts`
- `database/prisma/schema.prisma`
- `database/prisma/migrations/000034_m13_collection_sort_indexes/migration.sql`
- `outputs/P0开发交付包/03-数据模型/schema.prisma`
- `docs/P0开发交付包/03-数据模型/schema.prisma`
- `tests/m13-us-02-stable-sort.spec.ts`
- `tests/m1-us-01-db.spec.ts`
- `tests/m4-us-03-api.spec.ts`
- `outputs/Codex-P0开发TODO.md` 与 `docs/Codex-P0开发TODO.md`
- `evidence/P0/acceptance-matrix.csv`
- 本证据目录

## 边界

- 本 Story 不实现 Dashboard CARD/TABLE 视图；该范围属于 `M13-US-03`。
- `AT-LST-008` 的 API scope 与游标绑定已有自动化回归；真实员工 L1–L4、跨 Guild Dashboard UAT 仍属于 `M13-US-04`，本证据不提前宣称外部验收通过。
