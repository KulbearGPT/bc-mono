# M3-US-06 Evidence: 礼物资金预留完整生命周期

## Scope

- Story：M3-US-06 礼物资金预留完整生命周期
- 验收用例：AT-RES-008、AT-RES-009，并补齐 AT-RES-010、AT-RES-011 的生命周期边界
- 前置依赖：M1-US-08、M3-US-01、M3-US-02、M3-US-03

## Implemented

- 保持创建礼物、唯一 FundReservation、客服任务在同一事务；批准仍捕获原 reservation，不重新创建或重算金额。
- 新增统一 `terminateGiftRequest`，支持客服拒绝 `REJECTED`、用户撤回 `WITHDRAWN` 和系统到期 `EXPIRED`。
- 用户撤回按认证 Discord 绑定派生 sender；他人无法撤回，已捕获礼物只能进入售后退款流程。
- Provider 原生 hold 使用稳定 release 幂等键；local fallback 通过追加 reservation event 推进终态。
- PostgreSQL reservation event 触发器是唯一状态迁移来源，避免重复版本更新；重复释放返回相同终态。
- 创建事务同时写入 `GIFT_EXPIRY` Outbox；Worker 到期执行相同领域动作，对已捕获或已结束礼物安全跳过。
- 余额不足 `422` 返回 `availableMinor`、`shortfallMinor` 和 `OPEN_RECHARGE`；Bot 继续按 API affordability 禁用过贵礼物并展示充值入口。
- 通用安全错误管道保留结构化 details，Dashboard 与 Discord Bot 可复用同一响应。

## Verification

- RED：客服拒绝后 reservation 仍 ACTIVE；撤回路由和到期函数不存在；原生 hold 因创建时绑定草稿版本而无法释放；数据库重复推进 reservation 版本。
- GREEN：礼物、Outbox、API、Bot 和 PostgreSQL 关联回归 8 files / 37 tests passed。
- `pnpm typecheck`：exit 0。
- `pnpm test`：69 files / 323 tests passed。
- `pnpm db:validate`：Prisma schema valid。
- `pnpm db:verify:migration`：migration-apply-ok；table_count=47；constraint_count=3；trigger_count=7。
- `git diff --check`：exit 0。

## Residual Risk

- Discord credential 与真实支付 Provider 沙箱尚未提供，真实 Guild 的按钮状态和 Provider native hold E2E 尚未执行。
- 正式 Worker 进程部署、监控和告警随基础设施上线完成；领域 handler 与 Outbox 记录已具备。
- 捕获后的退款继续使用既有客服退款与 Adjustment 流程，不允许通过撤回接口回退。
