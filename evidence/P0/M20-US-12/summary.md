# M20-US-12 Transcript 与 Reaction 稳定事件身份证据

## Story 与验收

- Story：`M20-US-12`
- 验收：`AT-DOP-002;AT-SEL-008`

## RED

命令：`npx vitest run tests/m20-us-12-event-identity.spec.ts`

结果：`1 file / 4 tests failed`，证明缺少 transcript 稳定身份与 partial fetch、Reaction transition 身份和可复现对账身份；生产代码仍使用 `randomUUID`。

## GREEN

```text
npx vitest run tests/m20-us-12-event-identity.spec.ts tests/m11-us-06-selection-reactions.spec.ts tests/m9-us-12-transcript.spec.ts
# 3 files / 24 tests passed
npm run test:bot
# 66 files / 370 tests passed
npm run format:bot:check
npm run lint:bot
npm run typecheck -w @blackcat/bot
npm run build
git diff --check
# 全部通过
```

## 修改文件

- `apps/bot/src/order-channel-transcript.ts`
- `apps/bot/src/pieces/listeners/message-update.ts`
- `apps/bot/src/selection-reactions.ts`
- `apps/bot/package.json`
- `tests/m20-us-12-event-identity.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果

- partial edit 可读取时先 fetch 完整 Message；不可读取时不伪造空内容或 unknown 事件。
- transcript edit identity 同时使用 Discord 编辑时间和 payload 指纹：重投幂等，连续不同编辑不互相吞并。
- live Reaction 按 Guild/channel/message/emoji/user 串行并跟踪状态代次；重复 add 复用键，add/remove/add 获得三个正确的状态身份。
- transition tracker 有 30 分钟 TTL 与 10,000 项上限，不新增无界内存。
- 启动对账对排序后的 Discord 用户集合与 API applied 集合取稳定 hash；同一观察可安全重试，快照变化产生新身份。
- Actor Context 的 sourceEventId 与 API idempotency key 共享同一观察身份，不再用随机 UUID 掩盖重复投递。
