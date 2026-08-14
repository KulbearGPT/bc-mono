# M23-US-02 验证证据

## Story 与范围

- Story：`M23-US-02`
- 实施包：`NUI-A1`
- 范围：账户、Discord 入驻、本人 Profile/订单分页、CAT 钱包、USD receipt 充值、渠道退款、并发/幂等与 Provider/Webhook 退役，共 9 个 BNUI 场景。
- 非范围：真实 Discord ephemeral、Dashboard 上传交互、Railway 外部环境签署；这些在覆盖报告中保持 `AUTOMATED_PARTIAL_EXTERNAL_REMAINS`。

## 合同冲突与 RED

1. 主规格 M9、AGENTS、OpenAPI、Prisma 与运行时已经固定内部 CAT 钱包、`1 USD cent = 1 CAT subunit` 和 L2+ 充值；验收、交互、业务配置和历史 M7/M8 说明仍残留内部 USD、可配置代币及 L1 充值语义。根据事实来源优先级，先停止运行时实现并修正全部当前交付镜像。
2. `tests/non-ui/account-wallet-contract.spec.ts` 首轮：`4 tests / 3 failed`，分别暴露旧钱包币种、权限和 fixture 语义。
3. 合同组首轮：`4 files / 16 tests` 中 `1 failed`，旧 `m7-us-01-contract` 仍强制内部 USD 文案。
4. A1 运行时首轮：`1 file / 9 tests` 中 `3 failed / 6 passed`；两项为测试订单不满足当前 active-slot 数据库约束，一项为并发扣减合法返回 `422 INSUFFICIENT_AVAILABLE_BALANCE` 而非预设 `409`。修正 fixture 与允许的竞争失败分支，没有放宽资金不变量。
5. 加强验证后再次 RED：非法/低权限尝试的审计实际按前置拒绝记 `REJECTED`、按 handler 验证失败记 `FAILED`；append-only 触发器错误文案为 `append-only`。断言改为核对四次尝试的精确 outcome 分布和实际数据库护栏。

## GREEN

- `npm run test:non-ui:a1`：`3 files / 25 tests` 通过。
- A1 PostgreSQL 场景最终版本连续三轮：每轮 `1 file / 9 tests` 通过。
- 账户、Profile、M7/M8/M9 钱包与入驻、M22 礼物资金关联回归：`15 files / 60 tests` 通过。
- `npm run test:gift:non-ui`：`18 files / 99 tests` 通过。
- `npm test`：`307 files / 1544 tests` 通过。
- `npm run typecheck`：通过。
- `npm run db:validate`：Prisma schema 有效。
- `npm run quality:routes`：192 个生产 operation 与 OpenAPI 双向一致。
- 新增/修改测试与脚本 ESLint `--max-warnings 0`、Prettier 检查：通过。
- `node scripts/build-p0-acceptance-matrix.mjs`：重建 317 行验收矩阵。
- 15 组 `outputs/` 与 `docs/` 当前交付合同逐字节一致。
- `npm run generate:non-ui:coverage`：`77 total / 9 automated / 68 planned`。
- `npm run verify:non-ui:environment`：PostgreSQL `initdb`、`pg_ctl`、`createdb`、`psql` 全部可用。
- 残留检查：A1 与修复后的 M10 测试均无 `blackcat-non-ui-*` 临时目录或 PostgreSQL 进程。

## 场景与验收映射

- `BNUI-ACC-001`：`AT-ACC-001;003`、`AT-ONB-001;006`。
- `BNUI-ACC-002`：`AT-ONB-002;006`。
- `BNUI-ACC-003`：`AT-ACC-002;004`、`AT-PRF-002;004;006`。
- `BNUI-WLT-001`：`AT-PL-002`、`AT-WAL-001`、`AT-PRF-006`。
- `BNUI-WLT-002`：`AT-WAL-003;005;006;007`、`AT-WLT-011`。
- `BNUI-WLT-003`：`AT-WAL-004`、`AT-WLT-012;013`。
- `BNUI-WLT-004`：`AT-WAL-002;008;009`、`AT-CAT-004`。
- `BNUI-WLT-005`：`AT-PL-002`、`AT-WAL-006`。
- `BNUI-WLT-006`：`AT-WAL-010`、`AT-WHK-001;002;003`、`AT-CAT-005`。

## 关键事实

- 注册与陪玩申请从可信 Discord Actor Context 解析 Guild、用户和 interaction；客户端伪造归属字段不参与事实写入。
- 余额由真实 PostgreSQL 同一账本口径计算：`availableMinor = ledgerBalanceMinor - reservedMinor`，订单与礼物活动预留共同占用可用额。
- 人工充值最低 L2 且要求近期验证；USD 只作为 receipt 付款证据，入账固定为 CAT subunit；相同付款方式和 receipt 只能成功一次。
- 失败、权限、step-up、非法币种/金额及余额不足路径均验证业务零写入，同时保留审计尝试。
- 渠道退款只追加 debit；历史 WalletEntry、TopUp、ExternalRefundDebit 的 UPDATE/DELETE 由数据库拒绝。
- 响应丢失后原幂等键返回首次结果；并发扣减只有一笔成功，另一笔按锁竞争时点返回 409 或余额不足 422，余额始终非负。
- 旧支付 Webhook/Provider 路由返回 404，且不能创建钱包业务事实。

## 全局缺陷修复

- 全仓门禁后的进程检查发现一份历史 `m10-us-04-postgres` 临时 PostgreSQL 实例仍在运行；旧测试吞掉 pool/stop 错误并直接删除目录，无法保证清理成功。
- `tests/m10-us-04-postgres.spec.ts` 已迁移到共用 `startIsolatedPostgres`，停止错误不再静默，停止后验证进程并安全清理。旧实例已明确停止；修复后专项 `1 file / 3 tests` 通过且无进程残留。

## 修改文件

- 当前 CAT 合同：交互原型/映射/文案、API 使用说明、数据约束、支付边界、业务配置、Backlog、验收、fixture、包索引及 `docs/` 镜像。
- `tests/non-ui/account-wallet-contract.spec.ts`
- `tests/non-ui/account-wallet.spec.ts`
- `tests/support/non-ui-coverage.ts`
- `tests/non-ui/nui-a0-harness.spec.ts`
- `scripts/non-ui/build-coverage-report.ts`
- `scripts/non-ui/run-domain-gate.mjs`
- `tests/m10-us-04-postgres.spec.ts`
- `package.json`
- Backlog、TODO、验收矩阵与机器覆盖报告。

## 剩余风险

- 真实 Discord ephemeral、Dashboard receipt 附件交互和 Railway 启动仍由外部/UAT 门禁签署；自动化报告未将其伪装成完全自动化。
- A2～A8 尚未实施，剩余 68 个 BNUI 场景保持 `PLANNED`。
- 订单完成捕获的 response-loss 与订单×礼物跨来源并发保留给 `M23-US-04 / NUI-A3`，不以本 Story 的钱包级重放代替。
