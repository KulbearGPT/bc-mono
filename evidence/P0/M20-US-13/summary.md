# M20-US-13 Bot 运行时边界与模块债务收口证据

## Story 与验收

- Story：`M20-US-13`
- 验收：`AT-BOT-REV-002;AT-BOT-REV-003;AT-BOT-REV-004;AT-BOT-REV-005`

## RED

命令：`npx vitest run tests/m20-us-13-runtime-cleanup.spec.ts`

结果：suite 在导入时失败，明确缺少 `@blackcat/bot/runtime-dependencies`；后续补强用例覆盖非法响应、内存边界、退役 DTO 和大文件门禁。

## GREEN

```text
npx vitest run tests/m20-us-13-runtime-cleanup.spec.ts tests/m2-us-02-bot.spec.ts tests/m2-us-03-bot.spec.ts tests/m2-us-08-bot.spec.ts
# 4 files / 15 tests passed

npm run quality:bot
# lint + format + typecheck + build + 24-piece manifest passed
# 67 Bot test files / 375 tests passed

node scripts/build-p0-acceptance-matrix.mjs .
# 308 acceptance rows written

npm test
# build passed; 265 test files / 1327 tests passed

cmp -s outputs/Codex-P0开发TODO.md docs/Codex-P0开发TODO.md
cmp -s outputs/P0开发交付包/06-开发计划/backlog.csv docs/P0开发交付包/06-开发计划/backlog.csv
git diff --check
# 全部通过
```

## 修改范围

- `apps/bot/src/runtime-dependencies.ts`、`index.ts`、`runtime-startup.ts`：只在组合根创建并注入共享 transport 及全部业务 client。
- Bot commands、interaction handlers 与 listeners：改为使用统一 runtime dependencies，删除模块级环境读取和重复 client。
- `apps/bot/src/bot-api-validation.ts`、`service-center-api.ts`、`bot-config.ts`：对订单、钱包、礼物、候选页和 Bot config 关键 DTO 失败关闭，统一转为可追踪 502。
- `BotConfigSessionStore` 与 `PaginationHistoryStore`：增加 TTL、容量上限和最旧项淘汰。
- `service-center-api.ts`、`service-center-components.ts`、`service-center-entry.ts`：删除退役直接接单/拒单、availability/倒计时 DTO、假频道权限计划与死 helper。
- `player-workbench-message.ts` 与 `service-center-order-notes.ts`：按 feature 拆分 renderer，`service-center.ts` 保持对外兼容导出且降至 2200 行以内。
- 仅修改 Bot 源码、Bot 测试、Story 证据/门禁资料；未修改 API 或 Dashboard 运行时实现。

## 结果

- 所有 Bot 网络路径共享同一配置、fetch 与 transport，测试可完整注入。
- 关键 API data 不再仅依赖 TypeScript 断言；畸形或币种/余额不变量响应不会继续渲染或执行。
- 临时会话与分页导航历史不再无界增长。
- Bot 代码表面不再暗示退役 availability、倒计时抢单或客户端自行修改频道权限。
