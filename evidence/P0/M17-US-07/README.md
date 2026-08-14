# M17-US-07：Service Center 展示与路由拆分

## 实现结果

- 提取 `service-center-components.ts`：集中 Discord 展示类型、分页 custom ID 生成器与运行时限制校验。
- 提取 `service-center-routes.ts`：集中所有 Service Center custom ID 解析，Profile、礼物等代表性 ID 已验证生成/解析成对。
- 提取 `service-center-profile.ts`：独立维护服务中心、钱包、个人中心、消费记录与陪玩周报展示。
- `discord-renderer.ts` 在创建 discord.js Builder 前执行 custom ID、action row、select option 与标题限制校验。
- Profile、礼物与 service-center 余额展示改用固定 canonical wallet 配置，环境读取仅保留在启动配置边界；文案与交互语义未改变。
- 兼容 facade 继续 re-export 新模块，并由 3,202 行降至 2,341 行。

## RED

```text
npx vitest run tests/m17-us-07-service-center-features.spec.ts
Test Files  1 failed (1)
Tests       no tests
```

失败原因：`@blackcat/bot/service-center-components` 等 feature 边界尚不存在。

## GREEN 与回归

```text
npx vitest run tests/m17-us-07-service-center-features.spec.ts
Test Files  1 passed (1)
Tests       3 passed (3)

npm run quality:bot
ESLint/Prettier/typecheck/root build passed
18 pieces discovered
Test Files  46 passed (46)
Tests       232 passed (232)
```

## 修改文件

- `apps/bot/src/service-center-components.ts`
- `apps/bot/src/service-center-routes.ts`
- `apps/bot/src/service-center-profile.ts`
- `apps/bot/src/service-center.ts`
- `apps/bot/src/discord-renderer.ts`
- `apps/bot/src/gifts.ts`
- `apps/bot/package.json`
- `tests/m17-us-07-service-center-features.spec.ts`
- Backlog、双 TODO 与本证据。

## 剩余门禁

Interaction Handler 分层、共享 ACK/error reply 和所有可用组件的唯一路由可达性归 M17-US-08。

