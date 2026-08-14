# M9-US-15 自动/手动派单模式

## 行为

- Guild 运营配置中的 `auto_dispatch_enabled` 作为派单模式开关；关闭后，新订单提交仍会预留资金并保持 `PENDING_DISPATCH`，但 Worker 不会开启自动轮次。
- 从自动切到手动时，已经发出的当前轮次允许自然到期，但超时任务不再续建下一轮；订单和原 FundReservation 都不被改写或重建。
- 后续 M9-US-16 将人工派单拆分为 L2+ `dispatch.manual` 专用路由；系统 `dispatch.execute` 仍仅对 `SYSTEM_JOB` 开放，Dashboard 不能冒充 `ORDER_SUBMITTED` 或 `TIMEOUT_RETRY`。

## 验证

- RED：`tests/m9-us-15-manual-dispatch.spec.ts` 初始 2/2 失败，缺少 Guild 开关解析、Worker 门控和 Dashboard 手动动作。
- GREEN 定向：新 Story 与 API、Dashboard、Bot 关联回归共 4 个测试文件 / 33 个测试通过。
- `npm run typecheck`：通过。
- 合同追踪：新增 `AT-DSP-015/016`、`INT-A-010A` 和 M9-US-15 backlog/TODO 记录，同步 outputs/docs 镜像；验收矩阵重建为 221 项，合同联检 4 个文件 / 80 个测试通过。
- `npm run db:validate`：Prisma schema 有效；本 Story 仅复用已有 Guild Bot 配置，不新增迁移。
- 最终 `npm test -- --run`：159 个测试文件 / 791 个测试全部通过；`npm run build` 通过。

## 状态

自动化候选已完成；当前 Guild 配置保持自动派单，未在本 Story 中擅自变更运营状态。仍需真实 Discord Guild 执行模式切换、Dashboard 单轮派单和陪玩接单 UAT，因此 Story 保持未勾选。
