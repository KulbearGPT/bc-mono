# M17-US-08：Interaction Handler 分层与行为/可达性测试

## 实现结果

- 新增统一 `service-center-route-registry.ts`，button、select 与 modal Sapphire handler 共用一份 route-kind 映射，避免多处条件列表漂移。
- Profile/周报、礼物和客服评价分别迁入可注入 API/interaction 的 feature executor；`service-center-buttons.ts` 从 873 行降至 697 行。
- API-backed button 与客服评价 modal 在 API 调用前完成 `deferUpdate` 或 ephemeral `deferReply`；成功编辑 deferred response，失败通过 ephemeral follow-up/editReply 返回 request ID。
- 行为测试以 interaction spy 和 API stub 验证真实调用顺序为 `ACK → API → edit/follow-up`，不再依赖源码字符串推断 ACK 行为。
- 组件可达性测试从实际 Service Center message 收集全部 enabled custom ID，并验证每个 ID 恰好解析为 button route。
- 审查门禁发现并补齐此前用户可见但不可达的“当前订单”“我的收益”“联系客服充值”“刷新确认”路由；未改变 API 权限、资金或订单状态机。
- 选秀继续由已独立的 selection handler/custom-id parser 承担，相关既有行为回归保持通过。

## RED

```text
npx vitest run tests/m17-us-08-handler-behavior.spec.ts
Test Files  1 failed (1)
Tests       no tests
```

失败原因：统一 route registry 与 Profile interaction executor 尚不存在。

## GREEN 与回归

```text
npx vitest run tests/m17-us-08-handler-behavior.spec.ts
Test Files  1 passed (1)
Tests       4 passed (4)

npm run quality:bot
ESLint/Prettier/typecheck/root build passed
18 pieces discovered
Test Files  47 passed (47)
Tests       236 passed (236)
```

## 修改文件

- `apps/bot/src/service-center-route-registry.ts`
- `apps/bot/src/service-center-profile-interactions.ts`
- `apps/bot/src/service-center-gift-interactions.ts`
- `apps/bot/src/service-center-support-interactions.ts`
- `apps/bot/src/service-center-routes.ts`
- `apps/bot/src/service-center-profile.ts`
- Service Center button/select/modal handlers 与 package exports。
- `tests/m17-us-08-handler-behavior.spec.ts` 及四个既有 wiring 测试的边界迁移。
- Backlog、双 TODO 与本证据。

## 剩余门禁

自动化全量回归、验收矩阵、真实 Guild UAT 证据和发布审计归 M17-US-09；没有外部证据不声称发布完成。

