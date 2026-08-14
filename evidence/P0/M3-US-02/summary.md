# M3-US-02 验收证据

## 已完成

- L1 只能核对本人已认领的 GIFT_REVIEW 任务；核对方法和内部备注持久化。
- 核对生成 canonical `verification_payload_hash` 和 15 分钟执行凭据；礼物金额、目标、预留、版本或到期状态变化后拒绝执行。
- L2 可直接授权 `<= 200000`；`200001–499999` 进入 L3 审批；`>= 500000` 进入 L4 审批。
- L3/L4 直授权和高额续办要求近期 step-up；达到最低等级的同一人允许发起并执行。
- 高额续办写入不可变 `approval_requests`、payload snapshot/hash 与 `approval_decisions`；旧版本重放被拒绝。
- 拒绝要求原因；本 Story 不捕获、不创建消费、不播报，资金副作用由 M3-US-03/M3-US-06 接续。
- Dashboard 客服卡展示礼物、双方、预留状态、订单文字频道、可选语音链接和按等级计算的动作。

## 验证结果

- Story：`npx vitest run tests/m3-us-02-api.spec.ts tests/m3-us-02-dashboard.spec.ts tests/m3-us-02-db.spec.ts`，3 files / 9 tests passed。
- 全量：`npm test`，60 files / 298 tests passed。
- `npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` passed。
- Prisma 三份镜像一致；OpenAPI 文档已增加核对凭据响应与授权阶段说明。

## 后续关联

- AT-GFT-004/005 的金额授权与升级边界已覆盖；其中“捕获原预留一次”的支付副作用在 M3-US-03 完成后形成端到端证据。
- 真实 Discord Guild、Dashboard 浏览器和 MFA 提供者 E2E 待对应环境凭据。
