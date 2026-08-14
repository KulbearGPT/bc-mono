# M17-US-03：Bot 启动 readiness barrier

## 实现结果

- 新增显式 `BotReadinessState` 与可测试的关键/后台任务协调器。
- Discord Gateway ready 只记录连接事实，不再执行阻塞式恢复，也不直接切换健康状态。
- `index.ts` 在登录后依次等待统一 API health、Bot 配置缓存和已配置 onboarding 常驻消息；任何关键失败均保持 503 并失败关闭。
- Role 观察同步及产品 Role 任务按 Guild 组成后台任务，最多两个 Guild 并发；Discord Role 仍只是 API 输入信号，不成为本地授权事实。
- SIGINT/SIGTERM 先清除 Ready，再销毁 Discord 客户端并关闭 health server。

## RED

```text
./node_modules/.bin/vitest run tests/m17-us-03-bot-readiness.spec.ts
Test Files  1 failed (1)
Tests       no tests
Error: Cannot find package '@blackcat/bot/runtime'
```

## GREEN 与回归

```text
./node_modules/.bin/vitest run \
  tests/m17-us-03-bot-readiness.spec.ts \
  tests/m5-us-08-railway-runtime.spec.ts \
  tests/m9-us-05-onboarding-bot.spec.ts \
  tests/m4-us-05-bot.spec.ts
Test Files  4 passed (4)
Tests       28 passed (28)

npm run typecheck -w @blackcat/bot
tsc -p tsconfig.json --noEmit

npm run pieces -w @blackcat/bot
18 pieces discovered

npm run build
tsc -b tsconfig.build.json
```

## 修改文件

- `apps/bot/src/runtime.ts`
- `apps/bot/src/runtime-startup.ts`
- `apps/bot/src/index.ts`
- `apps/bot/src/pieces/listeners/ready.ts`
- `apps/bot/package.json`
- `tests/m17-us-03-bot-readiness.spec.ts`
- `tests/m4-us-05-bot.spec.ts`
- Backlog、双 TODO 与本证据。

## 剩余门禁

真实部署重启期间的 503→200、常驻消息恢复与后台 Role 扫描仍需 M17-US-09 的 Railway/Discord UAT；自动化只声明本地候选通过。
