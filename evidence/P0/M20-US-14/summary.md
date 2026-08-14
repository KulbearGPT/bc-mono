# M20-US-14 Discord 生产文案去开发测试痕迹证据

## Story 与验收

- Story：`M20-US-14`
- 验收：`AT-ACT-002;AT-BOT-REV-005`

## RED

命令：`npx vitest run tests/m20-us-14-production-copy.spec.ts`

结果：`1 file / 3 tests` 全失败，分别确认 Bot 用户可见源码仍包含开发/测试/内部实现措辞、英文 Slash Command 描述，以及订单入口暴露内部频道配置。

## GREEN

```text
npx vitest run tests/m20-us-14-production-copy.spec.ts tests/m1-us-07-bot.spec.ts tests/m4-us-10-bot.spec.ts tests/m5-us-07-bot-sandbox.spec.ts tests/m17-us-10-bot-error-messages.spec.ts tests/m18-us-06-service-lifecycle-experience.spec.ts tests/m18-us-07-support-risk-experience.spec.ts tests/m20-us-06-gift-component-protocol.spec.ts
# 8 files / 62 tests passed

npm run quality:bot
# lint + format + typecheck + build + 24-piece manifest passed
# 68 Bot test files / 378 tests passed

npm test
# 首次 build 通过，267/268 test files、1347/1348 tests 通过；唯一失败为新增 Story 后验收矩阵尚未再生成

node scripts/build-p0-acceptance-matrix.mjs .
# 验收矩阵重新生成，纳入 M20-US-14 与专项测试

npm test
# `main` build 通过；267 test files / 1346 tests passed

cmp -s outputs/Codex-P0开发TODO.md docs/Codex-P0开发TODO.md
cmp -s outputs/P0开发交付包/06-开发计划/backlog.csv docs/P0开发交付包/06-开发计划/backlog.csv
git diff --check
# 全部通过
```

## 修改范围

- 环境与配置文案：删除 `SANDBOX 测试环境`、`测试投递`、`Bot 配置`、开发版本等实现词，改为明确的资金风险警告、频道预览和服务器运营配置；内部 API 路由、操作标识、幂等键与审计原因保持不变。
- 订单与服务文案：删除 `P0 默认匹配`、占位承诺、`等待 API`、`业务 API`、`服务端报价`、`READY`、`CANCELLED` 与资金动作枚举，改为客户和陪玩可执行的业务语言。
- 异常与入口文案：不再向 Discord 用户暴露服务器原因、Bot 内部异常、服务凭据或频道配置；保留稳定 `request_id` 和未知写入结果的保守表达。
- Slash Command：所有命令与参数说明使用面向用户的中文生产文案。
- 仅修改 Bot 源码、Bot 文案测试、Story 计划与证据；未修改 API 或 Dashboard 运行时实现。

## 结果与边界

- 用户可见文案不再出现 P0、测试环境、测试消息、占位流程或 API/服务端实现细节。
- 非真实资金警告没有删除，改为“当前余额不代表真实资金，任何操作均不会产生真实收付款”。
- 配置频道预览仍调用原投递接口，状态、权限、金额、资金与业务规则均未改变。
- 自动化已覆盖源码文案和真实 handler；`AT-ACT-002` 的真实 Guild 桌面/移动端最终观感 UAT 尚未执行，因此 Story 保持 `IN_PROGRESS`，本提交是可部署候选而非外部验收完成声明。
