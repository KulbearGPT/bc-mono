# M2-US-08 Evidence: 完整陪玩工作台

## Scope

- Story：M2-US-08 完整陪玩工作台
- 验收用例：AT-WRK-001、AT-EAR-001
- 前置依赖：M2-US-01、M2-US-02、M2-US-03

## Implemented

- `getPlayerWorkbench` 聚合陪玩准入检查、Discord Presence、业务可接单开关、当前订单、待接订单、需求摘要、接单倒计时、本人收益和服务端能力列表。
- PostgreSQL 查询以当前陪玩 `userId` 隔离当前订单、派单候选和收益；工作台投影不查询客户备注、联系方式或第三方账户字段。
- 收益摘要按 `PENDING`、`CONFIRMED`、`PAID` 汇总，并纳入只追加的收益调整记录；不将收益标记为自动支付。
- 不满足准入条件或已有当前订单时，API 不返回可接派单；可执行动作只由 API `nextActions` 决定。
- Sapphire Bot 提供陪玩专用 `/player-workbench` 命令和 ephemeral 面板；公共用户入口仍只保留“创建订单”和“我的服务中心”。
- 工作台支持刷新、设为可接单、接单和暂不接单，并复用既有 API 与派单 interaction handler。

## Verification

- RED：工作台 API 返回全零占位数据；PostgreSQL store、Bot 工作台渲染和 HTTP client 方法不存在。
- GREEN：`npm test -- --run tests/m2-us-08-api.spec.ts tests/m2-us-08-bot.spec.ts tests/m2-us-08-db.spec.ts`，3 files / 8 tests passed。
- `npm run typecheck`：exit 0。
- `npm test`：45 files / 249 tests passed。
- `git diff --check`：exit 0。

## Residual Risk

- Discord credential 暂未提供，测试 Guild 中 slash command 注册、ephemeral 刷新和接单按钮 E2E 未执行。
- P0 不包含公开陪玩档案、试音材料、排班或用户指定陪玩。
