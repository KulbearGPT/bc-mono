# M21-US-05 发布门禁与外部 UAT 候选证据

日期：2026-08-13

实现基线：隔离 Harness 候选起点 `git:e65e51ae2fa11e7fd7cc45b325360fc0a2006232`；外部执行时必须记录当前候选完整 SHA。

状态：`IN_PROGRESS`。本文件记录未通过门禁基线与执行准备，不是外部验收通过证明；`M21-US-05`、`AT-REVIEW-002` 和 `AT-REVIEW-003` 均保持未完成。

验收：`AT-REVIEW-001`–`AT-REVIEW-004`

## 已通过的自动门禁

- M21 合同、API、PostgreSQL、Bot 交互和 Worker 专项：`5 files / 28 tests passed`。
- 好评频道配置关联回归：`5 files / 33 tests passed`。
- Worker 与关联回归：`8 files / 61 tests passed`。
- 验收追踪与发布门禁回归：`5 files / 87 tests passed`。
- M21-US-04 真实 Guild 自清理探针已验证安全快照、重放去重、删卡恢复、单卡收敛和临时频道清理；详见 `evidence/P0/M21-US-04/README.md`。
- 本候选加入 Harness 后复验：M21 全链与动作发布关联 `7 files / 33 tests passed`；好评频道配置关联 `5 files / 33 tests passed`；Worker 关联 `8 files / 61 tests passed`；重生成 312 行验收矩阵后追踪/发布关联 `5 files / 87 tests passed`。
- `npm run build`、API/Bot/Dashboard typecheck、API/Dashboard lint（既有 28 warnings、0 error）、Bot lint、168 项路由合同、Prisma schema validate、Bot Pieces 清单均通过；UAT 两个 TypeScript 脚本另以 NodeNext 严格编译检查通过，两个 shell 脚本 `bash -n` 与 executable bit 检查通过。

## M21-US-05 隔离 UAT Harness

新增的执行与验证资产：

- `scripts/uat/m21-review-flow-db.sh`：仅在显式确认、`SANDBOX` 且数据库名含 `_uat` 时创建/删除隔离库，并应用全部 Prisma 迁移。
- `scripts/uat/m21-review-flow-uat.ts`：创建自标记、可精确清理的私密交互频道与只读好评频道；绑定真实非 Bot 老板，投递真实评价入口；提供内部保存、最终公开、重放、删卡恢复和清理检查点。
- `scripts/uat/m21-review-flow-fixture.ts`：幂等准备三名陪玩、首响客服和已完成订单，并预置已捕获预留、钱包、消费、三笔陪玩收益、返佣、派单、风控及 staff 权限事实。检查点要求评价前后这些事实逐字段完全一致。
- `scripts/uat/m21-review-flow-services.sh`：使用同一隔离库启动编译后的 API、Worker 与 Bot，固定短轮询并拒绝非 SANDBOX/短签名密钥。
- `tests/m21-us-05-review-uat-harness.spec.ts`：在临时真实 PostgreSQL 上应用全部迁移，验证 fixture 二次执行幂等、统一评价 Store 混合评分/私密留言/五星快照、业务事实不变，以及同一 Outbox 重排队。

TDD 过程先后记录了缺少 fixture 模块、数据库脚本、服务脚本及恢复模式时的 RED；实现后专项结果：

```text
npx vitest run tests/m21-us-05-review-uat-harness.spec.ts
Test Files  1 passed (1)
Tests       2 passed (2)
```

完成度审计另发现手册原先在设置隔离 URL 后才加载 SANDBOX 凭据文件；虽然运行脚本的 `_uat` 强校验会拒绝误指向日常库，但会造成执行失败。新增静态顺序门禁先得到 `1 failed / 1 passed` RED，随后改为先加载凭据、再强制覆盖 `BUSINESS_ENV` 与全部隔离数据库变量，专项恢复为 `2 passed`。

数据库脚本另以 `blackcat_m21_review_uat_smoke` 做过实库烟雾检查：42 个迁移全部应用；fixture 生成 5 个合法评价目标；受限 `blackcat_app` 角色可通过真实 `PostgresOrderExperienceReviewStore` 写入；随后整体删除隔离库并确认不存在。

## 未通过发布基线

```text
npm test
```

结果：构建成功；本候选为 `264 passed / 15 failed` files、`1381 passed / 21 failed` tests。21 项失败集合与 M21-US-04 已记录的仓库基线一致：11 个合同测试指向 `docs/outputs` TODO 在既有 `dashboard-module-boundaries` 行的镜像漂移，9 个旧 M2 API fixture 缺失 Guild 作用域，1 个既有 Bot 函数超过复杂度门禁。M21 专项没有新增失败，但全仓发布门禁不能描述为通过。

## 真实环境只读预检

使用相邻主工作树的 SANDBOX 环境变量执行只读检查，未迁移、未配置、未写入数据库：

- 本地数据库最新已应用迁移为 `000040_selection_reaction_card_backfill`；`000041` 与 `000042_order_experience_reviews` 尚未应用，评价和发布表不存在。
- 24 小时内符合条件的已完成订单为 `0`，三陪玩测试订单为 `0`，当前 Guild 可归属给真实老板的合格订单为 `0`。
- 当前 Guild 的 `review_broadcast_channel_id` 未配置。
- `REVIEW_CONTINUATION_SIGNING_SECRET` 未配置；API、Worker 与 Bot 未运行。

因此不能在当前状态下要求老板点击，也不能把 M21-US-04 的合成 Worker 探针冒充完整老板端 UAT。

## 待执行外部门禁

执行合同见 `evidence/P0/M21-US-05/human-uat-runbook.md`。仍需要：

1. 一名真实老板提供其测试 Guild Discord 用户 ID，并在桌面与手机端亲自完成混合评价、关闭/重开、Bot 重启恢复和可选留言场景。
2. 由具名执行人按手册运行现已自动化的隔离库/fixture/Discord 频道 Harness；不得写现有业务数据库。
3. 配置同 Guild 临时好评频道，先选择“仅内部保存”证明零公开，再明确同意并验证只公开五星对象。
4. 由具名老板与运营/QA 留存录屏、截图、request ID、Outbox/恢复日志及订单资金前后对账，并按外部证据合同写入哈希账本。

在以上人工证据、具名签署和全仓发布门禁均完成前，backlog 与 TODO 必须保持 `M21-US-05` 未完成。
