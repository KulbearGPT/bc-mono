# M2-US-09 Evidence: 双向准备与超时转客服

## Scope

- Story：M2-US-09 双向准备与超时转客服
- 验收用例：AT-RDY-001、AT-RDY-002，并回归 AT-RDY-003、AT-RDY-004、AT-RDY-005
- 前置依赖：M2-US-03、M0-US-05

## Implemented

- 接单事务除 `PANEL_SYNC` 外追加 `READINESS_TIMEOUT` Outbox Job，执行时间与订单十分钟 `readinessDueAt` 一致。
- `expireOrderReadiness` 在到期前拒绝执行；到期后保持订单 `ACCEPTED`，追加唯一 `READINESS_TIMED_OUT` 事件并创建唯一 `ORDER_ASSIST / READINESS_TIMEOUT` 客服任务。
- Job 重放返回同一客服任务，不重复事件、不启动服务、不捕获或释放订单预留，也不生成消费和陪玩收益。
- 订单已进入其他状态时 Worker 安全跳过，避免并发下错误重试。
- PostgreSQL 事务使用订单锁和唯一客服任务 public ID；真实数据库测试确认预留保持 `ACTIVE`。
- 实现 `GET /api/v1/me/staff-tasks`，按当前绑定客户隔离并只返回脱敏进度，不返回内部备注、证据、认领人或第三方账户字段。
- 旧 `POST /orders/:id/start` 仍固定拒绝；双方第二个 READY 原子进入 `IN_SERVICE` 的既有回归继续通过。

## Verification

- RED：接单只有面板同步任务；Outbox 不识别 `READINESS_TIMEOUT`；领域函数和本人客服任务查询不存在。
- GREEN：`npm test -- --run tests/m2-us-09-api.spec.ts tests/m2-us-04-db.spec.ts`，2 files / 11 tests passed。
- 关联回归：M2-US-03/M2-US-04 API 与 PostgreSQL 状态机测试通过。
- `npm run typecheck`：exit 0。
- `npm test`：46 files / 255 tests passed。
- `git diff --check`：exit 0。

## Residual Risk

- Discord credential 暂未提供，测试 Guild 中双方就绪消息同步和超时后的用户/陪玩提示 E2E 未执行。
- 订单级 automation pause/resume 持久状态及所有 Worker 的暂停闸门属于 M2-US-11。
