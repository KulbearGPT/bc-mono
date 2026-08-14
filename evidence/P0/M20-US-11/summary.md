# M20-US-11 静默 mention 与现行文案层级证据

## Story 与验收

- Story：`M20-US-11`
- 验收：`AT-SEL-007;AT-ACT-002`

## RED

命令：`npx vitest run tests/m20-us-11-privacy-copy.spec.ts`

结果：`1 file / 3 tests failed`，分别证明 renderer 未设置 allowed mentions、新人入口有两个 Primary、代码仍含“截止前撤回”和错误的 USD gift invariant。

## GREEN

```text
npx vitest run tests/m20-us-11-privacy-copy.spec.ts tests/m18-us-03-onboarding-order-experience.spec.ts tests/bot-copy.spec.ts tests/m20-us-03-discord-action-renderers.spec.ts
# 4 files / 20 tests passed
npm run test:bot
# 65 files / 365 tests passed
npm run lint:bot
npm run typecheck -w @blackcat/bot
npm run build
git diff --check
# 全部通过
```

## 修改文件

- `apps/bot/src/discord-renderer.ts`
- `apps/bot/src/onboarding.ts`
- `apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts`
- `apps/bot/src/pieces/interaction-handlers/selection-selects.ts`
- `apps/bot/src/gifts.ts`
- `tests/m20-us-11-privacy-copy.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果

- 所有由共享 renderer 生成的首次回复和消息更新都禁用自动 mention 解析；明确的 welcome DM 白名单仍走独立显式路径。
- 新人入口只有“开始找陪玩”为 Primary；注册与申请为 Secondary，不改变三个 action 的路由。
- 不再暗示已退役的固定截止时间；报名只承诺可在本轮招募结束前撤回。
- 礼物内部金额校验明确要求 CAT subunit，不再把非 CAT 错误描述为 USD minor unit。
