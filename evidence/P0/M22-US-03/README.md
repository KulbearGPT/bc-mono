# M22-US-03 Discord 送礼常驻入口与匿名低点击流程证据

日期：2026-08-13

分支：`codex/order-review`

Story：`M22-US-03`（自动化候选；外部 UAT 未完成）

验收：`AT-GIFT2-001`、`AT-GIFT2-002`、`AT-GIFT2-004`

## 完成范围

- 新增 `gift_entry_channel_id` 配置及 Discord/API/Dashboard 一致投影；配置校验要求 Bot 具备查看、发送、嵌入链接与管理消息权限。
- Bot 在配置保存和启动时收敛为一条置顶送礼 Embed。消息 ID 由统一 API 持久化；消息丢失、重启或换频道时可以恢复，并清理 Bot 自己创建的重复入口。
- 真实 Guild 验收发现删卡后 Discord.js 可能返回已删除消息的缓存对象；投影消息与旧频道消息现强制绕过缓存走 REST，避免随后编辑得到 `Unknown Message` 而阻断恢复。
- 老板点击公共卡后，全部业务选择和余额反馈均为 ephemeral：选择一位同 Guild 有效陪玩、选择礼物、在同一确认页选择公开或匿名，不要求绑定订单。
- 余额不足时不创建礼物，提供充值帮助与刷新；创建成功只说明 CAT 已预留并等待审核，不误报为已正式扣除。
- HMAC continuation 绑定 Guild、Discord 用户、陪玩、礼物目录版本、价格与有效期，不使用进程内会话 Map；最终资格、价格、余额、匿名事实和 FundReservation 仍由统一 API 原子决定。
- 订单内礼物入口保持兼容；`gift_requests_enabled` 同时约束订单内和独立入口。

## 实际修改文件

- `apps/api/src/bot-config.ts`
- `apps/api/src/gifts.ts`
- `apps/api/src/onboarding.ts`
- `apps/bot/package.json`
- `apps/bot/src/standalone-gifts.ts`
- `apps/bot/src/bot-api-validation.ts`
- `apps/bot/src/bot-config-contracts.ts`
- `apps/bot/src/bot-config-flow.ts`
- `apps/bot/src/onboarding.ts`
- `apps/bot/src/runtime-startup.ts`
- `apps/bot/src/service-center-api-client.ts`
- `apps/bot/src/service-center-api-client-contract.ts`
- `apps/bot/src/service-center-api-client-gifts.ts`
- `apps/bot/src/service-center-api-client-standalone-gift-contract.ts`
- `apps/bot/src/service-center-routes.ts`
- `apps/bot/src/service-center-route-registry.ts`
- `apps/bot/src/service-center-route-support-gift-profile.ts`
- `apps/bot/src/pieces/interaction-handlers/bot-config-buttons.ts`
- `apps/bot/src/pieces/interaction-handlers/order-selects.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-modals.ts`（Prettier 格式收敛）
- `apps/dashboard/src/bot-config-dashboard.ts`
- `scripts/uat/m22-gift-entry-uat.ts`
- `outputs/P0开发交付包/02-API/openapi.yaml` 及 `docs/` 镜像
- `tests/m22-us-03-bot-gift-entry.spec.ts`
- `tests/m22-us-03-gift-entry-postgres.spec.ts`
- `tests/m22-us-03-guild-uat-harness.spec.ts`
- `tests/m7-us-07-retirement.spec.ts`
- `outputs/P0开发交付包/06-开发计划/backlog.csv` 及 `docs/` 镜像
- `outputs/Codex-P0开发TODO.md` 及 `docs/` 镜像
- `evidence/P0/acceptance-matrix.csv`
- `evidence/P0/M22-US-03/guild-recovery-uat.json`
- `evidence/P0/M22-US-03/human-uat-runbook.md`

## TDD 证据

### RED

```text
npx vitest run tests/m22-us-03-bot-gift-entry.spec.ts
```

初始结果：`1 suite / 0 tests`；测试无法加载缺失的 `@blackcat/bot/standalone-gifts` 模块。

