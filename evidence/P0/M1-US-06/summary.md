# M1-US-06 私密个人服务中心证据

## Story

- Story：M1-US-06 私密个人服务中心
- 验收：AT-ACC-004
- 范围：服务中心 current-user API 聚合、Sapphire ephemeral 视图、M3 前消费和本人收益稳定空列表。

## RED 证据

- `tests/m1-us-06-api.spec.ts` 先于实现新增，最初执行 `npx vitest run tests/m1-us-06-api.spec.ts` 时 `/api/v1/me/consumptions` 与 `/api/v1/me/commissions` 返回 404。
- `tests/m1-us-06-bot.spec.ts` 先于实现新增，最初执行 `npx vitest run tests/m1-us-06-bot.spec.ts` 时缺少 `buildServiceCenterMessage`、`handleOpenServiceCenterFromPublicEntry` 和 Bot current-user HTTP client 方法。
- 新增 Sapphire wiring 检查后，`service-center-buttons` 仍含 placeholder 文案，测试失败，随后才接入 API-backed flow。

## 实现文件

- `apps/api/src/accounts.ts`
  - 新增 `listCurrentUserConsumptions` 与 `listCurrentUserCommissions`。
  - 新增 `/api/v1/me/consumptions` 与 `/api/v1/me/commissions` 安全读路由。
  - M3 前返回结构稳定空列表；未绑定 Discord actor 返回 403。
- `apps/api/src/security.ts`
  - 当前用户自读权限增加 `consumption.self.read` 与 `commission.self.read`。
- `apps/bot/src/service-center.ts`
  - 新增 current-user、balance、consumption、commission Bot API client 方法。
  - 新增 `buildServiceCenterMessage`，只生成 ephemeral 个人面板。
  - 新增 `handleOpenServiceCenterFromPublicEntry`，Bot 通过统一 API 读取用户、余额、消费、本人收益和活跃订单。
- `apps/bot/src/discord-renderer.ts`
  - 新增 native Discord modal renderer，供未绑定用户展示绑定 Modal。
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
  - “我的服务中心”按钮改为调用 API-backed service-center flow 并使用 ephemeral reply。
- `tests/m1-us-06-api.spec.ts`
- `tests/m1-us-06-bot.spec.ts`

## 验证命令

- `npx vitest run tests/m1-us-06-api.spec.ts`
  - 1 file passed, 3 tests passed.
- `npx vitest run tests/m1-us-06-bot.spec.ts tests/m1-us-04-bot.spec.ts && npm run typecheck -w @blackcat/bot`
  - 2 files passed, 20 tests passed.
  - `@blackcat/bot` typecheck passed.
- `npx vitest run tests/m1-us-06-api.spec.ts tests/m1-us-06-bot.spec.ts`
  - 2 files passed, 8 tests passed.
- `npm run typecheck && npm test`
  - root typecheck passed.
  - 18 files passed, 134 tests passed.

## 验收说明

- AT-ACC-004：已绑定用户打开服务中心时，Bot 通过统一 API 获取实时余额字段 `providerBalanceMinor`、`reservedMinor`、`availableMinor`、`currency`、`fetchedAt`，并仅以 ephemeral 面板展示。
- 当前订单：若 `getCurrentUser.activeOrderId` 存在，Bot 再调用 `getOrder` 展示活跃订单入口；没有活跃订单时不伪造订单。
- 消费和本人收益：M3 前返回稳定空列表与零值 summary，不返回错误、不构造假数据。
- 隐私：用户接口和 Bot 面板不返回 `externalUserId`、source customer、beneficiary id、rate bps 或 referral attribution 等推荐/返佣敏感字段。

## 剩余风险

- Discord Bot credential 暂未提供，真实测试 Server 手工 E2E 未执行；当前以 Bot flow、Sapphire handler wiring、HTTP client 和 API 注入测试覆盖。
- 消费与返佣的真实分页数据、脱敏来源用户和 Adjustment 展示留给 M3-US-05/M3-US-07。
