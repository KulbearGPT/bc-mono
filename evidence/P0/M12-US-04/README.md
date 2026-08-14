# M12-US-04 完单后客服体验评分

- 状态：本地候选完成；前置 AT-SUP-011 和真实 Discord Guild/Railway AT-SUP-012 未执行，Story 保持 IN_PROGRESS。
- RED：`npx vitest run tests/m12-us-04-rating.spec.ts tests/m12-us-04-bot.spec.ts` 因评分模块、Discord 构建器和路由缺失而失败（2 files，4 failures）。
- GREEN：API、Bot、Worker 面板、真实 PostgreSQL 并发及只追加门禁通过。

## 实现摘要

- 已完成订单只有在存在真实客服首响、仍处于完成后 24 小时内且尚未评价时，Worker 才在订单面板显示“评价客服”。
- 客户可提交 1–5 分；1–2 分必须选择五个受控原因之一，`OTHER` 必须补充不超过 500 字的文字。
- API 使用可信 Guild 与 Discord 客户身份校验订单归属，并从首响消息事件归属实际回复客服；不以客服评价时是否仍 ACTIVE 为条件。
- 数据库唯一约束保证一单一次，`000033_m12_support_rating_immutability` 禁止修改或删除评分事实。
- 评分成功在自身事务内追加幂等 `PANEL_SYNC`，让评价入口消失；该端点不进入订单完成、预留捕获、消费或逐陪玩收益事务。
- Dashboard 复用最近 30 天客服汇总，展示评分数与平均分，不显示 transcript 正文或客户敏感信息。

## 验证

- M12 与关联多人订单/Worker 聚焦回归：13 files / 42 tests passed。
- 全仓 `npm test`：198 files / 965 tests passed（包含 TypeScript build）。
- 真实 PostgreSQL 测试覆盖两次并发评分仅一条成功、面板资格收敛、订单保持 `COMPLETED`，以及评分 UPDATE/DELETE 被拒绝。
- `npm run typecheck` 通过。
- `npm run db:validate` 通过。
- `npm run build -w @blackcat/dashboard` 通过。
- PostgreSQL 测试从 `000001` 至 `000032` 应用完整空库迁移链。

## 剩余风险

- 需在测试 Guild 用真实客户完成一笔包含多名陪玩的订单，验证首响后评分按钮、五档评分、低分原因、OTHER Modal、重复/过期拒绝与面板刷新。
- 需在 Railway 保存评分前后的订单、FundReservation、Consumption、逐参与人 PlayerEarning、Outbox、AuditLog 和客服汇总证据。
- 因 M12-US-03 的真实 Guild 首响验收仍未完成，本 Story 不能标记 DONE 或发布完成。
