# M3-US-07 Evidence: 保密的两种一级返佣计划

## Scope

- Story：M3-US-07 保密的两种一级返佣计划
- 验收用例：AT-RFP-001 至 AT-RFP-008，关联 AT-REF-001 至 AT-REF-005
- 前置依赖：M3-US-04、M3-US-05

## Implemented

- 新增可供 Dashboard 与 Discord Bot 复用的归因管理 API 与 PostgreSQL store。
- L2 只能读取 Staff-redacted 列表，不含被推荐客户、受益人、计划、比例、金额或状态；L3+ 近期 step-up 后才能创建、查看完整详情或改绑。
- 创建拒绝自荐、已有消费后的迟绑定、同一客户第二个活动归因，以及 PLAYER_LIFETIME 指向非活动陪玩的受益人。
- `PROMOTER_FIRST_PURCHASE` 与 `PLAYER_LIFETIME` 对同一客户互斥；经济参数只读取活动服务端计划，客户端提交比例或金额字段返回 400。
- 改绑先将旧记录标记 SUPERSEDED、清除活动键，再追加带 `replacesAttributionId` 的新记录；历史不覆盖、不删除。
- 订单完成和礼物捕获共用 `createEligibleReferralCommission`，消费来源唯一并保存计划版本、比例/固定金额和 base 快照。
- 推广者首购返佣命中后原子转为 FULFILLED，后续消费不再返；陪玩长期计划继续处理符合配置的订单和礼物。
- 返佣金额只做整数运算并向下取整，`12345 * 500bps = 617` minor units。
- 退款继续通过只追加 CommissionAdjustment 冲正，主返佣金额和归因快照不变；本人视图继续按 beneficiary 隔离并脱敏来源。
- 通用安全写管道将 fingerprint payload 校验纳入路由错误映射，非法请求稳定返回合同错误而非 500。

## Verification

- RED：归因管理模块不存在；首购归因生成后保持 ACTIVE；礼物消费不生成长期返佣；写路由 fingerprint 校验异常漏成 500。
- GREEN：M3-US-07 API/PostgreSQL 2 files / 8 tests passed；跨订单、礼物、退款和本人视图关联回归 11 files / 59 tests passed。
- `pnpm typecheck`：exit 0。
- `pnpm test`：71 files / 331 tests passed。
- `pnpm db:validate`：Prisma schema valid。
- `pnpm db:verify:migration`：migration-apply-ok；table_count=47；constraint_count=3；trigger_count=7。
- `git diff --check`：exit 0。

## Residual Risk

- “共享账号互荐”由 Discord 与第三方账户唯一绑定约束阻断；更复杂的设备/IP 关联识别属于后续风控，不在 P0 自动封禁范围。
- Discord credential 与真实支付 Provider 沙箱尚未提供，真实 Guild 的归因管理入口和私密返佣通知 E2E 尚未执行。
- P0 明确不含多级返佣、用户自助改绑、自动发放、代理层级或公开返佣去向。
