# M2-US-05 Evidence: 默认自动取消与异常客服任务

## Scope

- Story：M2-US-05 默认自动取消与异常客服任务
- 验收用例：AT-CAN-001、AT-CAN-004、AT-SUP-001
- 前置依赖：M1-US-05、M2-US-03、M2-US-04、M0-US-05

## Implemented

- `cancelOrder` 对已接单/服务中/待确认订单不自动取消、不释放预留、不退款，而是创建唯一 active `CANCELLATION_ASSIST` 客服任务并返回 `staffTaskId`。
- `createOrderStaffTask` 支持 P0 异常订单类型：`PLAYER_START_LATE`、`PLAYER_NO_SHOW`、`CUSTOMER_NO_SHOW`、`SERVICE_INTERRUPTED`、`COMPLETION_REVIEW`、`AUTOMATION_FAILURE`。
- 新增 `risk-events` API 模块：`createUserRiskFlag`、`InMemoryRiskEventStore`、`PostgresRiskEventStore`、`registerRiskEventRoutes`。
- `POST /api/v1/admin/users/:userId/risk-events` 通过统一安全中间件、`user.risk.manage` 权限、幂等和审计追加风险事件，不改变用户状态。
- Bot 新增取消结果渲染，`staffTaskId` 存在且订单未取消时显示“取消申请已转客服”，不误显示“订单已取消”。
- Bot lifecycle 面板在 `EXCEPTION` 或存在 `staffTaskId` 时显示“客服处理中”，明确不会自动取消、退款或扣罚。
- Runtime 已接入 `PostgresRiskEventStore`；`buildApiServer({ riskEvents })` 可注册风险事件路由。

## Verification

- RED：
  - `npx vitest run tests/m2-us-05-api.spec.ts tests/m2-us-04-bot.spec.ts`
  - 失败点：异常 staff task 类型被拒绝；风险事件路由 404；Bot EXCEPTION 面板未显示客服处理中。
  - `npx vitest run tests/m2-us-05-bot.spec.ts`
  - 失败点：`buildCancellationResultMessage` 不存在。
- GREEN：
  - `npx vitest run tests/m2-us-05-api.spec.ts tests/m2-us-05-bot.spec.ts tests/m2-us-05-db.spec.ts tests/m2-us-04-bot.spec.ts`
  - 结果：4 files / 18 tests passed。
- 全局验证：
  - `npm run typecheck`
  - 结果：exit 0。
  - `npm run db:validate`
  - 结果：Prisma schema valid。
  - `npm run db:verify:migration`
  - 结果：migration-apply-ok；table_count=47；constraint_count=3；trigger_count=7。
  - `npm test`
  - 结果：37 files / 210 tests passed。

## Residual Risk

- Discord credential 暂未提供，真实测试 Guild 中取消按钮、客服接管面板和异常任务消息 E2E 未执行。
- M2-US-05 不自动裁决迟到、缺席、中断或争议，也不自动扣罚陪玩；后续人工退款、结案、转派和自动化暂停/恢复由 M2-US-06 与 M2-US-11 继续实现。
