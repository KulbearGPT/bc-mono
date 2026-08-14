# M21-US-03 Discord 低点击评价中心证据

日期：2026-08-13

分支：`codex/order-review`

Story：`M21-US-03`

验收：`AT-REVIEW-002`、`AT-REVIEW-004`

## 完成范围

- 完单卡在 24 小时评价窗口内显示一个“评价本次服务”入口；新订单卡不再拆分客服专用评价入口，旧卡 custom ID 仍保留兼容路由。
- 私密评价中心直接展示订单整体的五个星级按钮：打开后只需一次星级点击即可保存整体评价。
- API 返回的未评价陪玩和“猫舍前台”可多选后共同打分；不同分数可分批选择。低分同样直接保存，不要求原因或留言。
- 已保存星级马上从 API 回读并展示；关闭或重开 ephemeral 面板不会丢失。留言通过单独的可选 Modal 追加，星级不会因跳过或留言失败撤销。
- 超过 25 个目标时稳定分页；选择状态编码为绑定订单、Guild 和老板 Discord 身份的 HMAC 签名位图，可跨 Bot 重启恢复，不使用进程内 Map。
- 评分前先 ACK；陈旧或冲突组件回读 API 最新事实并返回 request ID，不自动重放旧评分意图。
- 新增真实 HTTP client DTO 失败关闭、Button/Select/Modal Sapphire handler、Piece 发现和 PostgreSQL 订单卡资格投影。
- 本 Story 未实现五星公开预览/确认或好评频道投递；它们属于 `M21-US-04`。

## TDD 证据

### RED

```text
npx vitest run tests/m21-us-03-bot-review-center.spec.ts
```

初始结果：suite 加载失败、`0 tests`；缺失 `@blackcat/bot/order-experience-review-interactions` 真实模块。

### GREEN：专项与关联回归

```text
npx vitest run tests/m21-us-03-bot-review-center.spec.ts
```

结果：`1 file / 8 tests passed`。

覆盖：统一完单入口、一键整体星级、多人同分、低分无原因、HMAC 身份绑定和防篡改、跨页状态、可选留言、陈旧交互恢复、HTTP Actor Context/幂等/DTO 校验、真实 Sapphire handler。

```text
npx vitest run tests/m12-us-04-bot.spec.ts tests/m18-us-06-service-lifecycle-experience.spec.ts tests/m2-us-04-bot.spec.ts tests/m20-us-03-discord-action-renderers.spec.ts tests/m5-us-02-worker-adapters.spec.ts tests/m5-us-02-worker-db.spec.ts tests/m5-us-02-worker-runtime.spec.ts tests/m6-us-06-bot.spec.ts tests/m17-us-08-handler-behavior.spec.ts tests/m20-us-10-interaction-reliability.spec.ts tests/m20-us-13-runtime-cleanup.spec.ts tests/m21-us-03-bot-review-center.spec.ts
```

结果：首轮 `12 files / 91 tests passed`；新增数据库资格窗口断言后目标复验 `2 files / 10 tests passed`。

## 静态与运行门禁

```text
npm run build
npm run pieces --workspace @blackcat/bot
npm run lint:api-dashboard
npm run lint:bot
npm run quality:routes
git diff --check
```

结果：构建通过；Sapphire 发现 24 个 Pieces（含三个评价交互所复用的真实 handler）；Bot ESLint `0 warnings`；API/Dashboard 保持既有 `0 errors / 28 warnings`，低于 39 门禁；168 条生产路由合同一致；空白检查通过。

## 实际修改范围

- Bot 评价中心、路由、HTTP client、DTO 校验、签名状态与真实 interaction handlers。
- API Worker 订单卡投影与资格字段；未改变 API 评价业务规则或评价数据库事实。
- `.env.example` 与 Sandbox Bot 部署说明增加稳定的评价状态签名 Secret。
- 交互映射、backlog、TODO 和本证据同步。
- 礼物业务源码、礼物合同、资金流程均未修改。

## 剩余门禁

- `M21-US-04`：明确同意的五星安全预览及 Outbox 好评频道幂等投递。
- `M21-US-05`：真实 Guild、移动端、多陪玩混合评分、Bot 重启和隐私外部 UAT；自动化不能替代该签署。