### GREEN：Bot 流程、PostgreSQL 持久投影与 UAT Harness

```text
npx vitest run tests/m22-us-03-guild-uat-harness.spec.ts tests/m22-us-03-bot-gift-entry.spec.ts tests/m22-us-03-gift-entry-postgres.spec.ts
```

结果：`3 files / 9 tests passed`。

覆盖唯一置顶入口、低点击公开/匿名确认、签名上下文、余额不足续接、HTTP DTO 失败关闭、真实 Sapphire handler 接线、真实 PostgreSQL 消息投影 upsert/reload、删卡时强制 REST 恢复，以及 SANDBOX/自清理 UAT 门禁。

### 关联礼物、配置与引导回归

```text
npx vitest run tests/m22-us-01-standalone-gift-contract.spec.ts tests/m22-us-02-standalone-gift-api.spec.ts tests/m22-us-02-standalone-gift-postgres.spec.ts tests/m22-us-03-bot-gift-entry.spec.ts tests/m22-us-03-gift-entry-postgres.spec.ts tests/m22-us-03-guild-uat-harness.spec.ts tests/m20-us-06-gift-component-protocol.spec.ts tests/m4-us-10-api.spec.ts tests/m4-us-10-bot.spec.ts tests/m4-us-10-db.spec.ts tests/m15-us-04-bot-config-dashboard.spec.ts tests/m9-us-03-onboarding.spec.ts tests/m7-us-07-retirement.spec.ts
```

结果：`13 files / 56 tests passed`。

## 真实 Discord SANDBOX Guild 自动恢复探针

执行前先独立验证凭据中的 `BUSINESS_ENV=SANDBOX`，再运行：

```text
npx dotenv -e <SANDBOX_ENV_FILE> -v M22_UAT_CONFIRM=DELETE_TEMP_GIFT_CHANNEL -- npx tsx scripts/uat/m22-gift-entry-uat.ts
```

最终结果：`PASS_AUTOMATED_PROBE`。Guild `1533309755873955880` 中首次入口 `1537404363172216832` 成功置顶，重复确保复用同一 ID，人工制造的重复卡被删除；重建 API、PostgreSQL store 与 Bot HTTP client 后投影仍存在。删除首次入口后恢复为 `1537404376753373267`，最终可见入口数为 `1`，持久投影与 Discord 一致，公开卡不含个人余额，业务礼物写入为 `0`。临时频道 `1537404360923938927` 与临时数据库均已删除。机器证据：`guild-recovery-uat.json`。

探针前两次失败分别发现置顶与删除后的本地读取命中 Discord 缓存，Harness 随后改用强制 REST 观察最终状态；第三次由此确认生产恢复本身也会命中已删除的投影缓存并在 `PATCH` 时返回 Discord `10008 Unknown Message`。生产代码改为强制 REST 后，同一真实场景通过，并新增对应回归测试。

## Bot、合同与静态门禁

```text
npm run quality:bot
npm run lint:api
npm run quality:routes
npm run db:validate
git diff --check
```

结果：Bot lint、format、typecheck、build、24 个 Sapphire Pieces 与 `72 files / 403 tests` 全部通过；API ESLint、`188` 个生产 operation 与 OpenAPI 双向精确一致、Prisma 和空白检查通过。UAT script 与 Harness 的独立 ESLint 也通过。

## 全量回归

```text
npm test
```

结果：`293 files / 1458 tests passed`。

## 剩余边界

- `AT-GIFT2-004` 的真实 Guild 单卡、重复收敛、API/client 重建与删卡恢复自动探针已通过；真实老板的桌面/手机组件点击、余额不足充值续接、Bot Gateway 重启旧组件和布局签署仍待按 `human-uat-runbook.md` 执行，因此 Story 保持 `IN_PROGRESS`，TODO 不勾选。
- `M22-US-04` 客服辅助指令仍等待产品明确：客服可直接预留老板余额，还是只能生成由老板最终确认的请求。当前实现没有授予客服代客扣款能力。
- 匿名审批后公开播报、陪玩视角及内部对账的真实多角色 UAT 归 `M22-US-05`。
