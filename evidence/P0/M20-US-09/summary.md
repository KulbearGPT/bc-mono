# M20-US-09 可信 Discord 频道副作用恢复证据

## Story 与验收

- Story：`M20-US-09`
- 验收：`AT-BOT-REV-001;AT-CHN-003;AT-TRN-003`

## RED

命令：`npx vitest run tests/m20-us-09-discord-side-effects.spec.ts`

结果：`1 file / 2 tests failed`。失败分别证明：只要空语音频道名称符合 `selection-*-closing` 就会被删除；订单频道改名异常被吞掉并返回 `undefined`。

## GREEN

命令：

```text
npx vitest run tests/m20-us-09-discord-side-effects.spec.ts tests/m11-us-03-selection-discord.spec.ts tests/m17-us-02-private-channel-adapter.spec.ts
npm run lint:bot
npm run format:bot:check
npm run typecheck -w @blackcat/bot
npm run build
npm run pieces -w @blackcat/bot
git diff --check
```

结果：专项及相关回归 `3 files / 28 tests passed`；其余门禁全部通过；Sapphire manifest 仍发现 24 个 pieces。

## 修改文件

- `apps/bot/src/selection-channel-cleanup.ts`
- `apps/bot/src/pieces/listeners/channel-update.ts`
- `apps/bot/src/pieces/listeners/voice-state-update.ts`
- `apps/bot/src/private-order-channel.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
- `tests/m20-us-09-discord-side-effects.spec.ts`
- `tests/m11-us-03-selection-discord.spec.ts`
- `tests/m17-us-02-private-channel-adapter.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果与恢复语义

- 名称不再单独授予删除权限；必须由 `channelUpdate` 观察到同 Guild、配置私密订单分类、同频道 ID 和精确后缀迁移，才登记十分钟授权。
- 有成员时不删除且保留授权，随后 `voiceStateUpdate` 在最后一人离场时使用同一授权；错误 Guild、分类、名称、过期授权和并发重复请求均安全拒绝。
- Bot 重启会丢失内存授权，因此不会凭名称猜测删除；遗留频道由可信终态 `CHANNEL_ARCHIVE` 工作流最终收敛。
- 订单面板编辑仍是可见失败；改名失败返回 `{ renamed: false, error }`，写结构化日志并向交互反馈权限告警。
- API 已创建或恢复订单频道投影后，任何后续 Discord 异常均保留频道；尚未提交业务事实的临时频道仍可安全清理。
