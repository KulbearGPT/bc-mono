# Readiness 运行时事实完整性证据

## 范围与结论

- Story：`codex/api-review-readiness-runtime`
- 验收：`AT-PL-005;AT-RDY-001;AT-RDY-002;AT-RDY-003;AT-RDY-004;AT-RDY-005;AT-MULTI-003;AT-STATE-001`
- API 现只接受订单中当前 `ACTIVE` 陪玩本人提交 readiness；客户没有 readiness 写动作，零有效参与者订单不能开始服务。
- `ACCEPTED -> IN_SERVICE` 由最后一名当前有效陪玩确认原子触发；`customer_ready_at` 不再被伪造为客户确认事实。
- 完成结算必须存在有效参与者且全部已就绪；收益只按 `order_participants` 逐人生成，不再回退到旧订单级陪玩字段。
- 未修改 Bot 或 Dashboard 源码，也未改变现行公开请求/响应结构。

## RED

- 新增 `tests/api-review-readiness-runtime.spec.ts` 后为 1 file / 3 failed。
- 失败分别证明：全体陪玩就绪会伪造 `customerReadyAt`；无参与者旧订单可由订单级陪玩身份直接开始；无参与者订单可完成并捕获资金、生成订单级收益。

## GREEN

- 内存与 PostgreSQL 生命周期实现统一要求真实活动参与者，移除订单级 readiness 和收益 fallback。
- readiness 超时与公开投影只依据 `participants[].readyAt`；空集合不再被视为全员已就绪。
- 追加迁移 `000042_player_only_readiness_guard`：数据库状态守卫在非 override 的服务开始迁移中要求至少一个活动参与者且不存在未就绪参与者，旧聚合时间戳不能绕过。
- PostgreSQL 集成测试验证：最后一名陪玩可在 `customer_ready_at IS NULL` 时正常开始；即使伪造两个旧聚合时间戳，只要仍有活动参与者未就绪，直接状态更新仍被数据库拒绝。
- 旧 M2 生命周期测试改用真实参与者事实，旧行为不再作为兼容路径保留。

## 验证

- RED：`tests/api-review-readiness-runtime.spec.ts` 为 3/3 failed。
- 聚焦 readiness/M2/M10/M19 回归：9 files / 55 tests 全通过。
- 真实 PostgreSQL：`tests/m10-us-04-postgres.spec.ts` 为 3/3 tests 全通过。
- 全仓：280 files / 1403 tests 全通过。
- 生产路由与 OpenAPI：179 operations 精确一致。
- API ESLint 零告警、API typecheck、根 build、Prisma validate 全通过。
- 全量迁移校验通过：`migration-apply-ok`，最终 `table_count=87`。
- 两份 OpenAPI 镜像一致，`git diff --check` 通过。

## 剩余兼容边界

- `orders.customer_ready_at`、`orders.player_ready_at` 及旧客户 readiness 事件枚举暂保留为历史数据兼容字段；当前 API 不把它们当作客户可写事实或服务开始授权依据。
- 后续若确认不再需要读取历史数据，可另建迁移移除旧列和旧事件枚举；本 Story 不做破坏性历史数据清理。
