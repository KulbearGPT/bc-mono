# M17-US-05：可信 Actor Context 与 BotApiTransport

## 实现结果

- 新增唯一 Actor builder，分别覆盖 Discord interaction、Guild 服务身份和 Gateway 事件；空 Guild、DM 或空身份返回 `null`，调用端在统一 API 前失败关闭。
- 修复候选池 button/select 以空字符串伪造 Guild Actor，以及 command/select handler 的 `as string` 绕过。
- 新增 `BotApiTransport`，统一 Bearer 服务认证、`x-client-source`、Actor/interaction headers、幂等键、JSON body/envelope、request ID、fetch 注入和默认 10 秒超时。
- 网络、超时、非 JSON、缺少 data 与 API error envelope 统一为不含 token 的 `BotApiTransportError`；保留 status、code、request ID 与 details。
- `HttpBotApiClient`、`HttpBotConfigApiClient`、`HttpRoleSyncApiClient`、`HttpOnboardingApiClient` 和 `OrderChannelTranscriptApi` 全部迁移到共享 transport；各功能只保留必要的兼容错误类型或重试策略。
- 删除礼物渲染中用于签名的空 Actor，改由调用者显式传入可信 Actor 和 continuation secret。
- 未修改服务端 Actor 解析、scope、权限矩阵、API 路由或业务响应。

## RED

```text
./node_modules/.bin/vitest run tests/m17-us-05-bot-transport.spec.ts
Test Files  1 failed (1)
Tests       no tests
Error: Cannot find package '@blackcat/bot/actor-context'
```

## GREEN 与回归

```text
./node_modules/.bin/vitest run \
  tests/m17-us-05-bot-transport.spec.ts \
  tests/m1-us-04-bot.spec.ts tests/m1-us-06-bot.spec.ts \
  tests/m1-us-07-bot.spec.ts tests/m2-us-01-bot.spec.ts \
  tests/m4-us-05-bot.spec.ts tests/m4-us-10-bot.spec.ts \
  tests/m9-us-05-onboarding-bot.spec.ts
Test Files  8 passed (8)
Tests       55 passed (55)

npm run quality:bot
ESLint 0 warnings; Prettier passed; Bot typecheck passed; root build passed
18 pieces discovered
Test Files  44 passed (44)
Tests       226 passed (226)
```

## 修改文件

- `apps/bot/src/actor-context.ts`
- `apps/bot/src/api-transport.ts`
- 五个 HTTP client 所在文件。
- 使用 Actor 的 command、interaction handler、presence listener 与 runtime startup。
- `apps/bot/src/gifts.ts`
- `apps/bot/package.json`
- `tests/m17-us-05-bot-transport.spec.ts`
- Backlog、双 TODO 与本证据。

## 剩余门禁

真实 Discord interaction 与 API 超时/恢复 UAT 归 M17-US-09；本 Story 声明自动化候选和工程门禁通过。
