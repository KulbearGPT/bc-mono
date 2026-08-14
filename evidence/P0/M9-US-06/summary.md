# M9-US-06 Dashboard 充值与陪玩审核证据

Dashboard 已提供固定 USD 收款证据表单、CAT 结果展示和待审陪玩批准/拒绝操作；API 保持权限、step-up、幂等和审计边界。

`tests/m9-us-06-dashboard.spec.ts` 及相关 wallet/player API 回归为自动化证据。真实 Dashboard/Discord 联动 UAT 仍待签署。

## 陪玩审批首次标签修复（2026-08-02）

- 失败请求 `req_591b7a32-f248-49e4-b784-23c7280c264e` 定位为首次创建 `skill_tags` 时原生 SQL 漏写 UUID，PostgreSQL 返回 `23502`；旧审批又未包裹事务，导致目标陪玩先变为 `ACTIVE`、后续标签写入失败。
- RED：新增 PostgreSQL 集成用例稳定复现 `skill_tags.id` 非空约束失败。
- GREEN：首次标签显式生成 UUID；使用 Pool 的陪玩批准在一个数据库事务内完成状态、技能标签、审核事件和 Discord 产品 Role 任务，后续任何一步失败都会完整回滚。
- 生产测试数据采用最小只追加修复：为受影响陪玩补建并关联 `VALORANT` / `RANKED`，保留既有审核事件和 Role 任务，不回退或删除事实；复核结果为 `ACTIVE`、两个标签已关联。
- 聚焦回归 `tests/m2-us-01-db.spec.ts`、`tests/m2-us-01-api.spec.ts`、`tests/m9-us-06-dashboard.spec.ts` 通过；完整低并发回归在修复后通过。
