# M10-US-07 客户多项目需求编排与逐名额派单

状态：本地候选，保持未完成。自动化实现已覆盖需求清单、服务端报价、逐名额派单和 Discord 订单篮子；真实 Guild UAT 尚未执行。

## 验收映射

- `AT-MULTI-006`：订单需求与实际陪玩分离；Discord 可添加、选择、修改数量/人数、移除和分页浏览项目，确认页使用 API 派生总价。
- `AT-MULTI-007`：派单轮次绑定需求名额；同轮并发仅一人成功；每次接单生成关联需求的参与者与分成快照；全部名额填满后才进入 `ACCEPTED`。

## 当前实现证据

- 数据与迁移：`database/prisma/migrations/000022_order_requirements/migration.sql`、`000023_requirement_slot_dispatch/migration.sql`。
- API：`apps/api/src/order-requirements.ts`、`apps/api/src/orders.ts`、`apps/api/src/dispatch.ts`。
- Discord：`apps/bot/src/service-center.ts` 及订单 Select/Button/Modal handlers。
- 合同测试：`tests/m10-us-07-order-requirements.spec.ts`。
- PostgreSQL 事务与并发：`tests/m10-us-03-postgres.spec.ts`。

## 已执行验证

- `npx vitest run tests/m10-us-07-order-requirements.spec.ts`：1 file / 8 tests passed。
- `npx vitest run tests/m10-us-03-postgres.spec.ts`：1 file / 5 tests passed。
- `npx vitest run tests/m1-us-03-api.spec.ts tests/m1-us-04-bot.spec.ts tests/m10-us-07-order-requirements.spec.ts`：3 files / 30 tests passed。
- `npm run typecheck`：通过。

## 安全与恢复检查

- Bot 不提交金额；行价、总价、预留和分成均由 API/数据库派生。
- custom ID 只携带订单/需求标识、版本和分页游标，不携带价格、权限或对象归属声明。
- 草稿状态来自 API，可在 Bot 重启、多实例或消息刷新后恢复。
- 已移除需求不再出现在可编辑列表，历史由只追加事件保留。
- 已进入当前订单的陪玩不会被再次派到同一订单的其他名额。

## 未完成门禁

- 需要在真实 Discord 测试 Guild 验证九项目分页、Select/Button/Modal 的实际 Builder 行为、频道消息更新与 Bot 重启恢复。
- 在完成真实 Guild UAT 前，`outputs/Codex-P0开发TODO.md` 中 `M10-US-07` 保持未勾选，acceptance matrix 保持 pending。
