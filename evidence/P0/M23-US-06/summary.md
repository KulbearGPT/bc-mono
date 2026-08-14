# M23-US-06 验证证据

## Story 与范围

- Story：`M23-US-06`
- 实施包：`NUI-A5`
- 范围：订单来源消费、陪玩收益、返佣、Adjustment、保密和财务时间线，共 9 个 BNUI-FIN/REF/HIS 场景。
- 实施策略：复用生产同源 API、PostgreSQL 和时间线测试，补足真实数据库竞态及退款 Adjustment 断言；礼物来源只由 M22 专项门禁提供兼容证据，不复制礼物业务动作。
- 非范围：周报和结算由 NUI-A6 实施；真实 Discord 私密展示和下载响应扫描保留外部验收。

## 基线与强化验证

- A5 新增领域源初始基线为 `8 files / 34 tests` 全部通过，没有发现需要修改生产逻辑的运行时缺陷。
- 新增真实 PostgreSQL 双来源绑定竞态：PROMOTER_FIRST_PURCHASE 与 PLAYER_LIFETIME 同时绑定同一用户，最终一项成功、一项失败，数据库只保留一个 ACTIVE 归因且无半成品。
- 强化退款事务测试：原订单消费、120000 CAT 原收益和 4000 CAT 原 Commission 保持不变；50100 CAT 部分退款追加消费冲正、30060 CAT PlayerEarningAdjustment 和 1002 CAT CommissionAdjustment，二者关联同一 refund。审计提交失败时审批、退款、钱包和三类 Adjustment 全部零写入。
- 收益确认和线下支付登记的同幂等键响应重放返回相同结果，状态只推进一次，原始收益金额不变。

## GREEN 与门禁

- `npm run test:non-ui:a5`：累计 `40 files / 242 tests`，最终版本连续三轮通过。
- `npm run generate:non-ui:coverage`：`77 total / 56 automated / 21 planned`。
- 覆盖完整性测试逐条确认 AUTOMATED source 文件和测试名称存在，且没有 `skip/todo`。
- `npm run test:gift:non-ui`：`18 files / 99 tests`；`npm test`：`309 files / 1555 tests`，全部通过。
- `npm run db:validate`、`npm run quality:routes`、`npm run lint:api`、`npm run typecheck`：Prisma 有效、192 个生产 operation 与 OpenAPI 一致、API ESLint 零警告、类型通过。
- `node scripts/build-p0-acceptance-matrix.mjs` 重建 317 行验收矩阵；格式、镜像、`git diff --check` 和残留 PostgreSQL 进程/目录检查通过。

## 场景与核心验收映射

- `BNUI-FIN-001`～`003`：`AT-EAR-001;002;003`、`AT-MULTI-004`、`AT-COMP-002`、`AT-REF-001`。
- `BNUI-REF-001`～`004`：`AT-REF-001`～`005`、`AT-RFP-001;002;003;004;008`。
- `BNUI-REF-005`：`AT-HIS-002`、`AT-RFP-005;006;007`、`AT-TML-002`。
- `BNUI-HIS-001`：`AT-HIS-001`、`AT-TML-001`。
- 精确逐场景映射及 executable source 见 `evidence/P0/non-ui-automation/coverage.json`。

## 关键事实

- 订单完成按参与明细快照生成唯一消费和逐人 PENDING 收益，捕获后参与明细不可修改；目录或分成后续变化不追改历史。
- 收益仅由 L3+ 在近期 step-up 和原因存在时确认或登记外部支付；重放不重复推进，不覆盖原始金额。
- 退款和纠错只追加 Consumption、PlayerEarningAdjustment、CommissionAdjustment；Adjustment 金额非负，由 type 表示方向，主记录不可覆盖或删除。
- 一名被推荐用户只有一个有效来源；自荐、重复、首笔消费后绑定和跨 Guild 探测均失败关闭。
- 固定额保持配置整数，basis points 使用向下取整；首购只结算一次，PLAYER_LIFETIME 对每个符合条件订单来源最多生成一条 Commission，重放不重复。
- 被推荐用户 API 不返回关系、受益人、比例、金额或状态；受益人只见本人脱敏来源，L1/L2/L3 时间线按职责裁剪。
- 消费和统一时间线使用稳定 cursor，主记录与 Adjustment 分开呈现，方向和来源可追溯且无重复。

## 共用 Harness 收敛

- `tests/m3-us-04-db.spec.ts`
- `tests/m3-us-05-db.spec.ts`
- `tests/m3-us-07-db.spec.ts`

以上历史测试已迁入 `startIsolatedPostgres`，使用 Unix socket、当前全部 migration、安全目标守卫和可靠 stop，不再吞掉清理错误。

## 修改文件

- `tests/api-review-refund-integrity-db.spec.ts`
- `tests/m3-us-04-api.spec.ts`
- `tests/m3-us-04-db.spec.ts`
- `tests/m3-us-05-db.spec.ts`
- `tests/m3-us-07-api.spec.ts`
- `tests/m3-us-07-db.spec.ts`
- 非 UI 覆盖、累计门禁、机器报告、Backlog、TODO 和验收矩阵。

## 剩余风险

- 真实 Discord ephemeral、公共频道零泄露和可下载响应仍需外部 Guild UAT；`BNUI-REF-005` 保持 `AUTOMATED_PARTIAL_EXTERNAL_REMAINS`。
- NUI-A6～A8 尚未实施，剩余 21 个 BNUI 场景保持 `PLANNED`。
