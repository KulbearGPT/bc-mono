# M18-US-05 证据摘要

## 结果

- 状态：DONE（本地运行时与自动化）；真实 Guild 三角色/桌面手机 UAT 归 M18-US-08
- 验收：AT-EXP-001、AT-EXP-002、AT-EXP-003、AT-EXP-004
- API / 数据合同：无对外合同或数据迁移变化

## 实现

- 首轮招募继续按订单幂等发送原创黑猫“正在派单”图；报名 Embed 使用单游戏类别横幅，混合游戏和未知输入只能回退 `other.png`，不能构造文件路径。
- 游戏图与报名 Embed 在同一 Discord multipart 消息中发送/原位更新，沿用稳定 pool footer、message id、nonce 和重启对账；图片失败仍由既有 Outbox 重试，不改业务状态。
- 一张公开卡保持 1–9 个稳定数字 Reaction，第十个项目仍在业务写入前拒绝；每项只显示缺口和该项老板需求，派单阶段不展示预计收益。
- 操作说明明确区分“添加数字＝报名”与“移除数字＝取消报名”；不增加 dropdown，不改 API 根据持久化 messageId + emoji 解析需求的权威边界。
- 招募终止、试音房、客服通知、未匹配私信、最终/部分确认和错误信息已统一使用“试音匹配”。
- 生产 Bot 与 selection Worker 用户可见字符串中“选秀/候选/选拔”扫描为零；内部 `SelectionPool` 型别、API 路由和数据枚举未改名。

## RED

```text
npm exec vitest run tests/m18-us-05-dispatch-trial-experience.spec.ts
Test Files  1 failed (1)
Tests       2 failed | 1 passed (3)
原因：无派单游戏横幅解析器，公开卡仍是旧标题且没有层级/横幅。
```

## GREEN

```text
npm exec vitest run \
  tests/m18-us-05-dispatch-trial-experience.spec.ts \
  tests/m11-us-06-selection-reactions.spec.ts \
  tests/m11-us-03-selection-discord.spec.ts \
  tests/m5-us-02-worker-adapters.spec.ts
Test Files  4 passed (4)
Tests       54 passed (54)

npm run quality:bot
lint        0 warnings / 0 errors
format      passed
typecheck   passed
build       passed
pieces      22 discovered
Bot tests   54 files / 315 tests passed
```

## 全仓基线

```text
npm test
Test Files  236 passed | 4 failed (240)
Tests       1198 passed | 8 failed (1206)
```

剩余 8 项均为 M18 前置合同尚未补全的 acceptance operation/fixture/matrix，以及既有 `selection-pools.ts` `prefer-const` API lint 基线；它们不指向本 Story 修改的 Worker/Bot 行为。M18-US-08 必须在发布前清零这些门禁，不使用本地通过替代真实 Guild UAT。
