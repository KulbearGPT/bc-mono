# M10-US-08 套餐运营端本地候选

日期：2026-08-04

## 合同修订

- 主规格、OpenAPI、backlog、交互映射和验收合同新增 Dashboard 套餐版本管理。
- 新增 `listAdminServicePackages`、`createAdminServicePackageVersion`、`updateAdminServicePackageVersionStatus`。
- `AT-MULTI-010` 要求 L3+ 原子创建全部有序席位、服务端分配版本号、发布时退役旧启用版本、历史版本不删除。

## 实现

- Dashboard 新增“服务套餐”工作区，可创建套餐草稿或立即发布。
- 套餐表单支持 1–25 个有序独立席位；每席位选择有效服务目录版本、单位数和默认偏好。
- 套餐总价可留空由 API 汇总目录价；Dashboard 不计算订单价格或陪玩分成。
- 草稿可以发布，启用版本可以退役；已退役版本只读展示。
- PostgreSQL 在单事务创建套餐、不可变版本、全部席位和审计；发布新版本原子退役旧版本。
- 服务目录退役后，历史套餐仍可在运营端与历史订单详情中解析；客户/Bot 列表不会展示已失效的启用套餐。
- 订单 overlay 展示来源套餐代码、名称、版本、默认/自定义构成、目录原价、套餐调整、逐席位来源与顾客偏好。

## TDD 与验证

RED：

```text
npx vitest run tests/m10-us-08-service-packages-api.spec.ts --reporter=dot
POST /api/v1/admin/service-packages -> 404
Test Files 1 failed
```

GREEN：

```text
npm run typecheck
PASS

npx vitest run tests/m10-us-08-service-packages-contract.spec.ts tests/m10-us-08-service-packages-admin-contract.spec.ts tests/m10-us-08-service-packages-db.spec.ts tests/m10-us-08-service-packages-api.spec.ts tests/m10-us-08-service-packages-bot.spec.ts tests/m10-us-08-service-packages-postgres.spec.ts tests/m10-us-08-service-packages-dashboard.spec.ts tests/m10-us-03-api.spec.ts --reporter=dot
Test Files  8 passed (8)
Tests       26 passed (26)

npx vitest run $(rg -l "@blackcat/dashboard|apps/dashboard" tests --glob '*.spec.ts' | sort) --reporter=dot
Test Files  27 passed (27)
Tests       130 passed (130)

npm run build -w @blackcat/dashboard
1593 modules transformed
build succeeded
```

专用 PostgreSQL 套餐回归随后扩充为 `1 file / 4 tests passed`，覆盖应用、审计回滚、版本发布和目录退役后的历史读取。

## 剩余门禁

- 仍需在真实 Dashboard 会话创建/发布套餐，并在测试 Guild 验证 Bot 列表、预览、改单和重启恢复。
- 因此 `M10-US-08` 保持未完成，不把本地渲染测试描述为真实 UAT。
