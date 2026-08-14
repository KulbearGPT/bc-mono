# M12-US-02 客服打卡与简单汇总

- 状态：本地实现完成；真实员工 Dashboard UAT 仍待外部执行。
- 验收：AT-SUP-010、AT-SUP-013。
- RED：`npx vitest run tests/m12-us-02-api.spec.ts tests/m12-us-02-dashboard.spec.ts tests/m12-us-02-db.spec.ts` → API 模块缺失，Dashboard 与迁移合同失败。
- GREEN：M12-US-02 API、Dashboard、静态数据库与真实 PostgreSQL测试共 4 files / 8 tests passed。
- 工程门禁：`npm run typecheck`、`npm run db:validate` 与 `npm run build -w @blackcat/dashboard` 均通过。
- 最终聚焦回归：M12-US-01/02 合计 5 files / 12 tests passed；`git diff --check` 通过。
- 迁移门禁：`npm run db:verify:migration` 从 000001 至 000030 全链通过，`migration-apply-ok`，table_count=87。

## 实现摘要

- L1/L2 可幂等上班、下班；同一 Guild/员工仅有一个活动班次。
- 本人存在 `CLAIMED` 订单级任务时拒绝下班；打卡不影响任务查看、认领或首响权限。
- L1 汇总仅本人；L2+ 按可信 Guild scope 查看 ACTIVE L1–L4 员工最近 30 天的班次、认领、超时与评分事实。
- Dashboard 只提供简单打卡和列表，不包含排班、薪资、补签、加班、积分或 CSV。
- 000030 同时建立后续首响和评分所需的数据事实，但本 Story 不声称 M12-US-03/04 的运行时行为已经实现。

## 修改文件

- `apps/api/src/support-operations.ts`、API server/entrypoint/package exports
- `apps/dashboard/src/SupportWorkbenchPage.tsx`
- `database/prisma/schema.prisma`
- `database/prisma/migrations/000031_m12_support_operations/migration.sql`
- M12-US-02 测试、双 TODO、双 backlog 和本证据

## 剩余风险

- AT-SUP-010/013 仍需真实员工 Dashboard 视觉和操作 UAT。
- 超时、Discord 首响自动认领及评分写入分别属于 M12-US-03/04，尚未启用。
