# M6-US-03 周期周报与通知证据

日期：2026-07-19

## 交付范围

- 共享 API 生成并读取 Guild/CNY 范围内的陪玩个人周报与店铺汇总周报。
- PostgreSQL 在同一事务中生成全部个人报告、汇总报告及通知 Outbox；周期任务重放按范围键幂等。
- 周报区分 `pendingMinor`、`settlementReadyMinor` 与实际结算 Entry 的 `batchedMinor`，异常标记 `NEEDS_REVIEW`。
- L2 可读取和导出；L3 在近期 step-up 后可追加修订。基础快照和旧修订不可改写或删除。
- Bot 自查 API 只按可信 Actor Context 返回本人报告；跨陪玩读取与不存在报告使用相同 404。
- Discord 私信失败只重试通知 Outbox，不重放报告或结算业务写入。

## 验收追踪

| 验收 | 自动证据 |
|---|---|
| AT-RPT-001 | `tests/m6-us-03.spec.ts`、`tests/m6-us-03-db.spec.ts`：个人+汇总原子幂等生成、待确认/可结算/实际归批口径、CNY 与 Guild scope。 |
| AT-RPT-002 | `tests/m6-us-03-api.spec.ts`：本人列表、跨陪玩统一 404、不泄露存在性。 |
| AT-RPT-006 | `tests/m6-us-03-worker.spec.ts`：通知失败可重试，报告生成不重放。 |
| AT-RPT-007 | `tests/m6-us-03-api.spec.ts`：当前修订导出 UTF-8 BOM、RFC 4180 CRLF CSV。 |
| AT-RPT-008 | `tests/m6-us-03-api.spec.ts`、`tests/m6-us-03-db.spec.ts`：L3、step-up、原因、幂等、乐观版本、事务审计和追加式修订。 |

## 执行结果

```text
npx vitest run tests/m6-us-03.spec.ts tests/m6-us-03-api.spec.ts tests/m6-us-03-db.spec.ts tests/m6-us-03-worker.spec.ts
Test Files  4 passed (4)
Tests       15 passed (15)

npm run typecheck
exit 0

npm run db:validate
The schema at database/prisma/schema.prisma is valid

npm run db:verify:migration
migration-apply-ok
table_count=58
settlement_table_count=4
settlement_guard_count=9
weekly_report_table_count=3
weekly_report_guard_count=5
weekly_report_scope_constraint_count=3
```

## 迁移与边界

- US03 仅新增 `database/prisma/migrations/000004_m6_weekly_reports/migration.sql`；未修改已应用的 `000002` 或 `000003`。
- Dashboard 与 Discord UI 属于 M6-US-04/05，本 Story 未实现或修改这些客户端界面。
- 实际转账仍由外部平台完成；周报仅呈现自有系统的业务与结算快照。

## 独立审查修复（2026-07-19）

- Dashboard session 的 Guild scope 改由服务端业务配置注入，忽略浏览器 `x-actor-guild-id`；真实 session 用例通过。
- `settlementReadyMinor` 排除已进入未作废批次的 CONFIRMED 收益，`batchedMinor` 继续单列实际 Entry 金额。
- 本周期对旧收益新增的 Adjustment 以独立事实进入周报；未归批负调整计入待抵扣，不重复计算旧订单活动。
- 新增 `000005_m6_weekly_report_review_fixes`，持久化 revision request fingerprint；同键异参冲突，相同请求回放数据库当前投影。
- generation replay 按完整周期范围加载，不再通过列表接口的 100 条上限；102 名活跃陪玩回放一致。
- 服务结束早于开始时记录 `INVALID_SERVICE_BOUNDARY_ORDER` 并标记 `NEEDS_REVIEW`，时长仍安全投影为 0。

复验结果：US03 `4 files / 21 tests`，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 全部通过；迁移探针为 `weekly_report_scope_constraint_count=4`。
