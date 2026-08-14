# API 全量审查：审批运行时闭环

日期：2026-08-13

## 审查结论

此前 OpenAPI 已声明审批查询、批准和拒绝接口，但 API 未注册运行时；礼物、退款和订单结案生成的审批也没有统一的可信执行闭环。另有三个关联问题：API 路由门禁只检查“源码是否有合同”，没有反向发现“合同是否无运行时”；高等级人员通过兼容业务入口直接执行后会留下失效的待审批事实；审计详情合同存在但运行时缺失，列表/详情投影也未返回合同要求的完整审计字段。

本候选在不修改 Bot 或 Dashboard 源码的前提下完成以下修复：

- 注册 `GET /api/v1/admin/approval-requests`、详情、批准和拒绝四个统一业务 API；只处理服务端业务流程生成的 `GIFT_APPROVE`、`REFUND_EXECUTE`、`ORDER_RESOLVE`，无通用创建入口，其他动作失败关闭。
- 查询与决定均从可信 Actor Context 获取 Guild、员工身份、有效等级与权限；Dashboard 与 Discord Bot 两条身份解析路径均有回归。L3/L4 决定继续要求 MFA 后的近期 step-up，L2 低风险决定不被错误要求高等级 step-up。
- 查询按 Guild 隔离，公开模型不返回 `guildId`、`payloadSnapshot`、`payloadHash` 等内部执行材料；分页改为签名且绑定 Guild、有效等级和状态筛选的 keyset cursor，篡改或跨筛选复用返回 400。
- 批准时验证审批状态、审批版本、有效期、所需等级、动作执行权限、目标版本、不可变 payload hash 和 Guild；礼物还按目标 Guild 读取 `gift_broadcast_channel_id`，不再错误使用全局默认频道。
- PostgreSQL 将 ApprovalRequest 状态、ApprovalDecision、礼物捕获或释放、退款/订单结案事实、钱包/消费/Adjustment/Outbox 与成功审计放入同一事务。成功审计插入失败时全部回滚。
- 礼物拒绝会在同一事务拒绝审批与礼物并释放 FundReservation；客户撤回、过期或兼容入口直接终止会把关联待审批明确转为 `CANCELLED` 或 `EXPIRED`。高等级员工通过兼容退款/结案入口直接执行时，旧快照转为 `CANCELLED`，不会伪装为批准未变更快照，也不再长期悬挂。
- 新增审计详情 API；审计列表和详情补齐 `idempotencyKey`、`jobId`、`triggerSource`、`retryAttempt` 与有序 `changes`，保持服务端 scope 裁剪且不暴露 `actorStaffId`。
- 路由合同门禁升级为双向精确比对，当前 179 个生产 operation 与 OpenAPI 一一对应。

## 验收与风险边界

- 关联验收：`AT-GFT-006`、`AT-GFT-009`、`AT-RBAC-001`、`AT-RBAC-006`、`AT-AUD-001`、`AT-AUD-004`、`AT-REF-005`、`AT-CAN-009`。
- 保持兼容：未修改 Bot/Dashboard 源码；既有礼物、退款和订单结案业务 URL、请求体及成功响应保持可用。
- 不在本 Story 扩展 P1 动作；`ACCESS_CHANGE` 继续走专用访问控制审批，其他枚举值不由通用执行器处理。

## 变更文件

- `apps/api/src/approvals.ts`
- `apps/api/src/admin-order-actions.ts`
- `apps/api/src/gifts.ts`
- `apps/api/src/operations.ts`
- `apps/api/src/authorization-policy.ts`
- `apps/api/src/signed-cursor.ts`
- `apps/api/src/server.ts`
- `apps/api/src/index.ts`
- `apps/api/package.json`
- `scripts/check-api-route-contracts.mjs`
- `outputs/P0开发交付包/02-API/openapi.yaml`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `tests/api-review-approval-runtime.spec.ts`
- `tests/api-review-route-parity.spec.ts`
- `tests/api-review-refund-integrity-db.spec.ts`
- `tests/m3-us-02-db.spec.ts`
- `tests/m3-us-06-api.spec.ts`
- `tests/m4-us-04-api.spec.ts`
- `tests/m4-us-06-api.spec.ts`
- `tests/m4-us-06-db.spec.ts`

## 可复核证据

- 未通过基线：双向路由门禁首次运行发现合同中的审计详情没有生产路由；审批四个合同 operation 同样没有已注册运行时。
- `npm run typecheck --workspace=@blackcat/api`：通过。
- 审批/礼物/退款/订单/审计聚焦回归：11 files / 63 tests，通过。
- `npm run quality:routes`：`179 production operations exactly match OpenAPI`。
- `npm run build`：通过。
- `npx eslint apps/api/src --max-warnings 28`：0 errors；27 个均为本仓既有 warning，新增审批模块零 warning。
- `git diff --check`：通过。

## 剩余外部风险

真实员工 Dashboard MFA/step-up 与真实 Discord Guild 的审批操作仍属于外部 UAT；自动化和临时 PostgreSQL 证据不能替代具名人员、真实频道权限和真实交互环境复验。本候选未把该外部状态描述为已完成。
