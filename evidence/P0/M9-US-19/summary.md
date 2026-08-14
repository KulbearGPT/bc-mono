# M9-US-19 终态订单频道封存与僵尸清理

- 状态：本地候选；自动化通过，待部署后真实 Guild 完成/取消、分页 transcript 与频道删除 UAT。
- 验收：`AT-TRN-003`、`AT-TRN-004`。
- 合同：`COMPLETED` 与 `CANCELLED` 都按 `channel_archive_after_completion_minutes` 等待；允许范围 0–60 分钟，默认且最长为 60 分钟，配置为 0 时可在终态事务提交后立即进入处理。配置键为兼容既有合同而保留原名，Dashboard 与 Bot 标签已明确为“订单终态后频道清理”。
- 事务：客户取消、客户确认完成、客服结案三条 PostgreSQL 终态路径都在原业务事务内写入版本化、幂等 `CHANNEL_ARCHIVE`；普通取消同时补齐此前遗漏的 `cancelled_at`。
- 删除门禁：Worker 先等待终态 `PANEL_SYNC` 完成，再把订单文字频道锁为只读；随后按 Discord 每页 100 条分页读取当前仍可见消息，以与实时 listener 相同的 `<messageId>:CREATED:v1` 事件键和 Discord 原消息时间追加 append-only transcript。任何冻结、读取或 transcript 落库失败都不会调用频道删除。
- 删除顺序：完整回填后去重删除选秀语音房、正式服务语音房，最后删除订单文字频道；Discord 404 视为已收敛。部分删除后重试会重新执行幂等回填并继续剩余删除。
- 僵尸恢复：Worker 启动时及每 60 秒扫描到期终态订单；没有同版本清理任务、没有未完成/失败面板同步时才补建任务。失败清理任务保留在现有运营入口供获授权员工重试，不用扫描生成新任务掩盖失败。
- transcript 范围：保存正文、Embed、回复关系、作者快照和附件元数据/Discord URL；不新增附件二进制存储，不删除订单、资金、事件、审计或 transcript 事实。Discord 已永久删除且 API 不再返回的历史内容无法补回。
- RED：`npx vitest run tests/m9-us-19-terminal-channel-cleanup.spec.ts` 因 `order-channel-cleanup` 模块不存在而 1 suite failed / 0 tests。
- GREEN：初始实现核心与 PostgreSQL 4 files / 10 tests；本次一小时上限及旧任务提前回归为核心/PostgreSQL 2 files / 8 tests，合同、配置与关联回归合计 5 files / 24 tests 全通过。覆盖 101 条跨页回填、回填失败零删除、非终态拒绝、冻结→回填→语音→文字顺序、Discord 404、版本化任务、扫描去重、策略缩短时提前尚未执行的 Pending Job、面板失败阻断、append-only/幂等 transcript、真实取消与完单事务 Outbox。
- 工程门禁：`npm run typecheck`、`npm run build`、`npm run db:validate`、`npm run quality:routes`（157 operations）、新文件 Prettier 与 `git diff --check` 通过。`npm run lint:api-dashboard` 未执行成功，因为当前安装依赖中没有 `eslint` 可执行文件；没有把该环境缺失描述为通过。
- 实际修改：`apps/api/src/order-channel-cleanup.ts`、`worker.ts`、`worker-delivery.ts`、`orders.ts`、`service-lifecycle.ts`、`admin-order-actions.ts`；Bot/Dashboard 配置标签；主规格、backlog、交互、验收和业务配置镜像；M9-US-19 单元/PostgreSQL 测试及取消/完单关联回归。
- 真实 Guild 清理（2026-08-08）：先确认旧 Worker 于 21:28 启动、早于 23:23 的清理实现提交，因此从未加载僵尸扫描。按新代码重启后启动扫描补建或提前 14 条到期 `CHANNEL_ARCHIVE`，14/14 全部一次成功；对 14 个超过一小时的终态订单逐一调用 Discord GET，相关 26 个文字/选秀/服务频道均返回 404。数据库保留订单、频道 ID、transcript 与审计事实，不因 Discord 删除硬改历史。另有 2 个终态未满一小时订单保持 PENDING，到达一小时后由直接任务或每分钟扫描处理。
- 剩余风险：真实 Guild 已覆盖 Worker 重启、文字与语音删除、Discord 404 幂等和双语音字段订单；尚未构造单频道 100 条以上消息的真实分页回填和最终人工签署，Story 保持 `IN_PROGRESS`。
