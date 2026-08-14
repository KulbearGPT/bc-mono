# M10-US-08 数据与 API 本地候选

日期：2026-08-04

## 实现

- 新增套餐、套餐版本、默认席位、订单套餐来源及构成模式的 Prisma 模型与完整迁移。
- 套餐版本内容和槽位受数据库触发器保护；历史版本不可删除或原地改写。
- 新增 `listServicePackages`、`previewServicePackage`、`applyServicePackage` 运行时路由。
- `applyServicePackage` 在同一事务内校验所有槽位目录可用性、移除旧需求、逐槽生成新需求及事件、更新订单来源和服务端价格。
- 每个套餐槽位固定生成一条 `requestedPlayerCount = 1` 的需求，并保存 `sourcePackageSlotId`。
- 修改套餐生成的任一需求后，订单切换到 `CUSTOMIZED` 并使用最终有效需求的服务端派生价格。
- 需求支持最多 500 字的顾客席位备注及只追加 `NOTE_CHANGED` 事件。
- Discord 私密订单面板支持套餐列表、默认阵容预览、原子应用、逐席位更换项目和逐席位偏好；组件 custom ID 可跨 Bot 重启恢复。
- 套餐默认价与目录原价的差额由 API 返回为 `catalogSubtotalMinor` / `packageAdjustmentMinor`，Bot 只展示服务端结果；定制任一席位后恢复按有效需求重报价。
- PostgreSQL 专用事务测试验证了两个独立席位、备注、事件、套餐价格与审计同事务提交，并验证审计失败时整笔回滚。

## TDD 与验证

RED：`tests/m10-us-08-service-packages-db.spec.ts` 在迁移不存在时失败。

GREEN：

```text
npx vitest run tests/m10-us-08-service-packages-api.spec.ts tests/m10-us-08-service-packages-db.spec.ts tests/m10-us-08-service-packages-contract.spec.ts tests/m10-us-07-order-requirements.spec.ts --reporter=dot
Test Files  4 passed (4)
Tests       15 passed (15)

npx vitest run tests/m10-us-08-service-packages-postgres.spec.ts --reporter=verbose
Test Files  1 passed (1)
Tests       2 passed (2)

npx vitest run $(rg -l "@blackcat/bot|apps/bot" tests --glob '*.spec.ts' | sort) --reporter=dot
Test Files  35 passed (35)
Tests       187 passed (187)

npm run typecheck
PASS

npm run db:validate
The schema at database/prisma/schema.prisma is valid

npm run db:verify:migration
migration-apply-ok
table_count=81
```

## 未完成

- 套餐运营端创建/发布与 Dashboard 套餐详情后续已完成本地候选，见 `admin-dashboard.md`；真实 Guild/Dashboard UAT 尚未完成。
- 因此本文件仅证明数据/API 本地候选，不声明 `M10-US-08` 完成。
