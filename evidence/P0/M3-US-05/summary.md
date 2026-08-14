# M3-US-05 Evidence: 统一消费历史与本人返佣视图

## Scope

- Story：M3-US-05 统一消费历史与本人返佣视图
- 验收用例：AT-HIS-001、AT-RFP-005、AT-RFP-006、AT-RFP-008
- 前置依赖：M3-US-03、M3-US-04

## Implemented

- `/api/v1/me/consumptions` 按认证 Discord 绑定派生用户，统一返回订单、礼物和退款冲正时间线，并以 `occurredAt + id` 提供稳定游标分页。
- `/api/v1/me/commissions` 仅按 `beneficiary_user_id=current_user` 查询；来源展示固定脱敏，不返回来源客户 ID、受益人 ID、归因 ID、规则比例或推荐关系。
- 本人返佣的原始金额保持不变，净额和 summary 由只追加的 `CommissionAdjustment` 计算并限制为非负。
- 新增可供 Dashboard 与 Discord Bot 复用的返佣管理 API。完整记录只允许 L3+ 使用 `commission.read` 读取。
- 返佣确认、标记发放和冲正使用 `commission.manage`，强制近期 step-up、操作原因、乐观版本和幂等键。
- 状态仅允许 `PENDING -> CONFIRMED -> PAID`；退款或纠错只追加非负调整，不覆盖或删除原主记录和归因快照。

## Verification

- RED：本人历史接口仅返回占位空数组；返佣管理模块不存在；严格 UUID version 校验错误拒绝合法测试游标。
- GREEN：`pnpm vitest run tests/m3-us-05-api.spec.ts tests/m3-us-05-commissions-api.spec.ts tests/m3-us-05-db.spec.ts`，3 files / 9 tests passed。
- `pnpm typecheck`：exit 0。
- `pnpm test`：68 files / 318 tests passed。
- `pnpm db:validate`：Prisma schema valid。
- `pnpm db:verify:migration`：migration-apply-ok；table_count=47；constraint_count=3；trigger_count=7。
- `git diff --check`：exit 0。

## Residual Risk

- Dashboard 正式会话、CSRF 和持久化 MFA/step-up 会话由 M4 安全 Story 完成；当前受保护写路由在未注入 verifier 时 fail closed。
- Discord credential 与真实支付 Provider 沙箱尚未提供，因此测试 Guild 和真实返佣通知 E2E 尚未执行。
- 本 Story 不实现多级返佣、自动发放或向被推荐客户公开返佣去向；两类返佣计划的完整归因管理由 M3-US-07 完成。
