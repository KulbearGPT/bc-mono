# M12-US-03 订单频道首响、超时与自动认领

- 状态：本地候选完成；真实 Discord Guild AT-SUP-011 未执行，Story 保持 IN_PROGRESS。
- RED：`npx vitest run tests/m12-us-03-worker.spec.ts` 因 support response Job 模块缺失而失败。
- GREEN：Worker、真实 PostgreSQL 并发、Dashboard 投影和 M9 transcript 关联回归通过。
- 迁移：000031 为新订单级 StaffTask 原子设置固定 4 分钟提醒、5 分钟截止并追加两条幂等 Outbox Job。

## 实现摘要

- 仅 `CREATED`、非 Bot、含非空正文或附件的订单频道事件可成为首响。
- API 从可信 Guild + Discord 绑定解析 ACTIVE 内部员工，L1–L4 均可触发，不要求打卡。
- 每个订单使用 PostgreSQL advisory transaction lock；无负责人时只认领最早 OPEN 订单级任务，已有 CLAIMED/PENDING_APPROVAL 时不覆盖。
- 同一真实回复可结束该订单全部仍待首响任务的计时；自动认领另写 `AUTO_CLAIM_STAFF_TASK` 审计和 `DISCORD_FIRST_RESPONSE` 来源。
- 5 分钟超时与迟到首响均保留在 30 天汇总中，只记录事实、不产生积分、处罚、停岗或申诉。
- Dashboard 只在重新加载任务事实后显示等待、超时或已首响，不承诺 WebSocket 实时推送。

## 验证

- M12 Worker/PostgreSQL：2 files / 5 tests passed。
- M9 transcript + M12：3 files / 9 tests passed。
- Worker runtime/M6 关联：3 files / 18 tests passed。
- 最终 M12/M9/Worker 聚焦回归：9 files / 33 tests passed。
- `npm run typecheck`、`npm run db:validate`、Dashboard production build 通过。
- `npm run db:verify:migration` 从 000001 至 000031 全链 `migration-apply-ok`，table_count=87。

## 剩余风险

- 必须在测试 Guild 用 L1、L4、Bot、空消息、附件、编辑、并发回复和已有负责人场景执行 AT-SUP-011，保存消息时间戳、request_id、任务快照和审计证据。

## 2026-08-07 客户排队提醒终态收敛

- RED：4 分钟提醒一旦发送，只支持按 nonce 幂等跳过重复发送；客服真实首响仅把任务改为 `MET`，没有消息对账 Job，也没有“仅更新原消息”的 Discord 能力。因此旧消息持续显示“正在等待处理”。RED 为 3 files / 3 failed / 13 passed。
- 修复：首次响应事务在同一并发锁和提交边界内，为每个实际从 `PENDING/OVERDUE` 进入 `MET` 的任务追加即时 `SUPPORT_RESPONSE_REMINDER` 对账 Job；Worker 从最新任务事实区分 `WAITING/RESPONDED`。RESPONDED 使用原 `support-response-reminder:<taskId>` nonce 只查找并 PATCH 为“客服已响应，排队提醒已结束”，原提醒不存在时不补发新消息。
- 验证：目标 Worker、Discord delivery 与 PostgreSQL 并发 `3 files / 16 tests passed`；M12 首响/评分及 Worker 关联回归 `8 files / 35 tests passed`；`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。
- 外部门禁：超过既定消息对账边界的可靠性按本轮要求暂不扩展；仍需真实 Guild 验证 4 分钟后首响、5 分钟后迟到首响，以及 4 分钟前首响不额外发消息。Story 保持 IN_PROGRESS。

## 2026-08-07 就绪超时客服提醒文案

- RED：`READINESS_TIMEOUT` 与普通客服任务共用“你的请求已进入客服队列”文案，客户无法得知这是匹配成功后双方未按时确认开始所触发的自动介入。`tests/m12-us-03-worker.spec.ts` 新场景为 1 failed / 4 passed。
- 修复：提醒投影读取任务 `reason_code`、就绪快照及订单 `accepted_at`，使用 `accepted_at → readinessDueAt` 计算本单配置的就绪期限。就绪超时分别说明“您”“陪玩”或“您和陪玩”尚未确认开始，并明确系统已自动请求客服介入；客服首响后原提醒更新为正在处理订单未按时确认开始。其他任务继续使用原通用文案。
- 验证：Worker 与真实 PostgreSQL 目标回归 2 files / 7 tests；M2 就绪生命周期、M12 首响及 Bot readiness 关联回归 10 files / 27 tests；全仓类型检查与 `git diff --check` 通过。关联验收：`AT-SUP-011`、`AT-RDY-004`。
- 外部门禁：仍需在真实 Guild 验证三种未就绪方文案及客服首响后的原消息更新；Story 保持 IN_PROGRESS。
