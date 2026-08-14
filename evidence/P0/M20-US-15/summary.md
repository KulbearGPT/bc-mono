# M20-US-15 Bot 巨型文件与复杂度收口证据

## Story 与验收

- Story：`M20-US-15`
- 验收：`AT-BOT-REV-003;AT-BOT-REV-004;AT-BOT-REV-005`

## RED

命令：`npx vitest run tests/m20-us-15-module-boundaries.spec.ts`

结果：`1 file / 2 tests` 中结构测试失败，报告 18 项违规；主要包括 `service-center.ts`、`service-center-api.ts`、`bot-config.ts`、`selection-discord.ts` 的文件体量，以及中央 dispatch、订单选择、传输和 transcript 记录函数的长度或决策复杂度。

## GREEN

```text
npx vitest run tests/m20-us-15-module-boundaries.spec.ts
# 1 file / 2 tests passed
# 最大文件：service-center-api-client.ts，660 行
# 最大函数：buildSelectionCandidatePanel，141 行
# 最高决策复杂度：buildSelectionPoolRefreshMessage，19

npm run quality:bot
# lint + format + typecheck + build + 24-piece manifest passed
# 69 Bot test files / 380 tests passed

npm test
# 首次 build 通过，258/270 test files、1341/1353 tests 通过；12 项失败仅为 Story 完成前 TODO 镜像与验收矩阵尚未同步
# 完成镜像和矩阵同步后复验：270 test files / 1353 tests passed

node scripts/build-p0-acceptance-matrix.mjs .
# 验收矩阵重新生成，纳入 M20-US-15 结构门禁与证据

cmp -s outputs/Codex-P0开发TODO.md docs/Codex-P0开发TODO.md
cmp -s outputs/P0开发交付包/06-开发计划/backlog.csv docs/P0开发交付包/06-开发计划/backlog.csv
git diff --check
# 全部通过
```

## 修改范围

- `service-center.ts` 保留稳定导出 facade；订单频道、面板、目录、确认、动作、需求、客服评价和共享适配逻辑按领域拆分。
- `service-center-api.ts` 保留统一 API 边界 facade；DTO、client 合同、HTTP client、错误与幂等工具分离，全部网络调用继续复用 `BotApiTransport`。
- `bot-config.ts` 拆为合同、API、会话状态和交互流程；`selection-discord.ts` 拆为候选、路由编解码、候选池、语音和合同模块。
- `service-center-routes.ts` 改为组合式 route codec；中央按钮、派单按钮、订单选择、API transport 与 transcript handler 拆为可审核的小函数。
- 更新受影响的源码结构测试，使其验证 facade 兼容性和真实实现模块，不再要求实现驻留在旧巨型文件。
- 仅修改 Bot 源码、Bot 测试、Story 计划与证据；未修改 API 或 Dashboard 运行时实现。

## 结果与边界

- Bot 全目录受自动门禁保护：单文件不超过 700 行、函数不超过 150 行、决策复杂度不超过 20。
- 四个原巨型入口现为稳定 facade，已有消费者无需更改导入路径。
- TypeScript 运行时依赖图无循环；共享 transport、Actor Context、状态、权限、金额、资金、幂等及 Discord custom ID 协议均保持不变。
