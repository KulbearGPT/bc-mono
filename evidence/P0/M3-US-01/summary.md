# M3-US-01 验收证据

## 已完成

- `GET /api/v1/gifts?orderId=...` 仅返回订单有效窗口内的 ACTIVE 礼物，并提供固定订单陪玩目标、第三方余额、现有预留、可用余额和每项可负担状态。
- `POST /api/v1/orders/:orderId/gift-requests` 只接受订单版本和礼物版本；客户端即使提交 `receiverId` 也不会改变订单推导的收礼人。
- 支持 `ACCEPTED`、`IN_SERVICE`、`PENDING_CONFIRMATION`，以及 `completedAt` 后精确 24 小时内的 `COMPLETED`；超过边界拒绝。
- 确认时创建礼物快照、ACTIVE Gift FundReservation 和 GIFT_REVIEW 客服任务；不捕获资金、不创建消费、不发送播报。
- PostgreSQL 在同一事务内重验订单版本、订单陪玩、状态窗口和 ACTIVE 礼物版本，并写入礼物请求、`CREATED→ACTIVATED` 两步资金事件及客服任务；后续写入失败会完整回滚。
- Bot 使用统一 API 获取目录和余额、禁用不可负担礼物并提供充值入口；Bot 不计算余额，也不接受收礼人输入。

## 验证结果

- Story：`npx vitest run tests/m3-us-01-api.spec.ts tests/m3-us-01-bot.spec.ts tests/m3-us-01-db.spec.ts`，3 files / 12 tests passed。
- 全量：`npm test`，57 files / 289 tests passed。
- 静态：`npm run typecheck` passed。
- 数据库：`npm run db:validate` 与 `npm run db:verify:migration` passed。
- 合同：两份 OpenAPI YAML 可解析且镜像一致；`git diff --check` passed。

## 未在本地伪造的外部证据

- 真实支付供应商 native hold 与余额接口仍需供应商凭据。
- 真实 Discord Guild 的按钮、下拉菜单和 ephemeral 响应仍需测试 Guild 与 Bot Token。
