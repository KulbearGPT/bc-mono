# M10-US-03 本地候选证据

日期：2026-08-06

## 本次增量

- Dashboard 订单详情同时读取订单、项目需求、陪玩明细和交易时间线。
- 详情页展示顾客 Discord Tag/User ID，以及每位陪玩的 Discord Tag/User ID、所属需求、项目快照、计费数量、逐人价格、分成规则、来源和预计收益。
- 新增受 L1 已认领任务及 L2+ 同 Guild 范围约束的订单需求管理端只读接口。
- 管理端陪玩明细 API 返回 `orderRequirementId` 和对应 Discord 身份投影；页面不再要求工作人员通过内部 UUID 猜测人员身份。
- OpenAPI 的两份交付镜像已同步。
- Dashboard 现在在每条 ACTIVE 陪玩卡提供独立“改派陪玩”入口；`REASSIGN` 只替换 path `participantId` 的 player，保留需求、项目、数量和客户价格，重置 readiness，并按新陪玩规则重算分成。
- PostgreSQL 事务追加 `REASSIGNED` 参与事件；其他参与人、订单总价和等额 FundReservation 不变，重复陪玩、旧版本、越权和已捕获订单继续失败关闭。
- 修复既有项目/价格变更的事件投影丢失 `orderRequirementId`：数据库主行原本保留，但 API 返回与 append-only event snapshot 曾错误显示为 null。

## 验证

```text
npm run typecheck
PASS

npm run build -w @blackcat/dashboard
PASS (1599 modules transformed)

npx vitest run tests/m4-us-03-dashboard.spec.ts tests/m4-us-08-dashboard.spec.ts tests/m10-us-03-api.spec.ts tests/m10-us-03-postgres.spec.ts tests/m10-us-07-order-requirements.spec.ts tests/m10-us-01-contract.spec.ts
Test Files  6 passed (6)
Tests       44 passed (44)

cmp -s docs/P0开发交付包/02-API/openapi.yaml outputs/P0开发交付包/02-API/openapi.yaml
PASS (exit 0)

git diff --check
PASS
```

覆盖验收：`AT-MULTI-001` 的本地 API、数据库和静态 Dashboard 投影，以及 `AT-MULTI-006` 的管理端需求读取增量。

### 2026-08-06 单席位改派增量

```text
pnpm vitest run tests/m10-us-03-api.spec.ts tests/m10-us-03-postgres.spec.ts
Test Files  2 passed (2)
Tests       12 passed (12)

pnpm exec tsc --noEmit -p apps/api/tsconfig.json
pnpm exec tsc --noEmit -p apps/dashboard/tsconfig.json
PASS

node scripts/e2e/verify-dashboard-e2e-coverage.mjs
Dashboard E2E coverage verified: 120 planned IDs = 120 unique implemented IDs.

pnpm exec playwright test tests/e2e/dashboard/dashboard-order-mutations.spec.ts --project=chromium --grep DE2E-ORD-017
1 passed (6.3s)
```

新增覆盖验收：`AT-MULTI-010`。PostgreSQL 用例执行从 `000001` 到 `000035` 的完整空库迁移链，并验证 `ADDED → REASSIGNED` 只追加事件。

## 未完成门禁

- 尚未完成真实 Dashboard 浏览器环境中的九陪玩分页、编辑与视觉 UAT。
- 因外部门禁未完成，`outputs/Codex-P0开发TODO.md` 中 `M10-US-03` 保持未勾选；本证据不声明 Story 已完成或可发布。

### 2026-08-10 Dashboard 订单恢复编辑增量

- 权限沿用既有对象范围：L1 只能修改本人已认领任务关联订单，L2+ 只能修改同 Guild 订单；没有增加等级或“必须进入招募”的条件。
- Dashboard 订单详情新增订单备注与逐席位备注的添加、修改、清空入口；原有陪玩的添加、改价/改项目、单席位改派和逻辑移除入口继续保留。
- 订单/席位备注清空只更新当前投影，事务内仍追加 `DETAILS_UPDATED`、`NOTE_CHANGED`、审计和 `PANEL_SYNC`；订单金额、预留与收益不变。
- 陪玩与备注写入统一拒绝 `COMPLETED`、`CANCELLED` 和已捕获订单。浏览器回归期间发现空席位备注未显示“未填写”，已修复该投影。
- 新增验收 `AT-MULTI-015`、交互 `INT-A-084` 和浏览器用例 `DE2E-ORD-020`；合同、backlog 与 `docs/`/`outputs/` 镜像同步。

验证先行基线：

```text
npx vitest run tests/m10-us-03-api.spec.ts
Test Files  1 failed (1)
Tests       3 failed | 4 passed (7)
```

完成后的本地候选验证：

```text
npx vitest run tests/m10-us-03-api.spec.ts tests/m10-us-03-postgres.spec.ts
Test Files  2 passed (2)
Tests       14 passed (14)

npx vitest run tests/m10-us-01-contract.spec.ts tests/m10-us-07-order-requirements.spec.ts tests/m4-us-03-dashboard.spec.ts tests/m4-us-08-dashboard.spec.ts
Test Files  4 passed (4)
Tests       38 passed (38)

npm run typecheck
PASS

npm run lint:api-dashboard
PASS (0 errors, 38 existing warnings; threshold 39)

npm run quality:routes
Route contract parity passed: 162 production operations are documented.

npm run db:validate
The schema at database/prisma/schema.prisma is valid.

npm run db:verify:migration
migration-apply-ok; table_count=87

npm run e2e:coverage:verify
Dashboard E2E coverage verified: 130 planned IDs = 130 unique implemented IDs.

DASHBOARD_E2E_API_PORT=3300 DASHBOARD_E2E_PORT=5273 npx playwright test tests/e2e/dashboard/dashboard-order-mutations.spec.ts --project=chromium --grep DE2E-ORD-020
1 passed

git diff --check
PASS
```

该增量已完成本地 API、数据库和 Chromium 候选门禁；原 Story 的真实 Dashboard 九陪玩视觉 UAT 仍是外部项，因此 `M10-US-03` 继续保持未勾选。
