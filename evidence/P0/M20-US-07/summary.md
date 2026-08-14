# M20-US-07 过期就绪动作零写入恢复证据

## Story 与验收

- Story：`M20-US-07`
- 验收：`AT-ACT-003`

## RED

命令：`npx vitest run tests/m20-us-07-stale-readiness.spec.ts`

结果：`1 file / 1 test failed`，`setOrderReadiness` 实际调用两次，证明旧 interaction 在版本冲突后会对新订单版本自动重放写操作。

## GREEN

命令：

```text
npx vitest run tests/m20-us-07-stale-readiness.spec.ts tests/m2-us-04-bot.spec.ts tests/m10-us-04-lifecycle.spec.ts tests/m20-us-03-discord-action-renderers.spec.ts
```

结果：`4 files / 31 tests passed`。

门禁：

```text
npm run lint:bot
npm run format:bot:check
npm run typecheck -w @blackcat/bot
```

结果：全部通过。

## 修改文件

- `apps/bot/src/service-center.ts`
- `tests/m2-us-04-bot.spec.ts`
- `tests/m20-us-07-stale-readiness.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果

- readiness 写请求最多执行一次，始终使用用户点击时看到的 expectedVersion 和原幂等键。
- `CONFLICT` 后只调用 `getOrder`，渲染最新 API 投影并显示原 request_id。
- Bot 不根据最新状态自行补写动作，用户必须在刷新后的组件上再次明确确认。
