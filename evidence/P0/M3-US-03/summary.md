# M3-US-03 验收证据

## 已完成

- `approveGiftRequest` 在授权成功后调用可复用礼物捕获服务；Discord Bot 与 Dashboard 不持有独立支付逻辑。
- 只捕获礼物创建时的既有 FundReservation；Provider native hold 使用 `captureHold`，fallback 使用 `createReservationDebit`，两者共用稳定幂等键 `debit:gift:{giftRequestId}:v1`。
- Provider 成功后，PostgreSQL 原子写入 CAPTURED 预留事件、GIFT_CHARGE ExternalTransaction、唯一 ConsumptionEntry、Gift CAPTURED 状态和 GIFT_ANNOUNCEMENT Outbox。
- 数据库唯一约束、Provider 幂等键和读取既有捕获结果共同保证重复执行最多扣款一次、消费一条、播报任务一条。
- Provider 失败时不写捕获事实；礼物维持 APPROVED、预留维持 ACTIVE，可由同一幂等业务请求安全恢复。
- Outbox handler 只负责 Discord 消息发送；消息失败不退款、不重扣，成功后记录频道、消息 ID 和 ANNOUNCED 状态。
- Webhook 归并按退款事实派生扣款聚合状态；REFUND_UPDATED 先到时，迟到的 DEBIT_UPDATED 不会把 REFUNDED/PARTIALLY_REFUNDED 降回 SUCCEEDED，调整记录按退款引用幂等。
- 审批快照改用 canonical JSON 哈希，避免 PostgreSQL `jsonb` 键排序造成同内容误判为被篡改。

## 验证结果

- Story 相关：`pnpm vitest run tests/m1-us-05-webhook.spec.ts tests/m3-us-02-api.spec.ts tests/m3-us-02-db.spec.ts tests/m3-us-03-api.spec.ts tests/m3-us-03-webhook.spec.ts tests/m3-us-03-worker.spec.ts`，6 files / 16 tests passed。
- 全量：`pnpm test`，63 files / 304 tests passed。
- `pnpm typecheck`、`pnpm db:validate`、`pnpm db:verify:migration` passed。
- OpenAPI 的成功示例与实际 `CAPTURED` 响应一致；docs/outputs 镜像同步。

## 验收映射

- AT-GFT-006：500000 边界由 L4 + recent step-up 执行，并捕获原预留一次。
- AT-GFT-007：允许同一达到等级的 L4 发起并执行，原因、审批事实、交易和审计链保留。
- AT-WHK-002：退款回调先到、扣款回调后到时保持退款聚合状态，不发生状态降级或重复调整。

## 环境边界

- 真实第三方支付账户与 Discord Guild 播报 E2E 仍需部署环境凭据；本 Story 使用合同级 MockFundingAdapter、真实 PostgreSQL migration 和 Outbox worker 验证业务边界。
