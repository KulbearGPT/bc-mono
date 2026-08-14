# M20-US-10 Discord 交互响应与命令权限收敛证据

## Story 与验收

- Story：`M20-US-10`
- 验收：`AT-BOT-REV-003;AT-BOT-REV-004`

## RED

命令：`npx vitest run tests/m20-us-10-interaction-reliability.spec.ts`

结果：专项 suite 在收集阶段失败，明确显示工作台与 Modal 尚无可独立测试、可注入的 interaction executor；原代码同时缺少 `/service-center` Guild/ManageGuild 限制，工作台在 API 后才 reply，项目备注异常没有 catch。

## GREEN

命令与结果：

```text
npx vitest run tests/m20-us-10-interaction-reliability.spec.ts
# 1 file / 3 tests passed
npm run test:bot
# 64 files / 362 tests passed
npm run format:bot:check
npm run lint:bot
npm run typecheck -w @blackcat/bot
npm run build
npm run pieces -w @blackcat/bot
git diff --check
# 全部通过；manifest 为 24 pieces
```

## 修改文件

- `apps/bot/src/pieces/commands/service-center.ts`
- `apps/bot/src/pieces/commands/player-workbench.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-modals.ts`
- `apps/bot/src/player-workbench-interactions.ts`
- `apps/bot/src/service-center-modal-interactions.ts`
- `apps/bot/src/public-entry-order-interactions.ts`
- `apps/bot/package.json`
- `tests/m20-us-10-interaction-reliability.spec.ts`
- `tests/m2-us-08-bot.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果

- 公共入口部署命令只能在 Guild 内由具备 `ManageGuild` 的成员执行；这只是 Discord 发布门槛，业务 API 仍是最终授权事实。
- 私密陪玩工作台在任何 API 调用前发送 ephemeral defer，之后只 edit 已 ACK 的响应。
- 客服评价、订单备注和项目备注共享 feature executor；写入冲突、服务错误和非标准异常都使用统一错误格式与可信 request_id。
- 服务中心 Button Piece 有最终异常边界：已 ACK 使用 ephemeral follow-up，未 ACK 使用 ephemeral reply，不再让相邻网络 handler 静默超时。
- 公共入口订单创建/恢复移到独立 adapter；已提交业务事实后的 Discord 恢复语义保持 M20-US-09 合同。
