# M11-US-05：无时限手动招募与实时报名名单

- 状态：本地候选已实现；真实 Discord Guild 报名、撤回、静默 mention 与手动终止 UAT 尚未执行，因此 Story 保持 `IN_PROGRESS`。
- 验收：`AT-SEL-001`、`AT-SEL-002`、`AT-SEL-005`、`AT-SEL-007`；关联覆盖 `AT-DSP-011`、`AT-DSP-012`、`AT-DSP-015`、`AT-DSP-016`、`AT-MAT-001`。

## RED 基线

新增 `tests/m11-us-05-manual-recruitment.spec.ts` 后，首次执行得到 `1 file / 4 tests，3 failed / 1 passed`：API 仍接受 `waitMinutes`，客户面板仍只显示报名人数和截止时间，旧 `SELECTION_POOL_CLOSE` Worker 仍会关闭候选池。失败分别锁定请求合同、Discord 投影和状态迁移边界。

## 实现

- 新候选池不再接受等待分钟数，`wait_minutes` 与 `closes_at` 对新事实均为空，并且不创建 `SELECTION_POOL_CLOSE` Outbox Job。迁移保留历史成对时间字段以兼容旧数据，新增服务端关闭原因 `CUSTOMER_STOPPED`，并使待执行的旧关闭任务失效。
- 仅订单所有者可以按候选池版本调用终止接口；客户端不能提交关闭原因。时间流逝、Worker 重启和遗留关闭任务都不能把 `COLLECTING` 迁移到 `SELECTION`。
- “开始招募”和“重新招募”均改为按钮。报名和撤回事务投递稳定 `PANEL_SYNC`，API 客户投影读取当前有效报名者 Discord ID，Worker 原位编辑同一订单 Embed 为 `<@discordUserId>` 名单，并发送 `allowed_mentions: { parse: [] }`，保留可点击 mention 但不触发通知。
- Bot 与 Dashboard 仍只调用统一 API；订单保持 `PENDING_DISPATCH`，原 `FundReservation` 不释放、不捕获、不重复创建。进入 `SELECTION` 后沿用既有客户终选、语音和客服通知流程。

## 自动化证据

- RED：`npx vitest run tests/m11-us-05-manual-recruitment.spec.ts` → `1 file / 4 tests，3 failed / 1 passed`。
- GREEN：同命令 → `1 file / 4 tests passed`。
- 聚焦合同/API/Bot/Worker 回归：`8 files / 81 tests passed`。
- PostgreSQL 迁移与事务回归：`tests/m11-us-02-selection-pools-postgres.spec.ts` → `1 file / 3 tests passed`，空库按迁移链应用至 `000038_manual_selection_recruitment`。
- 追踪与发布门禁：`tests/m5-us-01-traceability.spec.ts tests/m5-us-03-release-gate.spec.ts` → `2 files / 71 tests passed`；验收矩阵可复现生成 `290` 行，`74` 条外部验收均在 UAT 清单唯一映射。
- 工程门禁：`npm run typecheck`、`npm run build`、`npm run db:validate`、`npm run db:verify:migration`、`npm run quality:routes`、20 个 Sapphire Pieces、合同镜像和 `git diff --check` 均通过；路由合同覆盖 157 个生产 operation。
- 全仓 `npm test`：build 通过；`234 files / 1172 tests` 中 `232 files / 1169 tests passed`。剩余 3 项是提交前已存在且与本 Story 无关的门禁：`m17-us-08-handler-behavior` 的旧 refresh 路由解析和 707 行预算两项，以及本地缺少 `eslint` 可执行文件。`npm run format:bot:check` 同样因本地缺少 `prettier` 可执行文件未运行；本次改动已通过 TypeScript build、Bot 关联回归和 diff check，不把环境缺失描述为通过。

## 剩余门禁

需在真实 Guild 使用同一订单消息完成：两名陪玩依次报名、一名撤回、核对 Embed 原位更新和可点击 mention、确认没有 mention 通知、客户手动终止并进入选秀。完成外部证据和产品/客服签署前，`M11-US-05` 与 `M11-US-04` 均保持未勾选。
