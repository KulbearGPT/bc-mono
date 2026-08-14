# API 全量审查：FundReservation 剩余预留统一口径

日期：2026-08-13

## 审查结论

FundReservation 的 `PARTIALLY_SETTLED` 状态此前存在两套计算口径：余额、客户档案和运营指标会从原始预留金额扣除 `CAPTURED`、`RELEASED`、`EXPIRED` 追加事件，但订单提交、礼物提交和账户聚合仍把原始 `amount_minor` 全额计入。结果不会造成超支，却会把已结算部分继续冻结，错误拒绝本来余额充足的新订单或礼物，并令不同 API 对同一客户返回不一致的 `reservedMinor` / `availableMinor`。

本候选在不修改 Bot 或 Dashboard 源码和公开请求/响应合同的前提下完成以下修复：

- 新增 API 领域模块 `reservation-balance.ts`，集中定义有效预留状态、剩余金额纯函数以及参数化 PostgreSQL 片段。剩余金额统一为 `max(amount_minor - captured/released/expired, 0)`，损坏数据的超额结算不会生成负预留。
- 订单提交和礼物批量提交在钱包并发锁边界内按剩余预留重算可用余额；不能再因旧的部分结算金额被重复占用而误报余额不足。
- 当前账户、钱包摘要、客户 Profile、运营指标和订单参与者调价全部复用同一领域定义；客户 Profile 的有效预留数量不再把剩余为零的异常活动行计入。
- 内存订单/账户实现与 PostgreSQL 使用同一计算语义，保留现有导出、URL、DTO 和状态机兼容性。
- PostgreSQL 用例覆盖订单提交、九人礼物批量预留、账户聚合和运营指标：旧预留 10,000、已捕获 3,000 时只占用 7,000；礼物用例同时证明按原始金额计算会拒绝、按剩余金额计算可以原子成功。

## 验收与风险边界

- 关联验收：`AT-PL-002`、`AT-RES-002`、`AT-RES-003`、`AT-RES-007`、`AT-RES-011`、`AT-MET-006`、`AT-PRF-006`、`AT-MULTI-002`、`AT-MULTI-005`。
- 金额仍使用 CAT subunit 安全整数；本次没有新增第二账本、客户端余额计算或第三方支付依赖。
- FundReservation 与事件继续 append-only；本次只修正读取和并发提交时的聚合方式，不回写或删除历史事实。

## 变更文件

- `apps/api/src/reservation-balance.ts`
- `apps/api/src/orders.ts`
- `apps/api/src/gifts.ts`
- `apps/api/src/accounts.ts`
- `apps/api/src/wallet.ts`
- `apps/api/src/customer-profiles.ts`
- `apps/api/src/dashboard-metrics.ts`
- `apps/api/src/order-participants.ts`
- `apps/api/package.json`
- `tests/api-review-reservation-aggregation.spec.ts`
- `tests/m1-us-03-db.spec.ts`
- `tests/m4-us-09-db.spec.ts`
- `tests/m10-us-05-postgres.spec.ts`

## 可复核证据

- 未通过基线：`tests/api-review-reservation-aggregation.spec.ts` 首次运行因 `@blackcat/api/reservation-balance` 模块不存在而失败（1 suite failed / 0 tests），证明统一领域口径尚未实现。
- `npm run typecheck -w @blackcat/api`：通过。
- 订单、礼物、钱包、客户 Profile、运营指标、账户及参与者 PostgreSQL 聚焦回归：9 files / 36 tests，通过。
- `npm run build`：通过。
- `npx eslint apps/api/src --max-warnings 40`：0 errors；27 个均为既有 warning，本次未增加 warning。
- `git diff --check`：通过。

## 剩余外部风险

自动化使用临时真实 PostgreSQL 覆盖了事务和 SQL 执行，但不能替代真实 Guild 中订单与礼物并发操作的具名 UAT。该外部状态未被描述为已完成。
