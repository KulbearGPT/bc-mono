# M23-US-04 验证证据

## Story 与范围

- Story：`M23-US-04`
- 实施包：`NUI-A3`
- 范围：下单、结构化需求、套餐应用、报价、订单预留、候选池、Reaction 报名、终选、逐名就绪、服务完成和超时风险，共 18 个 BNUI 场景。
- 实施策略：遵循总计划“优先复用和参数化现有测试”，将分散的生产同源 API、PostgreSQL、Worker 和 fake Discord transport 测试纳入一个累计门禁；仅为缺失的跨业务真实并发新增场景。
- 非范围：真实 Discord 权限/移动体验、Dashboard 视觉和取消/退款/改派；分别保留外部验收或交由 NUI-A4。

## RED 与全局缺陷修复

1. 新增 `BNUI-ORD-004` 可控竞态：测试触发器使订单事务在持有钱包行和用户币种锁后暂停，再启动礼物预留，使两个事务都在对方提交前读取余额事实。
2. 修复前 `1 test / 1 failed`：订单和礼物两个事务均 `fulfilled`，同一 5200 CAT 余额形成两笔 5200 活动预留，证明二者未共享同一并发边界。
3. 根因：订单提交锁定 `user_currency_locks` 和钱包行，礼物创建只使用礼物 advisory key 与钱包行；特定交错下礼物可在等待钱包锁前读取陈旧活动预留。
4. 修复：`PostgresGiftStore.commitCreateBatch` 在任何余额/预留读取前创建并 `FOR UPDATE` 同一 `(userId,currency)` 锁行。订单与礼物现在共享确定的锁顺序；竞态 GREEN 为仅一项成功、一条活动预留、`availableMinor=0`。

## GREEN 与门禁

- `npm run test:non-ui:a3`：累计 `19 files / 155 tests`，最终版本连续三轮通过。
- `npm run test:gift:non-ui`：`18 files / 99 tests` 通过。
- 订单×礼物修复专项及礼物创建/多收件人回归：`3 files / 7 tests` 通过。
- `npm test`：`309 files / 1554 tests` 通过。
- `npm run generate:non-ui:coverage`：`77 total / 35 automated / 42 planned`。
- 覆盖完整性测试逐条读取 AUTOMATED source，验证文件和测试名称存在且没有 `skip/todo`。
- `npm run db:validate`、`npm run quality:routes`、`npm run lint:api`、`npm run typecheck`：Prisma 有效、192 个生产 operation 与 OpenAPI 一致、API ESLint 零警告、类型通过；新增测试/覆盖脚本 Prettier 通过。
- `node scripts/build-p0-acceptance-matrix.mjs`：重建 317 行验收矩阵；全量测试后无隔离 PostgreSQL 进程或目录残留。

## 场景与核心验收映射

- `BNUI-ORD-001`～`008`：`AT-CAT-002;003`、`AT-CHN-001;003`、`AT-ORD-001`～`004`、`AT-PL-001`、`AT-RES-001;003`、`AT-REV-004`、`AT-PRJ-001`、`AT-MULTI-006;008;009;011;013`。
- `BNUI-SEL-001`～`005`：`AT-DSP-001`～`004`、`AT-DSP-011;012;014;015;016;019;020`、`AT-SEL-001`～`008`（当前相关子集）、`AT-MULTI-007`。
- `BNUI-RDY-001`～`003`：`AT-RDY-001;002;003;005`、`AT-SVC-001`、`AT-MULTI-003`、`AT-STATE-001`。
- `BNUI-SVC-001`～`002`：`AT-SVC-002;003;004`、`AT-RDY-004`、`AT-MULTI-004`。
- 精确逐场景映射及 executable source 见 `evidence/P0/non-ui-automation/coverage.json`。

## 关键事实

- 多项目和套餐需求以独立有序行保存，金额由 API/Store 根据目录快照派生；跨游戏改写、十项目和审计失败均零部分写入。
- 订单提交原子重验目录、版本、账本与活动预留；同一订单只有一份有效原预留，订单与礼物跨来源也不能超支。
- 候选池无倒计时；报名不占活动订单槽，客户终选时才锁行重验。零报名、部分入选和重开下一轮均由客户明确决定。
- Reaction 映射只支持一至九个需求并可在遗漏事件/重启后从数据库收敛；fake Discord transport 验证不限人数语音房、移动顺序、撤权、清理和失败恢复。
- 客户 readiness 被拒绝；只有当前有效陪玩可写本人就绪，最后一名才使订单一次进入 `IN_SERVICE`。
- 完成捕获使用原订单预留并生成逐人收益；未就绪新增参与人会阻止捕获。完成/就绪超时只创建风险或客服事实，不自动捕获、退款、扣罚或结算。

## 共用 Harness 收敛

- `tests/m1-us-03-db.spec.ts`
- `tests/m10-us-08-service-packages-postgres.spec.ts`
- `tests/m11-us-02-selection-pools-postgres.spec.ts`

以上历史测试已迁移到 `startIsolatedPostgres`：使用 Unix socket、当前全部 migration、失败关闭安全守卫和可靠 stop，不再吞掉 pool/pg_ctl 清理错误。

## 修改文件

- `apps/api/src/gifts.ts`
- `tests/non-ui/order-gift-concurrency.spec.ts`
- 三份历史 PostgreSQL 测试的共用 Harness 迁移。
- `tests/support/non-ui-coverage.ts`
- `tests/non-ui/nui-a0-harness.spec.ts`
- `scripts/non-ui/build-coverage-report.ts`
- `scripts/non-ui/run-domain-gate.mjs`
- `package.json`
- Backlog、TODO、验收矩阵与机器覆盖报告。

## 剩余风险

- 真实 Discord 频道权限、通知可见性、语音移动与 Desktop/Mobile 体验仍需外部 Guild UAT；标为 partial 的场景没有被伪装为完全自动化。
- 取消、退款、争议结案、改派和客服接管由 `M23-US-05 / NUI-A4` 顺序实施。
- NUI-A4～A8 尚未实施，剩余 42 个 BNUI 场景保持 `PLANNED`。
