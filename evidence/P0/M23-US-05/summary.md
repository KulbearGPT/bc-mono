# M23-US-05 验证证据

## Story 与范围

- Story：`M23-US-05`
- 实施包：`NUI-A4`
- 范围：取消、退款、订单明细改派、客服接管和审批竞态，共 12 个 BNUI-CXL/ORD/SUP/APR 场景。
- 实施策略：遵循总计划“优先复用和参数化现有测试”，将生产同源 API、PostgreSQL、Worker 和只读 transcript 测试纳入累计门禁；不复制业务规则。
- 非范围：Dashboard 视觉、真实 Discord 权限和移动体验保留外部验收；消费、收益和返佣由 NUI-A5 实施。

## 基线与 Harness 收敛

- 初始 `npm run test:non-ui:a4` 为 `32 files / 207 tests` 全部通过，未发现需要修改生产逻辑的运行时缺陷。
- `tests/m2-us-05-db.spec.ts`、`tests/m2-us-10-db.spec.ts`、`tests/m10-us-03-postgres.spec.ts`、`tests/m12-us-03-postgres.spec.ts`、`tests/api-review-refund-integrity-db.spec.ts` 已迁入 `startIsolatedPostgres`。
- 上述测试现在只使用受控 Unix socket、随机数据库名、当前完整 migration 和失败关闭的可靠 stop；不再吞掉 pool、pg_ctl 或目录清理错误。迁移专项 `5 files / 19 tests` 通过。

## GREEN 与门禁

- `npm run test:non-ui:a4`：累计 `32 files / 207 tests`，最终版本连续三轮通过。
- `npm run test:gift:non-ui`：`18 files / 99 tests` 通过。
- `npm run generate:non-ui:coverage`：`77 total / 47 automated / 30 planned`。
- 覆盖完整性测试逐条确认 AUTOMATED source 文件和测试名称存在，且没有 `skip/todo`。
- `npm run db:validate`、`npm run quality:routes`、`npm run lint:api`、`npm run typecheck`：Prisma 有效、192 个生产 operation 与 OpenAPI 一致、API ESLint 零警告、类型通过。
- `node scripts/build-p0-acceptance-matrix.mjs`：重建 317 行验收矩阵；`npm test`：`309 files / 1554 tests` 通过。
- A4 新增/覆盖基础设施文件 Prettier、`git diff --check`、Backlog/TODO 镜像和残留 PostgreSQL 进程/目录检查均通过。

## 场景与核心验收映射

- `BNUI-CXL-001`～`003`：`AT-CXL-001`～`004`、`AT-CAN-001;002;003;004;007;008;009`、`AT-SUP-003`。
- `BNUI-ORD-009`：`AT-MULTI-010;015`。
- `BNUI-SUP-001`～`006`：`AT-SUP-001;002;005;006;010;011;013`、`AT-RBAC-001;002`、`AT-DOP-002`、`AT-SUX-002;003;004`。
- `BNUI-APR-001`～`002`：`AT-RBAC-003;004;005;006;011`、`AT-AUD-001;005`。
- 精确逐场景映射及 executable source 见 `evidence/P0/non-ui-automation/coverage.json`。

## 关键事实

- 取消预览只读且绑定订单版本；陈旧 token 零写入，合法确认在同一事务取消订单、释放原预留并终止相关候选池事实。
- 完成后退款按不可变快照和已捕获金额限制；并发不同幂等键不能超额入账，审计追加失败会回滚审批决定、退款、钱包和领域事实。
- 改派只变更指定参与明细，其他明细、订单总额和预留保持不变；终态恢复写入被拒绝，员工备注纠错不改变资金。
- 客服认领在真实 PostgreSQL 中串行为唯一 owner；L1 只能处理本人任务，暂停不会修改资金，Worker 在暂停时不推进生命周期。
- 首响竞态、值班和汇总按服务端身份/Guild 收敛；transcript 只读且游标稳定，跨 Guild 上下文不会生成可见链接。
- 审批只决定服务端不可变快照；过期、陈旧、跨 Guild 或权限/step-up 不满足时失败关闭，直达业务入口会明确取消兼容的待审批快照而不重复资金动作。

## 修改文件

- 5 份历史 PostgreSQL 测试的共用 Harness 迁移。
- `tests/support/non-ui-coverage.ts`
- `tests/non-ui/nui-a0-harness.spec.ts`
- `scripts/non-ui/build-coverage-report.ts`
- `scripts/non-ui/run-domain-gate.mjs`
- `package.json`
- Backlog、TODO、验收矩阵与机器覆盖报告。

## 剩余风险

- 真实 Discord 频道权限、通知可见性和 Desktop/Mobile 体验仍需外部 Guild UAT；标为 partial 的场景没有被描述为完全自动化。
- NUI-A5～A8 尚未实施，剩余 30 个 BNUI 场景保持 `PLANNED`。
