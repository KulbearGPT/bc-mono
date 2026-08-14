# M2-US-06 Evidence: 人工退款、结案与转派的原子用例

## Scope

- Story：M2-US-06 人工退款、结案与转派的原子用例
- 验收用例：AT-CAN-006、AT-CAN-009、AT-RBAC-004
- 前置依赖：M0-US-03、M0-US-04、M2-US-05

## Implemented

- 实现 `refundOrder`、`resolveOrder`、`reassignOrder` 及统一安全路由，L1 拒绝，L2 可直接执行不超过 50000 minor 的退款，L3/L4 金额边界和近期 step-up 由 API 强制执行。
- 金额超出当前操作者等级时只追加 `approval_requests` 和审计，Provider 不执行；符合等级的同一操作者可直接执行，不强制双人复核。
- Provider 退款使用稳定幂等键；`UNKNOWN`/`PENDING` 通过 `getTransaction(IDEMPOTENCY_KEY)` 收敛，未确认成功不写本地退款事实。
- Provider 已成功但本地事务提交失败时，指定财务路由允许使用同一请求幂等键重新执行；Provider 幂等返回原交易，本地事务恢复落账，不重复退款。
- 已完成订单售后退款只追加 refund、消费冲正、PlayerEarningAdjustment、CommissionAdjustment 和审计，不回退或覆盖原订单、消费、收益与返佣事实。
- 人工结案原子写入订单终态、resolution、资金处理、收益/返佣调整、风险事件、订单事件和成功审计；任一写入失败全部回滚。
- 对尚未扣款的有效订单预留，结案按决议捕获保留金额并释放剩余金额；Provider native hold 与 local fallback 均使用原 reservation 和稳定幂等键，数据库追加对应 reservation events、订单扣款和消费。
- 部分结案的外部交易镜像允许金额小于等于原预留，同时继续拒绝错用户、错来源、错币种和超额交易。
- 转派仅允许 `ACCEPTED` 或已进入 `EXCEPTION` 的订单；服务中订单必须先停止原服务并进入异常。替换陪玩须满足 ACTIVE、AVAILABLE、在线、游戏/服务标签匹配且无其他活跃订单。

## Verification

- RED：
  - Provider 成功、本地 Adjustment 写入失败后，以同一幂等键重试固定重放 `COMMIT_FAILED` 500。
  - 活跃预留的部分结案因要求既有 `ORDER_CHARGE` 返回 422，无法捕获/释放预留。
  - `IN_SERVICE` 订单可直接转派并继承原陪玩的服务状态。
- GREEN：
  - `npx vitest run tests/m2-us-05-api.spec.ts tests/m2-us-05-db.spec.ts tests/m2-us-06-api.spec.ts tests/m2-us-06-db.spec.ts`
  - 结果：4 files / 33 tests passed。
- 全局验证：
  - `npm test`：39 files / 234 tests passed。
  - `npm run typecheck`：exit 0。
  - `npm run db:validate`：Prisma schema valid。
  - `npm run db:verify:migration`：migration-apply-ok；table_count=47；constraint_count=3；trigger_count=7。

## Residual Risk

- Dashboard 正式会话、CSRF、持久 idempotency/audit sink 和可用的 MFA/step-up 会话由 M4 安全 Story 完成；当前 L3/L4 路由在未注入 verifier 时按 fail-closed 返回 428。
- Discord credential 暂未提供，真实测试 Guild 与真实 Provider 沙箱 E2E 未执行。
- 转派后的 Discord 私密频道权限同步、客服暂停/恢复和工作台一致性在 M2-US-11 中完成；当前 API 已阻止服务中直接换人。
