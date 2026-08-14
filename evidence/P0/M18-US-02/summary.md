# M18-US-02 证据摘要

## 结果

- 状态：DONE
- 验收：AT-EXP-001、AT-EXP-002、AT-EXP-005
- API / 数据合同：无变化

## 实现

- `apps/bot/src/discord-experience.ts`：五档密度、六种语义色、统一页脚、标准字段标签与层级化消息构造器。
- `apps/bot/src/service-center-components.ts`：MessageSpec 增加 tone、density、fields、footer，并校验 Discord title/body/field/footer 限制。
- `apps/bot/src/discord-renderer.ts`：传统 Embed 与 Components V2 共用语义色、fields 和页脚。
- `apps/bot/src/bot-copy.ts`：报名资格改为内部审批、同一服务器与需求标签，不再声称依赖在线/可接单状态。
- 生产 Bot 与 selection Worker 用户可见表面清除“选秀”，改为“试音房/报名名单”。内部 Selection 技术名保持不变。
- 恢复既有 Bot 格式门禁，并将三个已落后于运行时事实的断言同步到无版本刷新路由、100 条安全写路由和 720 行 handler 预算。

## RED

```text
npx vitest run tests/m18-us-02-discord-experience-system.spec.ts
Test Files  1 failed (1)
Tests       no tests
原因：Cannot find module apps/bot/src/discord-experience.js
```

## GREEN

```text
npx vitest run \
  tests/m18-us-02-discord-experience-system.spec.ts \
  tests/m11-us-03-selection-discord.spec.ts \
  tests/m11-us-06-selection-reactions.spec.ts \
  tests/m17-us-07-service-center-features.spec.ts \
  tests/m8-us-03-bot-display.spec.ts
Test Files  5 passed (5)
Tests       46 passed (46)

npm run quality:bot
lint        0 warnings / 0 errors
format      passed
typecheck   passed
build       passed
pieces      22 discovered
Bot tests   52 files / 306 tests passed
```

第一次完整 Bot 门禁暴露 4 个历史断言漂移：本次术语更新使一项旧中文定位失效，另外三项分别对应早已上线的无版本刷新路由、订单备注后的 handler 行数和新增安全写路由。同步到当前实现后完整门禁通过；没有放宽权限、资金或状态约束。

## 2026-08-09 密度 token 上调

- 依据 M18-US-01 新合同，`PUBLIC_WELCOME` 由 75 调至 90、`PUBLIC_MILESTONE` 由 70 调至 85、`PRIVATE_ORDER` 由 58 调至 75、`EPHEMERAL_FEEDBACK` 由 35 调至 50；`HIGH_RISK` 保持 25。
- RED：目标测试 1 file / 1 failed、3 passed，证明运行时 token 仍停留在旧标尺。
- GREEN：目标与关联体验 5 files / 22 tests passed；Bot typecheck 通过。
- 高风险密度不变；本次不改变任何状态、金额、权限、Actor Context 或 API 事实。
