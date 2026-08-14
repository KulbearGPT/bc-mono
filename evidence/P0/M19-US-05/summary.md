# M19-US-05 全业务回归、时效监控与真实 Guild UAT

- 状态：IN_PROGRESS（自动化候选已完成，外部 UAT 未执行）
- 验收：`AT-STATE-001`、`AT-STATE-002`、`AT-STATE-003`、`AT-STATE-004`、`AT-STATE-005`

## 自动化改进

- Outbox Worker 对订单面板、招募卡、派单、礼物播报、频道、Role、周报通知和客服提醒记录 `outbox_projection_convergence_seconds`，标注具体消费者与 `MET/MISSED` 五秒目标。
- 投影超过 30 秒或耗尽重试时输出 `outbox.projection_alert`，包含脱敏的 job、聚合类型/对象、目标消费者、尝试次数、收敛毫秒与 `request_id`，不包含 payload 中的用户自由文本。
- 运营失败任务目录补齐 `SELECTION_POOL_SYNC`、客服首响提醒/超时、周报与其他现行 Job；L2 可恢复与客户/客服体验直接相关的投影，L3 扩展到运营 Job，Role 对账仍仅 L4 可见。

## 全业务审计范围

| 业务节点 | 权威写入 | 已核对消费者 |
|---|---|---|
| 草稿、估价、提交 | 订单/预留事务 | 客户面板、客服订单查询 |
| 招募、Reaction 报名/撤回、终止、试音确认 | 候选池/参与人事务 | 公开卡、客户名单、陪玩视图、客服协同 |
| 逐陪玩就绪、开始、申请完成、确认完成 | 订单生命周期/资金事务 | 客户面板、陪玩、客服卡、客服工作台、时间线 |
| 取消、异常、重派、退款/Adjustment | 订单解决/内部钱包事务 | 客户面板、客服任务、订单/资金时间线 |
| 礼物创建、核验、批准/拒绝/过期 | 礼物/预留事务 | 客户私密反馈、客服队列、播报投影、资金查询 |
| 客服任务创建、认领、首响、升级、结案 | StaffTask 事务 | 客服队列、选中订单、运营指标、提醒/告警 |
| 陪玩审批/资格、Bot 配置、目录 | 各领域统一 API | 陪玩工作台、Discord Role/入口、Dashboard 重取 |

## 验证

- RED：新增可观测性测试 1 file / 3 failed；随后失败任务可见性补充 RED 1 failed / 3 passed。
- GREEN：收敛、最大重试、员工恢复工具与旧权限合同 5 files / 44 tests passed；API typecheck 与 `git diff --check` 通过。
- M19 与发布追踪：6 files / 85 tests passed；302 行验收矩阵可重现生成。
- 全仓：`npm test` → 247 files / 1236 tests passed（含 TypeScript build）；全仓 typecheck、Bot lint 与 `git diff --check` 通过。API/Dashboard lint 在上一 Story 为 0 errors / 38 条历史 warning（上限 39），本 Story 相同规则回归通过。

## 未完成的外部门禁

本轮未获得对真实 Guild 业务写入、多账号操作和故障注入的单独授权，因此没有创建订单、改变资金、删除消息或重启线上 Worker。`AT-STATE-003/004/005` 仍需具名客户、陪玩、L1–L4 客服在桌面/手机完成收敛时序、重启、消息丢失与告警 UAT；Story 保持未完成。
