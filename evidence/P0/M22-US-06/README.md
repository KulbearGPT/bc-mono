# M22-US-06 礼物非 UI 自动化与隔离测试数据证据

日期：2026-08-13

分支：`codex/order-review`

状态：`DONE_AUTOMATED / M22-US-05_PENDING_EXTERNAL_UAT`

验收：`AT-GFT-001`–`010`、`AT-GFT-012`–`015`、`AT-RES-003`、`AT-RES-008`–`011`、`AT-GIFT2-001`–`005`

## 完成范围

- 临时 PostgreSQL 每个测试文件独立启动，应用当前全部 migration，并在结束时停止实例和删除目录；数据库名与 Unix socket 不符合测试前缀时失败关闭。
- 确定性 fixture 建立客户、同 Guild 陪玩、客服、目录、CAT 钱包和可信 Discord 绑定；数据库直写仅构造前置事实，送礼创建、审核、捕获、拒绝、过期和 Outbox 重试均走统一 API 或 Worker。
- `giftAutomationCoverage` 完整映射 48 个 GTA 场景；门禁验证编号无缺失/重复、来源测试存在、无 skip/todo，且全部由 `test:gift:non-ui` 执行。
- 真实 PostgreSQL 覆盖可信 receiver 派生、余额不足/目录变化零业务写入、同钱包并发、相同 key 幂等、不同 key 新意图、原预留单次捕获/释放、过期幂等和批准/拒绝并发终态。
- 客服辅助覆盖权限失败、未绑定客户、错误 TOTP、五次锁定、十分钟过期、权限版本变化、充值刷新、challenge 并发单次消费及 TOTP 不落响应/审计/业务事实。
- fake Discord transport 覆盖公开/匿名不可变公告 payload、禁 mention/内部 ID/私密频道、首次投递失败后相同 dedupe key 恢复且不重复消费。
- Bot adapter 覆盖公共常驻入口不展示余额、个人步骤 ephemeral、Actor 绑定、篡改/过期、实例重建、消息删卡恢复和客服 Modal 最小字段。

## RED 与修复记录

1. fixture 初始 RED：缺少隔离 PostgreSQL helper；实现后发现 macOS PostgreSQL Unix socket 路径长度限制，改用短 `/tmp/blackcat-m22-gift-*` 根目录并保留数据库身份守卫。
2. 真实 PostgreSQL 幂等测试最初读取不存在的 `giftRequestId` 响应字段，两个 `undefined` 造成假阳性；更正为真实 `data.id` 并验证 UUID 和持久事实。
3. 统一专项首次运行为 `96 passed / 2 failed`：两个旧 Bot 测试使用固定 2026-08-13 时间签发短期 token，当前执行时已过期，安全恢复分支未调用 API；执行型测试改为当前时刻签发，固定时钟仍由专门过期测试覆盖。
4. 新增币种错误消息回归先得到 `Gifts must use USD.`，与内部 CAT 合同冲突；生产错误改为 `Gifts must use CAT.`，异常目录仍返回 400 且零业务写入。
5. 全仓首轮 `303 files passed / 1 file failed；1518 passed / 1 failed`，唯一失败是新增 Story 证据前验收矩阵 freshness 门禁；生成本证据并重建矩阵后复验。

## GREEN 门禁

- `npm run test:gift:non-ui`：最终 `18 files / 99 tests passed`，最终代码连续三轮通过。
- `npm run quality:bot`：lint、format、Bot typecheck、全仓 build、28 个 Sapphire Pieces 和 `74 files / 412 tests` 全部通过。
- `npm run quality:routes`：`192 production operations exactly match OpenAPI`。
- `npm run lint:api`、`npm run lint:bot`、`npm run typecheck`、`npm run db:validate`：全部退出码 0。
- `npm test`：最终结果记录于 `test-report.json`；首轮仅矩阵 freshness 失败，重建后全绿。
- `node scripts/build-p0-acceptance-matrix.mjs .`、追踪门禁和 `git diff --check`：全部通过。

## 主要修改文件

- Harness/覆盖：`tests/support/gift-automation-fixture.ts`、`tests/support/gift-automation-coverage.ts`。
- 新矩阵：`tests/m22-us-06-gift-{fixture-contract,entry-postgres,assist-boundaries,lifecycle-postgres,privacy-worker,bot-adapter,automation-gate}.spec.ts`。
- 扩充回归：`tests/m22-us-02-standalone-gift-api.spec.ts`、`tests/m22-us-03-bot-gift-entry.spec.ts`、`tests/m22-us-04-staff-gift-assist-{api,bot}.spec.ts`、`tests/m3-us-02-api.spec.ts`、`tests/m6-us-06-api.spec.ts`。
- 生产修复：`apps/api/src/gifts.ts`（CAT 币种错误提示）。
- 门禁/跟踪：`package.json`、Backlog、TODO、实施计划、验收矩阵及 `docs/` 镜像。

## 外部门禁保留

本 Story 不自动点击真实 Discord，也不使用用户 Token。Desktop/Mobile 布局、真实消息右键 Apps、真实 ephemeral 可见性、频道权限、Gateway 重启后的人工点击，以及老板/陪玩/客服/观察者四视角公开与匿名签署仍属于 `M22-US-05`；`M22-US-03/04/05` 因此保持未完成。
